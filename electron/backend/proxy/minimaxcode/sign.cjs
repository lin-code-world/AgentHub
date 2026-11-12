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
// 反代网关 · MiniMax Code 账号类接口的双签名（纯函数，不发请求）
//
//   x-signature = md5(unix秒 + 盐 + body)
//   yy          = md5(encodeURIComponent(签名路径与查询) + "_" + (body || "{}") + md5(毫秒时间戳) + 后缀)
//
// 两条都是客户端 bundle 里算好的摘要，盐与后缀是公开常量（不是机密）。要点：
//   1. encodeURIComponent 的口径与 JS 一致——保留 `A-Za-z0-9-_.!~*'()`，其余按 UTF-8 逐字节 %XX；
//      `encodeURIComponent` 不编码 `!*'()` 而 urllib.quote 会，差一个字符签名即失效；
//   2. 查询串**顺序是契约**：`yy` 是对编码后的整串取摘要，调换字段顺序等于换一个请求；
//   3. `unix`（URL 里）与 `md5(毫秒)`（摘要里）必须来自同一次读数，所以 desktopQuery 与
//      accountHeaders 都接收同一个 unixMs。
"use strict";

const crypto = require("node:crypto");

// 客户端 bundle 内的公开常量（与 rules.cjs 的 minimaxcode.signSalt / signSuffix 同值）
const DEFAULT_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";
const DEFAULT_SUFFIX = "ooui";

const UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;

function md5(value) {
  return crypto.createHash("md5").update(String(value), "utf8").digest("hex");
}

/** JS encodeURIComponent 口径（非 ASCII 走 UTF-8，一个字节一个 %XX） */
function encodeUriComponent(value) {
  const out = [];
  for (const byte of Buffer.from(String(value), "utf8")) {
    const ch = String.fromCharCode(byte);
    out.push(UNRESERVED.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0"));
  }
  return out.join("");
}

/** URLSearchParams 口径：同 encodeUriComponent，但空格变 `+`（签到接口用这套） */
function formEncode(value) {
  return encodeUriComponent(value).replace(/%20/g, "+");
}

function xSignature(unixSec, body, salt) {
  return md5(`${Number(unixSec)}${salt || DEFAULT_SALT}${body === undefined || body === null ? "" : String(body)}`);
}

function yy(signPathQuery, body, unixMs, suffix) {
  const payload = body === undefined || body === null || body === "" ? "{}" : String(body);
  return md5(`${encodeUriComponent(signPathQuery)}_${payload}${md5(String(unixMs))}${suffix || DEFAULT_SUFFIX}`);
}

/**
 * 桌面客户端指纹查询串（顺序固定，见文件头第 2 条）。
 * 空值跳过（客户端 axios 对缺失字段直接不发）；`user_id` 首次引导时为 "0"，必须照发。
 */
function desktopQuery({ unixMs, userId, deviceId, uuid, cfg }) {
  const c = cfg || {};
  const pairs = [
    ["device_platform", "web"],
    ["biz_id", "3"],
    ["app_id", "3001"],
    ["version_code", "22201"],
    ["unix", String(unixMs)],
    ["timezone_offset", "28800"],
    ["is_desktop", "1"],
    ["desktop_version", c.desktopVersion || "3.1.14"],
    ["sys_language", "zh"],
    ["lang", "zh"],
    ["uuid", uuid || ""],
    ["device_id", deviceId || ""],
    ["os_name", "Windows"],
    ["browser_name", "Chrome"],
    ["device_memory", String(c.deviceMemory || 32)],
    ["cpu_core_num", String(c.cpuCoreNum || 12)],
    ["browser_language", "zh-CN"],
    ["browser_platform", "Win32"],
    ["user_id", String(userId === undefined || userId === null ? 0 : userId)],
    ["screen_width", String(c.screenWidth || 2048)],
    ["screen_height", String(c.screenHeight || 1152)],
    ["client", "desktop"],
    ["region", "en"],
  ];
  return pairs.filter(([, v]) => v !== "").map(([k, v]) => `${k}=${formEncode(v)}`).join("&");
}

/** 账号类接口的请求头（余额 / 签到 / user/info 共用） */
function accountHeaders({ cfg, token, body, unixMs, pathQuery }) {
  const c = cfg || {};
  const now = Number(unixMs) || Date.now();
  const sec = Math.floor(now / 1000);
  const base = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    "content-type": "application/json",
    origin: base,
    referer: base + "/",
    "user-agent": c.userAgent || "MiniMaxAgent",
    authorization: `Bearer ${token}`,
    "x-timestamp": String(sec),
    "x-signature": xSignature(sec, body, c.signSalt),
    yy: yy(pathQuery, body, now, c.signSuffix),
  };
}

module.exports = { md5, encodeUriComponent, formEncode, xSignature, yy, desktopQuery, accountHeaders, DEFAULT_SALT, DEFAULT_SUFFIX };
