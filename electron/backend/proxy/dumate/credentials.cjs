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
// 反代网关 · DuMate（百度千帆搭子）凭据层：凭据包编解码 + Cookie 头构建 + 临时通行证换取
//
// 凭据链（2026-11-14 实测钉死）：
//   登录 cookies（dumate-export 从客户端 auth.json 解出，明文 JSON）
//     → GET console.bce.baidu.com/api/dumate/app/token/get 换临时通行证（Bearer，~16h）
//     → 打 dumate-svc.baidu.com/gateway/apis/v1/chat/completions
//   云端**不认**客户端日志里那把 X-Dumate-Inapp-Key（实测 401 invalid_api_key），
//   只认 cookies 换来的通行证，故整个渠道的「会话」就是通行证的换与续。
//
// 凭据包：账号的 token 加密列（token_enc）存 JSON 字符串（dumate-export 导入时写入），
// 形状 { cookies, deviceId, clientVersion, prdSource, tenantId }。放加密列而不是 meta，
// 是因为 cookies 是完整登录凭据（58 条、约 13KB），meta 的脱敏正则与体积都不适合它
// （qoder 把设备身份放 meta.dumateDevice 那样做——那里只有非凭据的指纹值）。
"use strict";

// 通行证提前量：到期前 10 分钟就视为过期（服务端 expired_at 带纳秒，解析截到毫秒后
// 保守取整；提前重换的成本只是一次 GET，别把边缘过期漏给请求）
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

// 进程内通行证缓存：uid → { token, expiresAt }。重启即丢，重换成本低（一次 GET），
// 不落库 —— 通行证不是账号凭据，cookies 才是
const tokenCache = new Map();

/** 解析凭据包（secrets.token 的 JSON 字符串）；空/坏包返回 null（调用方报缺凭据） */
function parseEnv(token) {
  const raw = String(token || "").trim();
  if (!raw || raw.startsWith("{") === false) return null;
  let env = null;
  try {
    env = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!env || !Array.isArray(env.cookies) || !env.cookies.length) return null;
  return env;
}

/** Cookie 头构建：name=value; ...（与客户端 buildCookieHeader 同口径，只丢空值项） */
function buildCookieHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** CSRF 令牌（console 域 POST 类接口必带，头名就叫 csrftoken——客户端 proxy-manager 实测）：
 *  值 = 目标域 cookies 里 name=bce-user-info 的值去引号（客户端 extractCsrfToken 同口径）。
 *  实测不带它 POST loginBonus 回「登录凭证已过期」，带上即通。 */
function buildCsrfToken(cookies) {
  const hit = (Array.isArray(cookies) ? cookies : []).find((c) => c && c.name === "bce-user-info" && c.value);
  return hit ? String(hit.value).replace(/^"+|"+$/g, "") : "";
}

/** 企业版判定：loginType=enterprise 或带了租户名（个人版 bce 登录两者皆空） */
function isEnterprise(env) {
  return String((env && (env.prdSource || env.loginType)) || "").toLowerCase() === "enterprise" || !!(env && env.tenantId);
}

/** 通行证过期时间解析：服务端 expired_at 是带纳秒的 ISO（…12.362527214Z），
 *  JS 只认毫秒三位，正则截断；解析不出就按 6 小时保守估计（实测 ~16h，宁短勿长） */
function parseTokenExpiry(iso, now) {
  const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/.exec(String(iso || ""));
  const t = m ? Date.parse(m[1] + "Z") : NaN;
  return Number.isFinite(t) ? t : now + 6 * 60 * 60 * 1000;
}

/** 一次通行证换取（不做缓存；失败抛错带 status） */
async function fetchAccessToken(env, cfg, httpJson) {
  const cookieHeader = buildCookieHeader(env.cookies);
  if (!cookieHeader) {
    throw Object.assign(new Error("DuMate 凭据包里没有可用 cookies"), { status: 401 });
  }
  const ua = `DumateApp/${String(env.clientVersion || (cfg() && cfg().clientVersion) || "1.0.92")}`;
  const url = String((cfg() && cfg().tokenUrl) || "https://console.bce.baidu.com/api/dumate/app/token/get");
  const r = await httpJson(url, {
    method: "GET",
    headers: { Cookie: cookieHeader, "User-Agent": ua, Accept: "application/json" },
  });
  const payload = r && r.data;
  if (r.status !== 200 || !payload || payload.code !== 0 || !payload.result || !payload.result.token) {
    // cookies 失效时 token/get 会 200 但回登录页 HTML（data 解析失败），归因要指向重新导出
    const detail = payload && payload.message ? payload.message : String((r && r.text) || "").slice(0, 120);
    throw Object.assign(new Error(`DuMate 通行证换取失败（HTTP ${r.status}）：${detail || "响应格式不认识"}——登录 cookies 可能已失效，请在客户端重新导出并重新导入`), { status: r.status === 200 ? 401 : r.status });
  }
  return {
    token: String(payload.result.token),
    expiresAt: parseTokenExpiry(payload.result.expired_at, Date.now()),
  };
}

/** 取通行证（带缓存；force 跳过缓存——401 重试时用） */
async function getAccessToken(uid, env, cfg, httpJson, { force } = {}) {
  const now = Date.now();
  const hit = tokenCache.get(uid);
  if (!force && hit && hit.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return hit.token;
  }
  const fresh = await fetchAccessToken(env, cfg, httpJson);
  tokenCache.set(uid, fresh);
  return fresh.token;
}

/** 强制丢弃某账号的缓存通行证（401 后重试前调） */
function dropAccessToken(uid) {
  tokenCache.delete(uid);
}

/** 上游请求头组（2026-11-14 Gateway.log 实测的转发形态，逐项对齐）：
 *  Authorization 是换来的通行证；Baggage 三段 + X-Appbuilder-Dumate-Account-Id 是本地
 *  main-server 转发时追加的，云端路由/风控按它们认账号与设备，缺了实测没拦但别赌。 */
function upstreamHeaders(env, accessToken, cfgOverride) {
  const uid = String((env && env.uid) || "");
  const deviceId = String((env && env.deviceId) || "");
  const ua = `Mozilla/5.0 (Windows NT 10.0; zh-CN) DumateApp/${String((env && env.clientVersion) || (cfgOverride && cfgOverride.clientVersion) || "1.0.92")}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Baggage: `user.id=${uid},dumate.uid=${uid},dumate.device_id=${deviceId}`,
    "User-Agent": ua,
    "X-Appbuilder-Dumate-Account-Id": uid,
    "X-Dumate-Account-Id": uid,
    "X-Dumate-Device-Id": deviceId,
    "X-Dumate-Prd-Source": isEnterprise(env) ? "enterprise" : "personal",
  };
  if (env && env.tenantId) headers["X-Dumate-Tenant-Id"] = String(env.tenantId);
  return headers;
}

module.exports = { parseEnv, buildCookieHeader, buildCsrfToken, isEnterprise, fetchAccessToken, getAccessToken, dropAccessToken, upstreamHeaders, TOKEN_REFRESH_MARGIN_MS };
