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
//      预刷新窗口必须收窄（见 adapter 的 refreshWindowSec / tokenExpiryMs）。
//
// 401 的「刷新一次 + 重试一次」由通用层做（server.cjs 的 attemptChat、credits.refreshAccount），
// 适配器内部**不再自己刷新**，否则会把一次性 refresh token 花两次。
"use strict";

function makeMinimaxCode(deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const channel = "minimaxcode";
  const cfg = () => (rules.get("headers.json") || {}).minimaxcode || {};
  const modelsMod = require("./models.cjs");

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

    async chat() {
      throw new Error("MiniMax Code 对话转发尚未实现");
    },

    async queryCredits() {
      throw new Error("MiniMax Code 余额查询尚未实现");
    },
  };
}

module.exports = { makeMinimaxCode };
