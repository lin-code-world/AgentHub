/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MonkeyCode 每日签到
// GET  /api/v1/users/wallet/checkin            → { checked_in, ... }（只读状态）
// POST /api/v1/users/wallet/checkin {captcha_token} → 执行签到（需先解验证码，见 captcha.cjs）
// 实测：签到一次给积分（钱包余额随之增加）；响应业务码 0 表示成功。
"use strict";

const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");
const models = require("./models.cjs");
const captcha = require("./captcha.cjs");

/** 签到状态（只读）：返回 { checkedIn, streakDays, reward } */
async function fetchCheckinStatus(deps, region, section, session) {
  const base = regionStore.baseUrl(region, section);
  const payload = await models.requestJson(deps, `${base}${endpoints.CHECKIN_PATH}`, session, section, region, "签到状态查询");
  const data = (payload && payload.data) || payload || {};
  return {
    checkedIn: data.checked_in === true,
    streakDays: Number(data.streak_days) || 0,
    reward: Number(data.reward) || 0,
  };
}

/** 执行签到：先解验证码再提交。返回 { ok, already?, authError?, message, checkedIn? }。 */
async function doCheckin(deps, region, section, session) {
  let capToken;
  try {
    capToken = await captcha.solveCaptcha(deps, region, section);
  } catch (e) {
    return { ok: false, message: `签到验证码求解失败：${(e && e.message) || e}` };
  }
  const base = regionStore.baseUrl(region, section);
  const headers = { ...endpoints.jsonHeaders(region, section), Cookie: endpoints.cookieHeader(session), "Content-Type": "application/json" };
  let r;
  try {
    r = await deps.httpJson(`${base}${endpoints.CHECKIN_PATH}`, { method: "POST", headers, body: JSON.stringify({ captcha_token: capToken }) });
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  const status = Number(r && r.status) || 0;
  if (status === 401 || status === 403) return { ok: false, authError: true, message: "MonkeyCode 登录态已失效，请重新粘贴 session" };
  if (!r || !r.ok) return { ok: false, message: `签到失败（HTTP ${status}）` };
  const payload = r.data || {};
  const code = payload.code !== undefined ? Number(payload.code) : 0;
  if (code !== 0) {
    const msg = String(payload.message || "").trim();
    return { ok: false, message: msg ? `签到失败：${msg}` : `签到失败（业务码 ${code}）` };
  }
  const data = payload.data || {};
  return { ok: true, already: false, checkedIn: data.checked_in === true, message: "签到成功" };
}

module.exports = { fetchCheckinStatus, doCheckin };
