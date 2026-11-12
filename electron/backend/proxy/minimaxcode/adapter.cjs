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
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const channel = "minimaxcode";
  const cfg = () => (rules.get("headers.json") || {}).minimaxcode || {};

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

    /** 续期：一次性 refresh token 只花一次；成功即由调用方写回（通用层负责落库）。
     *  失败不重试——invalid_grant 意味着这一枚已经作废，重试只会更糟。 */
    async refreshToken(account, secrets) {
      const refreshToken = String((secrets && secrets.refreshToken) || "");
      if (!refreshToken) return { ok: false, authError: true, message: "没有续期凭据，请重新登录" };
      if (spentRefresh.has(digestOf(refreshToken))) {
        return { ok: false, authError: true, message: "续期凭据已被使用过（一次性），请重新登录" };
      }
      rememberSpent(refreshToken);
      const r = await oauth.refresh({ refreshToken, cfg: cfg(), httpJson });
      if (!r.ok) return { ok: false, authError: !!r.authError, message: r.message };
      return { ok: true, token: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt };
    },

    /** access token 是 opaque（`mmoat_` 前缀），JWT 解不出 exp，必须由这里回答到期时间，
     *  否则 ensureFreshSecrets 认为「无到期」永不预刷新。 */
    tokenExpiryMs(account) {
      const meta = (account && account.meta) || {};
      return Number(meta.accessExpiresAt) || 0;
    },

    /** 预刷新窗口收窄到 10 分钟（默认 86400 = 24 小时 > token 有效期 12 小时，会把每轮余额刷新
     *  都变成一次续期，一轮轮花掉一次性 refresh token——小浣熊渠道踩过的同一个坑）。 */
    refreshWindowSec: 600,

    /** 渠道级错误分类：两种 401 错误体（对话 `{"code":401,...}`、账号接口 `{"error":"invalid access token"}`）
     *  都要判 auth；其余交给通用分类器（400 → fatal 不罚号）。 */
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      const body = String((e && e.body) || "");
      if (status === 401 || status === 403 || /invalid access token|auth failed/i.test(body)) {
        return { kind: "auth", switchable: false };
      }
      return null;
    },

    async queryCredits() {
      throw new Error("MiniMax Code 余额查询尚未实现");
    },
  };
}

module.exports = { makeMinimaxCode };
