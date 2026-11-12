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
// 反代网关 · MiniMax Code 账号身份与设备指纹
//
// 两件事：
//   1. `realUserID` 不在任何令牌里（官方 access token 是 `mmoat_` 开头的 opaque 串），余额 / 签到
//      的查询串都要求 `user_id`，只能调 `/v1/api/user/info` 取——该接口允许 `user_id=0` 的引导调用，
//      这是唯一拿得到身份的口子。取到后写进账号 meta，后续不再请求。
//   2. 设备指纹（device_id / uuid）按账号派生并持久化：同机多号不共享，避免上游把多个账号
//      看成同一台设备的批量行为。余额 / 签到只把它当签名参数（实测随机 uuid 也能通过），
//      所以派生规则稳定即可，不追求与真实客户端逐位一致。
"use strict";

const crypto = require("node:crypto");
const sign = require("./sign.cjs");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** 8 位十进制设备号（贴近官方 `device_id` 形态） */
function deviceIdFrom(seed) {
  const hex = sha256("device:" + seed).slice(0, 16);
  const n = BigInt("0x" + hex) % 100000000n;
  return String(n).padStart(8, "0");
}

/** 标准 UUID v4 形态（version/variant 位按规范置位） */
function uuidFrom(seed) {
  const h = sha256("uuid:" + seed);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 账号的设备指纹：meta 里已有就原样沿用（登录时固化，避免每次请求换设备），
 * 没有则按 uid（缺失回落到 id）稳定派生——**不写库**，写回时机由调用方决定。
 */
function deviceIdentity(account) {
  const meta = (account && account.meta) || {};
  if (meta.deviceId && meta.uuid) return { deviceId: String(meta.deviceId), uuid: String(meta.uuid) };
  const seed = String((account && (account.uid || account.id)) || "minimaxcode");
  return { deviceId: deviceIdFrom(seed), uuid: uuidFrom(seed) };
}

async function fetchUserInfo({ token, cfg, deviceId, uuid, httpJson }) {
  const c = cfg || {};
  const agentBase = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
  const p = c.userInfoPath || "/v1/api/user/info";
  const unixMs = Date.now();
  // 首次引导：签名里的 user_id 填 0（实测该接口只要求这一位可缺省）
  const query = sign.desktopQuery({ unixMs, userId: "0", deviceId, uuid, cfg: c });
  const pathQuery = `${p}?${query}`;
  let r;
  try {
    r = await httpJson(`${agentBase}${pathQuery}`, {
      method: "GET",
      headers: sign.accountHeaders({ cfg: c, token, body: "", unixMs, pathQuery }),
    });
  } catch (e) {
    return { ok: false, authError: false, message: `账号信息查询失败：${String((e && e.message) || e)}` };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "登录态已失效（401），请重新登录" };
  const core = (r.data && (r.data.data || r.data)) || {};
  const info = (core && core.userInfo) || core || {};
  const realUserID = String(info.realUserID || "").trim();
  if (!realUserID) {
    return { ok: false, authError: false, message: `账号信息缺少 realUserID（HTTP ${r.status}）：${(r.text || "").slice(0, 160)}` };
  }
  return { ok: true, realUserID, name: String(info.name || "").trim() };
}

/**
 * 取 realUserID：账号 meta 命中直接返回；否则问上游并把结果交给 `save` 落库。
 * 失败返回空串（调用方据此把该账号的余额标记为「查不到」，而不是判死账号）。
 */
async function ensureRealUserID({ account, secrets, cfg, httpJson, save }) {
  const meta = (account && account.meta) || {};
  const cached = String(meta.realUserID || "").trim();
  if (cached) return cached;
  const { deviceId, uuid } = deviceIdentity(account);
  const r = await fetchUserInfo({ token: String((secrets && secrets.token) || ""), cfg, deviceId, uuid, httpJson });
  if (!r.ok) return "";
  if (typeof save === "function") save({ realUserID: r.realUserID, ...(r.name ? { userName: r.name } : {}) });
  return r.realUserID;
}

module.exports = { deviceIdentity, fetchUserInfo, ensureRealUserID, deviceIdFrom, uuidFrom };
