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
// 反代网关 · MiniMax Code 的 OAuth（设备码 + PKCE S256）+ 刷新
//
// 与官方客户端（packages/oauth-core）同一套协议：
//   POST {account}/oauth2/device/code  client_id=mcode-public, scope=agent.default, audience=agent-backend,
//                                      code_challenge + code_challenge_method=S256
//   POST {account}/oauth2/token        grant_type=urn:ietf:params:oauth:grant-type:device_code,
//                                      device_code（**部分账号只回 user_code，此时用 user_code 轮询**）,
//                                      client_id, code_verifier
//   POST {account}/oauth2/token        grant_type=refresh_token, refresh_token, client_id, scope, audience
//
// refresh token **一次性**：第二次用同一枚一定 invalid_grant，调用方必须串行且不重试
// （互斥与"已花掉"保护在 adapter 的 refreshToken 里）。
"use strict";

const crypto = require("node:crypto");

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function str(o, k) {
  return typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined;
}
function num(o, k) {
  return typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : undefined;
}

function baseOf(cfg) {
  return String((cfg && cfg.accountBase) || "https://account.minimax.cn").replace(/\/+$/, "");
}

async function postForm(url, fields, httpJson) {
  const r = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  const body = r && r.data && typeof r.data === "object" ? r.data : null;
  return { status: Number(r && r.status) || 0, body, text: (r && r.text) || "" };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 上游把有效期给成 `expired_in`（有时是毫秒时间戳）或 `expires_in`（秒），两种都要认 */
function normalizeExpiresIn(body) {
  const raw = num(body, "expired_in") || num(body, "expires_in");
  if (!raw) return undefined;
  if (raw > 10000000) return Math.max(1, Math.floor((raw - Date.now()) / 1000));
  return Math.floor(raw);
}

/** interval 正常是秒，但个别账号回毫秒（>100 视为毫秒） */
function normalizeInterval(raw) {
  const v = num({ interval: raw }, "interval");
  if (!v) return 5;
  return v > 100 ? Math.max(1, Math.round(v / 1000)) : v;
}

async function requestDeviceCode(challenge, cfg, httpJson) {
  const url = `${baseOf(cfg)}/oauth2/device/code`;
  let r;
  try {
    r = await postForm(url, {
      client_id: (cfg && cfg.clientId) || "mcode-public",
      scope: (cfg && cfg.scope) || "agent.default",
      audience: (cfg && cfg.audience) || "agent-backend",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }, httpJson);
  } catch (e) {
    return { ok: false, message: `设备码申请失败：${String((e && e.message) || e)}` };
  }
  const body = r.body || {};
  const userCode = str(body, "user_code");
  const deviceCode = str(body, "device_code");
  const uri = str(body, "verification_uri_complete") || str(body, "verification_uri") || str(body, "verification_url");
  if (r.status >= 400 || !userCode || !uri) {
    return { ok: false, message: `设备码申请失败（HTTP ${r.status}）：${(r.text || "").slice(0, 200)}` };
  }
  // MiniMax 变体：没有 device_code 时用 user_code 轮询（官方 oauth-core 的 tokenPollingParameter）
  const pollByUser = !deviceCode;
  return {
    ok: true,
    deviceCode: deviceCode || userCode,
    userCode,
    verificationUri: uri,
    expiresIn: normalizeExpiresIn(body) || 600,
    interval: normalizeInterval(body.interval),
    pollByUser,
  };
}

async function pollToken({ deviceCode, pollByUser, verifier }, cfg, httpJson) {
  const url = `${baseOf(cfg)}/oauth2/token`;
  const fields = {
    grant_type: DEVICE_GRANT,
    client_id: (cfg && cfg.clientId) || "mcode-public",
    code_verifier: verifier,
    ...(pollByUser ? { user_code: deviceCode } : { device_code: deviceCode }),
  };
  let r;
  try {
    r = await postForm(url, fields, httpJson);
  } catch (e) {
    return { kind: "failed", message: `轮询失败：${String((e && e.message) || e)}` };
  }
  const body = r.body || {};
  const status = str(body, "status");
  if (status === "pending") return { kind: "pending" };
  if (status === "slow_down") return { kind: "slowDown" };
  if (status === "denied" || status === "access_denied") return { kind: "failed", message: "授权被拒绝" };
  if (status === "expired" || status === "expired_token") return { kind: "failed", message: "设备码已过期，请重新发起登录" };
  // 标准 OAuth 设备流（RFC 8628）把「还没授权」放在 error 字段里、HTTP 400：
  // {"error":"authorization_pending"} / {"error":"slow_down"} / {"error":"access_denied"}。
  // 实测 MiniMax 两种形态都会出现——只认 status 会把正常等待判成登录失败。
  const oauthError = str(body, "error");
  if (oauthError === "authorization_pending" || oauthError === "pending") return { kind: "pending" };
  if (oauthError === "slow_down") return { kind: "slowDown" };
  if (oauthError === "access_denied" || oauthError === "denied") return { kind: "failed", message: "授权被拒绝" };
  if (oauthError === "expired_token" || oauthError === "expired") return { kind: "failed", message: "设备码已过期，请重新发起登录" };
  if (oauthError) return { kind: "failed", message: `${oauthError}${str(body, "error_description") ? `: ${str(body, "error_description")}` : ""}` };
  const accessToken = str(body, "access_token");
  if (!accessToken) return { kind: "failed", message: `登录未返回令牌（HTTP ${r.status}）：${(r.text || "").slice(0, 200)}` };
  const expiresIn = num(body, "expires_in") || 43200;
  return {
    kind: "confirmed",
    tokens: {
      accessToken,
      refreshToken: str(body, "refresh_token") || "",
      expiresAt: Date.now() + expiresIn * 1000,
    },
  };
}

async function refresh({ refreshToken, cfg, httpJson }) {
  if (!refreshToken) return { ok: false, authError: true, message: "没有续期凭据（refresh token），请重新登录" };
  const url = `${baseOf(cfg)}/oauth2/token`;
  let r;
  try {
    r = await postForm(url, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: (cfg && cfg.clientId) || "mcode-public",
      scope: (cfg && cfg.scope) || "agent.default",
      audience: (cfg && cfg.audience) || "agent-backend",
    }, httpJson);
  } catch (e) {
    return { ok: false, authError: false, message: `续期请求失败：${String((e && e.message) || e)}` };
  }
  const body = r.body || {};
  const accessToken = str(body, "access_token");
  if (accessToken) {
    const expiresIn = num(body, "expires_in") || 43200;
    return {
      ok: true,
      accessToken,
      refreshToken: str(body, "refresh_token") || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
  // invalid_grant = 这一枚已被用过/已作废（一次性语义），只能重新登录
  const err = str(body, "error") || "";
  const authError = /invalid_grant|invalid_request|unauthorized|invalid_token/i.test(err) || r.status === 400 || r.status === 401;
  return { ok: false, authError, message: `续期失败（HTTP ${r.status}）${err ? `：${err}` : ""}` };
}

module.exports = { pkce, requestDeviceCode, pollToken, refresh, DEVICE_GRANT };
