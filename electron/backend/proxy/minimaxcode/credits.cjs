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
// 反代网关 · MiniMax Code 积分余额
//
//   POST {agent}/matrix/api/v1/commerce/get_membership_info   body {}
//   → data.op_credit_summary.total_remaining_amount = "400"（字符串）
//
// 三个要点：
//   1. 余额字段是**字符串小数**（实测 "1492.125"），Number 化但绝不取整；
//   2. 查询串里的 user_id 是 realUserID（不在令牌里，见 identity.cjs）；
//   3. 401 有两种形态：HTTP 401 `{"error":"invalid access token"}`，以及 HTTP 200 但
//      `base_resp.status_code=401`——两种都判 authError，交给通用层刷新后重试/标 relogin。
// 套餐（has_token_plan / plan_name）只入 meta 与日志，不上界面（默认账号没有 Token Plan）。
"use strict";

const sign = require("./sign.cjs");

async function query({ token, userId, deviceId, uuid, cfg, httpJson }) {
  const c = cfg || {};
  if (!token) return { ok: false, authError: true, message: "该账号没有凭据" };
  const base = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
  const p = c.membershipPath || "/matrix/api/v1/commerce/get_membership_info";
  const unixMs = Date.now();
  const queryStr = sign.desktopQuery({ unixMs, userId: userId || "0", deviceId, uuid, cfg: c });
  const pathQuery = `${p}?${queryStr}`;
  const body = "{}";
  let r;
  try {
    r = await httpJson(`${base}${pathQuery}`, {
      method: "POST",
      headers: sign.accountHeaders({ cfg: c, token, body, unixMs, pathQuery }),
      body,
    });
  } catch (e) {
    return { ok: false, message: `余额查询失败：${String((e && e.message) || e)}` };
  }
  if (r.status === 401) {
    return { ok: false, authError: true, message: "登录态已失效（401），请重新登录" };
  }
  // 403 是套餐/模型权限不足，与凭据无关：判成 authError 会让通用层白花一枚一次性 refresh token
  // 并把好账号标「需重登」。这里只当普通失败上报。
  if (r.status === 403) {
    return { ok: false, message: `余额接口拒绝访问（HTTP 403，通常是套餐/权限不足）：${(r.text || "").slice(0, 120)}` };
  }
  const payload = r.data && typeof r.data === "object" ? r.data : {};
  // 上游可能把业务包放在 data 里，也可能直接平铺在顶层：两处都认（签到侧同一口径）
  const core = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const baseResp = (payload.base_resp && typeof payload.base_resp === "object" ? payload.base_resp : null)
    || (core.base_resp && typeof core.base_resp === "object" ? core.base_resp : {});
  const statusCode = Number(baseResp.status_code ?? NaN);
  if (statusCode === 401) {
    return { ok: false, authError: true, message: `登录态已失效（业务码 ${statusCode}），请重新登录` };
  }
  if (r.status >= 400) {
    return { ok: false, message: `余额查询失败（HTTP ${r.status}）：${(r.text || "").slice(0, 160)}` };
  }
  if (Number.isFinite(statusCode) && statusCode !== 0) {
    const msg = String(baseResp.status_msg || "");
    return { ok: false, message: `余额接口返回业务码 ${statusCode}${msg ? `：${msg}` : ""}` };
  }
  const summary = core.op_credit_summary && typeof core.op_credit_summary === "object" ? core.op_credit_summary : {};
  const raw = summary.total_remaining_amount ?? core.total_remains_credit ?? core.opcredit_balance ?? 0;
  const credits = Number(raw);
  return {
    ok: true,
    credits: Number.isFinite(credits) ? credits : 0,
    hasTokenPlan: core.has_token_plan === true,
    planName: String(core.plan_name || ""),
  };
}

module.exports = { query };
