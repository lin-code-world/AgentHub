/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-14
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · DuMate（百度千帆搭子）渠道适配器：无状态 OpenAI 兼容上游 + cookies 换通行证
//
// 上游是标准 OpenAI Chat 形态（/gateway/apis/v1/chat/completions，SSE 流式 + delta 带
// reasoning_content），无签名、无会话、不声明 stateful，走默认单发 chat()。
// 唯一的仪式是鉴权：云端不认静态钥匙，只认「登录 cookies → 临时通行证（~16h）」，
// 换证链见 credentials.cjs；通行证过期/被拒时强刷重试一次，cookies 失效才报 401。
//
// 三处与别家不同的取舍：
//   1. 账号凭据是**整包 cookies**（约 13KB / 58 条），存 token 加密列（JSON 字符串），
//      不走 refreshToken/expiresAt —— cookies 是长期登录态，没有独立续期接口；
//   2. 积分余额走 console 域的 quota_overview（cookies 鉴权），个人版靠积分对话
//      （耗尽会被云端拒答 personal_points_exhausted），包集逐包落库；
//   3. 只支持「从 JSON 文件导入」（dumate-export 导出），无 OAuth / 无本机扫描
//      （后端闸见 discovery.cjs；客户端一旦重新登录，旧导出即失效，需重新导出）。
"use strict";

const credentials = require("./credentials.cjs");
const models = require("./models.cjs");

// 订阅包 / 增量包的中文名（取自客户端积分页的 i18n 枚举；认不出的原样展示，不硬猜）
const PLAN_NAMES = { plan_experience: "体验会员", plan_pro: "Pro 会员", plan_max: "Max 会员", plan_team: "Team 会员" };
const BONUS_NAMES = {
  login_bonus: "每日登录奖励",
  invite_bonus: "邀请有礼",
  event_bonus: "活动积分",
  newbie_task: "新人任务",
  reward: "活动积分",
  member_growth: "会员成长计划",
  free_grant: "免费发放",
  point_clear: "到期清零",
};
// 带年份的动态来源（如 growth_plan_2026_bonus）用前缀识别，不逐个枚举年份
function bonusSourceName(source) {
  const s = String(source || "");
  if (BONUS_NAMES[s]) return BONUS_NAMES[s];
  if (s.startsWith("growth_plan")) return "成长计划奖励";
  return s || "奖励积分";
}

function makeDumate(deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const cfg = () => (rules.get("headers.json") || {}).dumate || {};
  const channel = "dumate";

  // 凭据包在 token 加密列（JSON 字符串），解析失败 = 缺凭据
  function envOf(secrets) {
    return credentials.parseEnv(secrets && secrets.token);
  }

  /** 组好鉴权请求头（先换/取通行证）。失败抛错带 status，调用方按需归因 */
  async function authedHeaders(uid, env) {
    const accessToken = await credentials.getAccessToken(uid, env, cfg, httpJson);
    return credentials.upstreamHeaders({ ...env, uid }, accessToken, cfg());
  }

  return {
    id: channel,
    cfg,

    // 模型 id 清单（同步；管理页 / 路由用）：已拉取过目录只认目录（防幽灵模型），未拉取过为空
    // （云端目录接口存在但只有导入凭据后才拉得到，不做静态兜底清单）
    models() {
      return models.list(rules.rulesDir(), channel);
    },

    // 目录条目（含能力 / 倍率元数据），供模型管理与展示
    modelEntries() {
      return models.entries(rules.rulesDir(), channel);
    },

    /** 拉取云端目录：GET {云端网关}/gateway/apis/v1/models（内部模型过滤见 models.shouldExpose）。
     *  返回形状与 Trae/WB 对齐（调用方 proxy_models_sync 只认 { ok, models }） */
    async fetchModels(account, secrets, opts) {
      const env = envOf(secrets);
      if (!env) return { ok: false, message: "该账号没有凭据（请用 dumate-export 导出后从文件导入）" };
      let headers;
      try {
        headers = await authedHeaders(account && account.uid, env);
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
      const r = await models.refresh(headers, cfg(), rules.rulesDir(), channel, !!(opts && opts.force), httpJson);
      if (!r || r.ok === false) return { ok: false, message: (r && r.message) || "目录拉取失败" };
      return { ok: true, models: models.entries(rules.rulesDir(), channel) };
    },

    /** 对话主流程：OpenAI 兼容 SSE。model 按目录逐字校验（云端对未知 id 会 400 或回落，
     *  写错直接拒绝，不替用户改写模型名）。401 时强刷通行证重试一次——那是通行证过期
     *  （~16h），不是 cookies 失效；再 401 才是真凭据问题。 */
    async chat({ account, secrets, model, body, emit }) {
      const env = envOf(secrets);
      if (!env) {
        throw Object.assign(new Error("DuMate 账号缺少凭据包（请用 tools/dumate-export 导出后从文件导入）"), { status: 401 });
      }
      const uid = String((account && account.uid) || env.uid || "");

      // ctx.model 才是要发给上游的真值（别名 / 反向映射 / 模型回退之后的模型名），body.model
      // 仍是客户端请求名（响应 model 字段按原值回显）。与 Loomy/CatPaw 的同口径。
      const rawModel = String(model || (body && body.model) || "");
      const catalogIds = models.list(rules.rulesDir(), channel);
      if (catalogIds.length && !models.resolveFrom(catalogIds, rawModel)) {
        throw Object.assign(new Error(`DuMate 模型目录里没有「${rawModel}」——该渠道只接受云端目录里的精确写法（大小写敏感），请从模型目录页复制模型名`), { status: 400 });
      }

      const c = cfg();
      const base = String(c.chatUrl || "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions");
      // 云端对 messages 是严格数组校验（实测字符串形态 400 invalid_request），
      // 进线 OpenAI body 本就是数组，这里仅兜底防御畸形请求
      const payload = { ...body };
      if (!Array.isArray(payload.messages)) {
        throw Object.assign(new Error("DuMate 上游要求 messages 必须是数组"), { status: 400 });
      }
      payload.model = rawModel;
      payload.stream = true;
      // usage 块要显式要（客户端转发形态实测带了这段；不带的话流末尾没有 usage）
      payload.stream_options = { include_usage: true };
      // 转发形态对齐客户端 main-server（Gateway.log 实测）：extra_parameters 双段是
      // 云端计费/风控的路由依据，缺了实测没拦但别赌
      payload.extra_parameters = {
        ...(payload.extra_parameters && typeof payload.extra_parameters === "object" ? payload.extra_parameters : {}),
        request_source: String(c.requestSource || "qianfan-desk"),
        user_domain_id: uid,
      };
      const bodyText = JSON.stringify(payload);
      const firstByteMs = firstByteBudgetMs(bodyText);

      let headers = await authedHeaders(uid, env);

      const sendOnce = async () =>
        fetchStream(base, {
          method: "POST",
          headers,
          body: bodyText,
          firstByteMs,
        });

      // fetchStream 对非 2xx 是直接抛错（把状态码挂在 error 上），401/403 永远到不了 resp
      // 检查——必须在 catch 里接住再走换证重试（评审 #1：原 resp.status 分支是不可达死代码）。
      // 两次尝试的计时器都由 fetchStream 在抛出前自行清理，这里无需兜底。
      let resp, cancelTimer;
      try {
        ({ resp, cancelTimer } = await sendOnce());
      } catch (e) {
        if (!e || (e.status !== 401 && e.status !== 403)) throw e;
        // 通行证过期（或被云端单点作废）：丢弃缓存强刷重试一次。再拒才是 cookies 失效，
        // 那时 401 冒泡出 chat，走账号 relogin（提示重新导出）
        credentials.dropAccessToken(uid);
        headers = await authedHeaders(uid, env);
        ({ resp, cancelTimer } = await sendOnce());
      }

      const result = { status: 200 };
      if (resp.status !== 200) {
        cancelTimer();
        // 读一小段错误体，把云端的报错带给上层（classifyError 按状态码分类）
        let detail = "";
        try {
          detail = String((await resp.text()) || "").slice(0, 300);
        } catch {
          /* 读不到就算了 */
        }
        throw Object.assign(new Error(`DuMate 上游 HTTP ${resp.status}${detail ? `：${detail}` : ""}`), { status: resp.status });
      }

      let settled = false;
      try {
        await pumpSse(resp, (_event, raw) => {
          // 首个 SSE 事件到达 = 首字节达标，立刻解除首字节预算计时器（issue #107 同口径）
          if (!settled) {
            settled = true;
            cancelTimer();
          }
          if (!raw) return;
          if (raw === "[DONE]") {
            emit({ type: "finish", reason: "" });
            return;
          }
          let chunk = null;
          try {
            chunk = JSON.parse(raw);
          } catch {
            return;
          }
          if (!chunk || typeof chunk !== "object") return;
          const errBody = chunk.error || null;
          if (errBody) {
            const text = String(errBody.message || errBody.code || "上游返回错误");
            const status = /invalid_api_key|unauthorized/i.test(text) ? 401 : 502;
            emit({ type: "error", status, code: errBody.code, message: text });
            return;
          }
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              // delta 整体透传：content 与 reasoning_content（思考链）都在 delta 里（实测）
              emit({ type: "delta", delta: choice.delta });
            }
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (chunk.usage) {
            emit({
              type: "usage",
              usage: {
                ...chunk.usage,
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              },
            });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    // 上游错误分类：401/403 → auth（cookies 失效只能重新导出，不可账号内自愈）；429 → QuotaLimited
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 401 || status === 403) {
        return { kind: "auth", switchable: false, status: 401 };
      }
      if (status === 429) return { kind: "quota", switchable: true, status: 429 };
      return null;
    },

    // 积分余额：GET console 域 /api/dumate/points/quota_overview（cookies 鉴权，客户端 UI 的
    // 积分显示就是它）。上游是**积分包集**：订阅包（体验/Pro/Max/Team）+ 增量包（登录/邀请/
    // 活动奖励），逐包落库走 credits.cjs 的 packages 单一事实源口径（剩余合计、最近到期派生）。
    // 2026-11-14 实测响应：totalPoints="12520.00" usedPoints="21.58"，expireDate 秒/毫秒混用
    // （9999 年的长期包也出现过），统一走 util.normalizeExpiryMs 归一。
    async queryCredits(account, secrets) {
      const env = envOf(secrets);
      if (!env) return { authError: true, message: "DuMate 账号缺少凭据包" };
      const cookieHeader = credentials.buildCookieHeader(env.cookies);
      if (!cookieHeader) return { authError: true, message: "DuMate 凭据包里没有可用 cookies" };
      const tz = (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
        } catch {
          return "Asia/Shanghai";
        }
      })();
      const url = `https://console.bce.baidu.com/api/dumate/points/quota_overview?timezone=${encodeURIComponent(tz)}&clientType=desktop&ignoreLoginBonus=true`;
      let r;
      try {
        r = await httpJson(url, {
          method: "GET",
          headers: { Cookie: cookieHeader, "User-Agent": `DumateApp/${String(env.clientVersion || cfg().clientVersion || "1.0.92")}`, Accept: "application/json" },
        });
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
      const payload = r && r.data;
      // cookies 失效时 token/get 家族都会 200 + 登录页 HTML（data 解析不出 code 字段），如实归因 authError
      if (r.status !== 200 || !payload || payload.code !== 0 || !payload.result) {
        const looksLoggedOut = !payload || payload.code === undefined || /<html|百度智能云-登录/i.test(String(r.text || ""));
        return looksLoggedOut ? { authError: true, message: "积分查询被拒（登录 cookies 已失效）——请在客户端重新导出后重新导入" } : { error: `积分查询失败（HTTP ${r.status}）：${String((payload && payload.message) || r.text || "").slice(0, 120)}` };
      }
      const d = payload.result;
      const pkgs = [];
      const push = (arr, nameOf) => {
        for (const p of arr || []) {
          const total = Number(p.totalPoints) || 0;
          const used = Number(p.usedPoints) || 0;
          pkgs.push({
            code: String(p.packageId || "").slice(0, 128),
            name: nameOf(p),
            total,
            used,
            remaining: Math.max(0, total - used),
            // 秒/毫秒混用 + 9999 年长期包都归一（远未来 → 0 长期有效）
            expiresAt: util.normalizeExpiryMs(p.expireDate ?? p.pointsExpireDate ?? 0),
            ord: pkgs.length,
          });
        }
      };
      push(d.subscription, (p) => PLAN_NAMES[p.packageType] || p.packageType || "订阅包");
      push(d.incremental, (p) => bonusSourceName(p.source));
      if (!pkgs.length) {
        // 没有任何包（异常态）：退回顶层总量口径，expiresAt=0 不设到期
        const credits = Math.max(0, (parseFloat(d.totalPoints) || 0) - (parseFloat(d.usedPoints) || 0));
        return { credits, expiresAt: 0 };
      }
      // checkinStatus 用：包来源（source/packageType 原值）与起算时间。带 _ 前缀的业务辅助字段
      // 会被 credits.cjs 的 normPackageRow 在落库时剥掉（只认 code/name/total/used/remaining/
      // expiresAt/ord），不影响落库形状；这里的对象是内存直传，两个字段只在本次响应里活着。
      for (const [i, p] of [...(d.subscription || []), ...(d.incremental || [])].entries()) {
        if (pkgs[i]) {
          pkgs[i]._source = String(p.source || p.packageType || "");
          pkgs[i]._startAt = util.toMs(p.startDate || 0);
        }
      }
      return { packages: pkgs };
    },

    // cookies 是长期登录态，上游没有「续期凭据」的接口；通行证由 chat 内部自动换取，
    // 不经这条路。真失效（客户端重新登录导致旧 cookies 作废）只能重新导出导入
    async refreshToken() {
      return { ok: false, message: "DuMate 凭据是长期登录 cookies，无续期接口；若云端已拒绝请求，请重新运行 dumate-export 导出后再导入" };
    },

    // 每日登录奖励 = DuMate 的「签到」等价物：POST /api/dumate/points/loginBonus（cookies +
    // csrftoken 双凭证，2026-11-14 实测：缺失 csrftoken 回「登录凭证已过期」，带上回
    // {code:0, success:true, result:true}）。result=false 视为今日不可领（可能已领）。
    // 领取成功后余额会多出一个 source=login_bonus 的增量包，queryCredits 自然带出。
    async checkin(account, secrets) {
      const env = envOf(secrets);
      if (!env) return { ok: false, authError: true, message: "DuMate 账号缺少凭据包" };
      const cookieHeader = credentials.buildCookieHeader(env.cookies);
      const csrf = credentials.buildCsrfToken(env.cookies);
      if (!cookieHeader) return { ok: false, authError: true, message: "DuMate 凭据包里没有可用 cookies" };
      let r;
      try {
        r = await httpJson("https://console.bce.baidu.com/api/dumate/points/loginBonus", {
          method: "POST",
          headers: {
            Cookie: cookieHeader,
            ...(csrf ? { csrftoken: csrf } : {}),
            "Content-Type": "application/json",
            "User-Agent": `DumateApp/${String(env.clientVersion || cfg().clientVersion || "1.0.92")}`,
            Accept: "application/json",
          },
          body: "{}",
        });
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
      const payload = r && r.data;
      const looksLoggedOut = !payload || payload.code === undefined || /<html|登录凭证已过期|百度智能云-登录/i.test(String(r.text || ""));
      if (looksLoggedOut) {
        return { ok: false, authError: true, message: "签到被拒（登录 cookies 已失效）——请在客户端重新导出后重新导入" };
      }
      if (payload.code !== 0 || !payload.success) {
        return { ok: false, message: `签到失败：${String((payload && payload.message && payload.message.global) || payload.message || r.text || "").slice(0, 120)}` };
      }
      // result=true=已发放；false=今日已领过/不可领（客户端同款布尔语义，两态都不算错误）。
      // 第二分支带 already:true 对齐 raccoon 等渠道的幂等约定：前端显示「已完成（幂等）」
      // 而非「签到成功」，执行器也不会再触发一次多余的余额刷新（评审 #5）
      return payload.result === true ? { ok: true, message: "每日登录奖励领取成功" } : { ok: true, already: true, message: "今日登录奖励已领取" };
    },

    // 「今日是否已领」的判据来自 quota_overview 的包集：source=login_bonus 的增量包
    // startDate 就是领取时刻（当天零点对齐，2026-11-14 实测）——startDate 在今天即已领。
    // 复用 queryCredits 同一次上游数据（_source/_startAt 由它附带），不发额外请求。
    async checkinStatus(account, secrets) {
      const env = envOf(secrets);
      if (!env) return { ok: false, authError: true, message: "DuMate 账号缺少凭据包" };
      const r = await this.queryCredits(account, secrets);
      if (r.error || r.authError) return { ok: false, ...(r.authError ? { authError: true } : {}), message: r.message || r.error };
      const pkgs = Array.isArray(r.packages) ? r.packages : [];
      const todayHead = new Date();
      todayHead.setHours(0, 0, 0, 0);
      const claimed = pkgs.some((p) => p._source === "login_bonus" && Number(p._startAt || 0) >= todayHead.getTime());
      return claimed ? { ok: true, checkedIn: true, message: "今日登录奖励已领取" } : { ok: true, checkedIn: false, message: "今日登录奖励尚未领取（点签到领取，或客户端打开时自动领）" };
    },
  };
}

module.exports = { makeDumate };
