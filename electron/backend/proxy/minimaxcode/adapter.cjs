/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MiniMax Code（国内站）渠道适配器
//
// 本家与既有渠道的三处不同：
//   1. 登录是 OAuth 设备码 + PKCE（client_id=mcode-public），账号类接口（余额/签到）另需
//      yy + x-signature 双签名（常量取自客户端 bundle，公开非机密）；
//   2. 对话上游是 **Anthropic Messages 协议**（/mavis/api/v1/llm/v1/messages），只需 Bearer，
//      与 ZCode 同方言，故请求翻译与 SSE 桥直接复用 zcodeAnthropic.cjs；
//   3. refresh token **一次性**（重复使用 invalid_grant），续期只允许发生一次、失败不重试，
//      预刷新窗口收窄到 10 分钟（默认 24h 会让每轮余额刷新都变成一次续期）。
//
// 401 的「刷新一次 + 重试一次」由通用层做（server.cjs 的 attemptChat、credits.refreshAccount），
// 适配器内部**不再自己刷新**，否则会把一次性 refresh token 花两次。
"use strict";

const crypto = require("node:crypto");
const zcodeAnthropic = require("../zcodeAnthropic.cjs");
const modelsMod = require("./models.cjs");
const oauth = require("./oauth.cjs");

// 已花掉的 refresh token 摘要（进程内，上限 50）：同一条刷新请求即使绕过通用层互斥，
// 也不会把同一枚一次性 token 再花一次——花第二次等于把这个号和官方客户端一起踢下线。
const spentRefresh = new Set();
const SPENT_MAX = 50;

function digestOf(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function rememberSpent(refreshToken) {
  const key = digestOf(refreshToken);
  spentRefresh.add(key);
  if (spentRefresh.size > SPENT_MAX) spentRefresh.delete(spentRefresh.values().next().value);
  return key;
}

function makeMinimaxCode(deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs, store } = deps;
  const channel = "minimaxcode";
  const cfg = () => (rules.get("headers.json") || {}).minimaxcode || {};
  const identityMod = require("./identity.cjs");
  const creditsMod = require("./credits.cjs");
  const checkinMod = require("./checkin.cjs");

  /** 账号 meta 的事实源：`store.accountSecrets()` 返回的 `secrets.meta` 是**已解析的对象**，
   *  而 `credits.refreshAccount()` 传进来的是数据库原始行（`account.meta` 是 JSON 字符串）。
   *  统一以 secrets.meta 为准，避免把字符串当对象展开（会把整份 meta 写成索引键）。 */
  function metaOf(account, secrets) {
    if (secrets && secrets.meta && typeof secrets.meta === "object" && !Array.isArray(secrets.meta)) return secrets.meta;
    const m = account && account.meta;
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  }

  /** 写回 meta：**读-改-写**（以库里最新一份为底），与 store.noteCheckin / setCreditsDetail 同口径。
   *  整份覆盖会抹掉别的链路在这期间写入的键（签到记录、最近错误），表现为「偶发消失」。 */
  function saveMeta(account, secrets, patch) {
    let base = metaOf(account, secrets);
    try {
      if (account && account.id) {
        const row = store.getAccount(account.id);
        const raw = row && row.meta;
        const latest = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
        if (latest && typeof latest === "object" && !Array.isArray(latest)) base = latest;
      }
    } catch { /* 读不到就用内存快照 */ }
    const next = { ...base, ...patch };
    try {
      if (account && account.id) store.updateAccount(account.id, { meta: next });
    } catch { /* 写回失败不影响本次结果 */ }
    if (secrets) secrets.meta = next;
    if (account && account.meta && typeof account.meta === "object") account.meta = next;
    return next;
  }

  /** 设备指纹：meta 已固化就沿用（secrets.meta 优先），否则按 uid 稳定派生 */
  function identityOf(account, secrets) {
    const meta = metaOf(account, secrets);
    const seed = String((account && (account.uid || account.id)) || "minimaxcode");
    return identityMod.deviceIdentity({ id: seed, uid: account && account.uid, meta });
  }

  /** realUserID 不在令牌里：meta 命中直接用，缺失才问上游并写回（同轮不再重复请求）。
   *  取不到返回空串，调用方据此只把该项（余额/签到）标为不可用，不判死账号。 */
  async function userIdOf(account, secrets, c) {
    const cached = String(metaOf(account, secrets).realUserID || "").trim();
    if (cached) return cached;
    const { deviceId, uuid } = identityOf(account, secrets);
    const r = await identityMod.fetchUserInfo({ token: String((secrets && secrets.token) || ""), cfg: c, deviceId, uuid, httpJson });
    if (!r.ok) return "";
    saveMeta(account, secrets, { realUserID: r.realUserID, ...(r.name ? { userName: r.name } : {}) });
    return r.realUserID;
  }

  return {
    id: channel,
    cfg,

    // 模型清单：只认已拉取的目录（未拉取过为空，不编模型名）
    models() {
      return modelsMod.list(rules.rulesDir(), channel);
    },

    // 目录条目（含能力 / 上下文元数据），供模型管理与展示
    modelEntries() {
      return modelsMod.entries(rules.rulesDir(), channel);
    },

    /** 拉取官方目录：GET /mavis/api/v1/models?region=cn&buildEnv=prod（Bearer 即可） */
    async fetchModels(account, secrets, opts) {
      const c = cfg();
      const token = String((secrets && secrets.token) || "");
      if (!token) return { ok: false, message: "该账号没有凭据" };
      const r = await modelsMod.refresh({ token, cfg: c, httpJson }, rules.rulesDir(), channel, !!(opts && opts.force));
      if (!r || r.ok === false) return { ok: false, message: (r && r.message) || "模型目录拉取失败" };
      return { ok: true, models: modelsMod.entries(rules.rulesDir(), channel) };
    },

    // 上游模型名大小写敏感，逐字透传（校验在 chat 入口做，写法不对直接 400）
    mapModel(model) {
      return String(model || "");
    },

    /** 对话主流程：OpenAI body → Anthropic body → 上游 SSE → 适配器统一事件。
     *  非 2xx 原样抛出（带 status），由 server.cjs 的 attemptChat 统一做「401 → 刷新一次 → 重试一次」。 */
    async chat({ account, secrets, model, body, emit, meta }) {
      const c = cfg();
      const token = String((secrets && secrets.token) || "");
      if (!token) throw Object.assign(new Error("该账号没有凭据"), { status: 401 });
      const rulesDir = rules.rulesDir();
      const known = modelsMod.list(rulesDir, channel);
      const requested = String(model || "");
      const upstreamModel = known.length ? modelsMod.resolveId(rulesDir, channel, requested) : requested;
      // 目录已拉取时逐字校验：上游对未知模型回 400 unknown model，入口先拦下并给出可用清单
      if (known.length && !upstreamModel) {
        const err = new Error(`MiniMax Code 不支持模型「${requested}」（可用：${known.join(" / ")}）`);
        err.status = 400;
        throw err;
      }
      const entry = modelsMod.entries(rulesDir, channel).find((m) => m.id === upstreamModel);
      const payload = zcodeAnthropic.toAnthropic(upstreamModel, body, { defaultMaxTokens: entry && entry.maxOutputTokens });
      const payloadText = JSON.stringify(payload);
      const base = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
      const url = `${base}${c.messagesPath || "/mavis/api/v1/llm/v1/messages"}`;
      const headers = {
        authorization: `Bearer ${token}`,
        // 官方客户端塞的占位键（上游不校验，与真实流量保持一致）
        "x-api-key": "sk-xxx",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
        "user-agent": c.userAgent || "MiniMaxAgent",
      };
      let produced = false;
      const bridge = zcodeAnthropic.createSseBridge((ev) => {
        if (ev && ev.type === "delta" && util.hasConsumableDelta(ev.delta)) produced = true;
        emit(ev);
      });
      const respPair = await fetchStream(url, { method: "POST", headers, body: payloadText, firstByteMs: firstByteBudgetMs(payloadText) });
      let settled = false;
      try {
        await pumpSse(respPair.resp, (event, raw) => {
          if (!settled) {
            settled = true;
            respPair.cancelTimer();
          }
          bridge.onEvent(event, raw);
        });
      } finally {
        respPair.cancelTimer();
      }
      // 空流/空内容判定（与 zcode 同口径）：上游 200 却没有可用内容，多半是余额耗尽或账号被限，
      // 抛 502 交给通用层按 server 类冷却；上游已明确报错时让位给错误事件自己的分类。
      if (!bridge.result.sawError && (!settled || !produced)) {
        throw Object.assign(new Error("上游返回了空响应（通常为余额耗尽/账号被限）"), { status: 502, emptyStream: true });
      }
      return { status: 200, planLimit: false };
    },

    /** 续期：一次性 refresh token 只在**上游真的消费了它**之后才记录为已花。
     *  网络失败/5xx（上游没收到）不拉黑，否则一次抖动就让账号永久「需重登」。
     *  成功后立即把新到期写回 meta —— 不写会让预刷新窗口每轮都命中，一轮轮花掉一次性令牌。 */
    async refreshToken(account, secrets) {
      const refreshToken = String((secrets && secrets.refreshToken) || "");
      if (!refreshToken) return { ok: false, authError: true, message: "没有续期凭据，请重新登录" };
      if (spentRefresh.has(digestOf(refreshToken))) {
        return { ok: false, authError: true, message: "续期凭据已被使用过（一次性），请重新登录" };
      }
      const r = await oauth.refresh({ refreshToken, cfg: cfg(), httpJson });
      if (!r.ok) {
        // invalid_grant = 上游已作废这一枚：记下来别再试；网络错误保持可用
        if (r.authError) rememberSpent(refreshToken);
        return { ok: false, authError: !!r.authError, message: r.message };
      }
      rememberSpent(refreshToken);
      saveMeta(account, secrets, { accessExpiresAt: r.expiresAt });
      return { ok: true, token: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt };
    },

    /** access token 是 opaque（`mmoat_` 前缀），JWT 解不出 exp，必须由这里回答到期时间，
     *  否则 ensureFreshSecrets 认为「无到期」永不预刷新。 */
    tokenExpiryMs(account, secrets) {
      const meta = metaOf(account, secrets);
      return Number(meta.accessExpiresAt) || 0;
    },

    /** 预刷新窗口收窄到 10 分钟（默认 86400 = 24 小时 > token 有效期 12 小时，会把每轮余额刷新
     *  都变成一次续期，一轮轮花掉一次性 refresh token——小浣熊渠道踩过的同一个坑）。 */
    refreshWindowSec: 600,

    /** 渠道级错误分类：401 = 凭据失效（判 auth，通用层刷新/标 relogin）；
     *  403 = 套餐/模型权限不足或风控（**与凭据无关**，判 model_denied：零动作、不罚号），
     *  只有 403 正文明确写凭据失效时才归 auth；其余交给通用分类器（400 → fatal 不罚号）。 */
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      const body = String((e && e.body) || "");
      const authInBody = /invalid access token|auth failed|invalid_token|unauthorized/i.test(body);
      if (status === 401) return { kind: "auth", switchable: false };
      if (status === 403) return authInBody ? { kind: "auth", switchable: false } : { kind: "model_denied", switchable: false };
      if (authInBody) return { kind: "auth", switchable: false };
      return null;
    },

    async queryCredits(account, secrets) {
      const c = cfg();
      const token = String((secrets && secrets.token) || "");
      if (!token) return { authError: true, message: "该账号没有凭据" };
      const userId = await userIdOf(account, secrets, c);
      if (!userId) return { error: "取不到账号身份（realUserID），暂时无法查询余额" };
      const { deviceId, uuid } = identityOf(account, secrets);
      const r = await creditsMod.query({ token, userId, deviceId, uuid, cfg: c, httpJson });
      if (!r.ok) return r.authError ? { authError: true, message: r.message } : { error: r.message };
      // 套餐信息只入 meta（默认账号没有 Token Plan，不在界面展示）。
      // **无论有没有套餐都写**：`false` 也是事实，缺了它界面/日志会分不清「没套餐」与「没查到」。
      // 键名刻意不含 token/secret 等词——store.stripSensitiveMeta 会把这些键整条剔除。
      saveMeta(account, secrets, { planSubscribed: !!r.hasTokenPlan, planName: r.planName || "" });
      return { credits: r.credits, expiresAt: 0 };
    },

    /** 签到面板（未签 → checkedIn=false；已签 → true + 连续天数/今日积分） */
    async checkinStatus(account, secrets) {
      const c = cfg();
      const token = String((secrets && secrets.token) || "");
      if (!token) return { ok: false, authError: true, message: "该账号没有凭据" };
      const userId = await userIdOf(account, secrets, c);
      if (!userId) return { ok: false, message: "取不到账号身份（realUserID），暂时无法查询签到" };
      const { deviceId, uuid } = identityOf(account, secrets);
      return checkinMod.status({ token, userId, deviceId, uuid, cfg: c, httpJson });
    },

    /** 签到领取：claim_result=2 判 already（幂等成功，不算失败）；成功后回查面板 */
    async checkin(account, secrets) {
      const c = cfg();
      const token = String((secrets && secrets.token) || "");
      if (!token) return { ok: false, authError: true, message: "该账号没有凭据" };
      const userId = await userIdOf(account, secrets, c);
      if (!userId) return { ok: false, message: "取不到账号身份（realUserID），暂时无法签到" };
      const { deviceId, uuid } = identityOf(account, secrets);
      return checkinMod.claim({ token, userId, deviceId, uuid, cfg: c, httpJson });
    },
  };
}

module.exports = { makeMinimaxCode };
