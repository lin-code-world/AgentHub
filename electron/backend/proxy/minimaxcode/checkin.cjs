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
// 反代网关 · MiniMax Code 每日签到（账号类接口，需 Bearer + 双签名）
//
//   GET  {agent}/minimax-cloud/api/v1/signin/status  → { data: { scene, days: [{ day_no, points, status, is_today }] } }
//   POST {agent}/minimax-cloud/api/v1/signin/claim   body {} → { data: { claim_result, day_no, points } }
//
// 口径：
//   · `days[].status`：1 = 未来日 / 2 = 今天未签 / 3 = 今天已签；
//   · `claim_result === 2` 是「今天已领」的幂等返回，必须判成功（否则界面每天都报失败）；
//   · 领取后回查一次面板，把最新余额/连续天数一并带回（与 Trae 同口径）。
// 国内站实测有签到服务（7 天一轮，第 4/7 天各 1000 积分），不存在「大陆区跳过」。
"use strict";

const sign = require("./sign.cjs");

function todayOf(payload) {
  const data = (payload && payload.data) || (payload && payload.base_resp ? null : payload) || {};
  const days = Array.isArray(data && data.days) ? data.days : [];
  const today = days.find((d) => d && d.is_today) || null;
  return { data, days, today };
}

async function call(statusOrClaim, { token, userId, deviceId, uuid, cfg, httpJson, body }) {
  const c = cfg || {};
  if (!token) return { ok: false, authError: true, message: "该账号没有凭据" };
  const base = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
  const p = statusOrClaim === "claim"
    ? (c.signinClaimPath || "/minimax-cloud/api/v1/signin/claim")
    : (c.signinStatusPath || "/minimax-cloud/api/v1/signin/status");
  const unixMs = Date.now();
  const queryStr = sign.desktopQuery({ unixMs, userId: userId || "0", deviceId, uuid, cfg: c });
  const pathQuery = `${p}?${queryStr}`;
  const payloadText = body === undefined ? "" : body;
  let r;
  try {
    r = await httpJson(`${base}${pathQuery}`, {
      method: body === undefined ? "GET" : "POST",
      headers: sign.accountHeaders({ cfg: c, token, body: payloadText, unixMs, pathQuery }),
      ...(body === undefined ? {} : { body: payloadText }),
    });
  } catch (e) {
    return { ok: false, message: `签到请求失败：${String((e && e.message) || e)}` };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "登录态已失效（401），请重新登录" };
  const payload = r.data && typeof r.data === "object" ? r.data : {};
  const statusCode = Number((payload.base_resp && payload.base_resp.status_code) ?? NaN);
  if (statusCode === 401 || statusCode === 403) return { ok: false, authError: true, message: `登录态已失效（业务码 ${statusCode}），请重新登录` };
  if (r.status >= 400) return { ok: false, message: `签到请求失败（HTTP ${r.status}）：${(r.text || "").slice(0, 160)}` };
  if (Number.isFinite(statusCode) && statusCode !== 0) {
    const msg = String((payload.base_resp && payload.base_resp.status_msg) || "");
    return { ok: false, message: `签到接口返回业务码 ${statusCode}${msg ? `：${msg}` : ""}` };
  }
  return { ok: true, payload };
}

async function status(args) {
  const r = await call("status", args);
  if (!r.ok) return r;
  const { today, days } = todayOf(r.payload);
  const points = today ? Number(today.points) || 0 : 0;
  return {
    ok: true,
    checkedIn: !!(today && Number(today.status) === 3),
    // 字段名沿用仓库签到契约（store.noteCheckin 与前端只认 credit / streakDays）：
    // 写成 credits / consecutiveDays 会让「本次获得」「连续天数」在界面上永远不显示。
    credit: points,
    streakDays: today ? Number(today.day_no) || 0 : 0,
    message: today && Number(today.status) === 3 ? `今日已签到（第 ${Number(today.day_no) || 1} 天，${points} 积分）` : "今日未签到",
    days,
  };
}

async function claim(args) {
  const r = await call("claim", { ...args, body: "{}" });
  if (!r.ok) return r;
  const data = (r.payload && r.payload.data) || {};
  const result = Number(data.claim_result) || 0;
  const reward = Number(data.points) || 0;
  if (result === 2) {
    const st = await status(args).catch(() => null);
    return { ok: true, already: true, credit: 0, status: st && st.ok ? st : null, message: "今天已经签到过了" };
  }
  const st = await status(args).catch(() => null);
  return { ok: true, already: false, credit: reward, status: st && st.ok ? st : null, message: `签到成功${reward ? `，获得 ${reward} 积分` : ""}` };
}

module.exports = { status, claim };
