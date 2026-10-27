/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 管理通道的密码学核心（任务 6）：ECDH P-256 登录协商、内存会话、请求签名校验、
// 请求/响应/SSE 帧的 AES-256-GCM 加解密、时间窗与随机数防重放。
//
// 协议 v1（浏览器端任务 7 逐字对齐；tools/admin-crypto-selftest.cjs 里同一套常量独立实现）：
//   · 编码：二进制一律 base64；公钥 = base64(SPKI DER)；ts = Unix 毫秒；ciphertext 携带 密文‖16 字节 GCM tag。
//   · K_token = HKDF-SHA256(令牌, salt="agenthub-admin", info="agenthub-auth")。
//     令牌从 config.admin.token 读（Ruling 9：桌面只认配置令牌，请求不传令牌）。
//   · 登录请求签名 = HMAC(K_token, clientPubKey \n ts \n nonce)；
//     登录响应签名 = HMAC(K_token, serverPubKey \n sessionId \n ts \n nonce)。响应不带任何会话密钥。
//   · 会话密钥 = ECDH 共享秘密经 HKDF 派生三把（salt 同为 "agenthub-admin"）：
//     K_req（info=agenthub-req，客户端→服务端请求密文）、K_resp（info=agenthub-resp，服务端→响应与 SSE 帧）、
//     K_sig（info=agenthub-sig，请求签名）。
//   · 请求签名 = HMAC(K_sig, sessionId \n METHOD \n path \n ts \n nonce \n bodyHash)；
//     METHOD 大写；path 不含 query；bodyHash = SHA-256(密文字节) 的 base64，无请求体（SSE）时为空串。
//   · 密文 = AES-256-GCM(iv 12 字节随机)，ciphertext 字段 = base64(密文‖tag)。
// 令牌、会话密钥、随机数一律不写日志、不进崩溃日志；错误只回 { ok:false }，不区分失败原因。
"use strict";

const crypto = require("node:crypto");
const config = require("./config.cjs");

const HKDF_SALT = "agenthub-admin";
const INFO_TOKEN = "agenthub-auth";
const INFO_REQ = "agenthub-req";
const INFO_RESP = "agenthub-resp";
const INFO_SIG = "agenthub-sig";
const KEY_LEN = 32;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话 12 小时
const MAX_SESSIONS = 100; // 并发会话上限，超出淘汰最旧
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 时间窗 ±5 分钟
const NONCE_TTL_MS = 5 * 60 * 1000; // 随机数去重窗口 5 分钟
const MAX_NONCES = 5000; // 随机数表上限，超出拒绝新请求（宁可拒绝也不放行重放）
const CLEAN_INTERVAL_MS = 60 * 1000; // 定期清理周期

// 时钟可注入（仅自测用）：12 小时过期用例拨快时钟验证，别让自测真等半天
let nowFn = Date.now;
function __setNow(fn) {
  nowFn = typeof fn === "function" ? fn : Date.now;
}

const sessions = new Map(); // sessionId → { keys, createdAt, expiresAt }（插入序 = 创建序，淘汰最旧）
const nonces = new Map(); // `${scope}:${nonce}` → 过期时刻（登录 scope 用 "login"，会话请求用 sessionId）
const clearedListeners = []; // 会话清空回调（admin.cjs 借此关闭 SSE 长连接）

/** HKDF-SHA256 派生：ikm + 固定 salt（"agenthub-admin"）+ info → len 字节 */
function hkdf(ikm, info, len = KEY_LEN) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.from(HKDF_SALT, "utf8"), Buffer.from(info, "utf8"), len));
}

/** ECDH 共享秘密 → K_req / K_resp / K_sig */
function deriveKeys(shared) {
  return { kReq: hkdf(shared, INFO_REQ), kResp: hkdf(shared, INFO_RESP), kSig: hkdf(shared, INFO_SIG) };
}

/** K_token：令牌取 config.admin.token（缺省自动生成，与 adminAccessInfo 同源），每次登录现算 */
function kTokenOf() {
  const cfg = config.loadConfig();
  const token = config.decryptSecret(cfg.admin && cfg.admin.token) || config.ensureAdminToken();
  return hkdf(Buffer.from(String(token), "utf8"), INFO_TOKEN);
}

/** HMAC-SHA256 签名：字段以 \n 分隔（字段本身不含 \n：base64 / 数字 / 路径），输出 base64 */
function sign(key, parts) {
  return crypto.createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("base64");
}

/** 密文哈希：SHA-256(密文字节) 的 base64（ciphertext 字段是 base64，先解回字节） */
function bodyHashOf(ciphertext) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(String(ciphertext || ""), "base64"))
    .digest("base64");
}

/** 签名比较：base64 解码后按字节恒时比较，长度不等直接 false */
function sigEqual(a, b) {
  try {
    const ba = Buffer.from(String(a || ""), "base64");
    const bb = Buffer.from(String(b || ""), "base64");
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function pruneNonces(now) {
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
}

function pruneSessions(now) {
  for (const [k, s] of sessions) if (s.expiresAt <= now) sessions.delete(k);
}

/** 随机数去重：已用过拒绝；超上限先清过期、仍满则拒绝（不淘汰——淘汰等于放行重放） */
function takeNonce(key, now) {
  if (nonces.has(key)) return false;
  if (nonces.size >= MAX_NONCES) {
    pruneNonces(now);
    if (nonces.size >= MAX_NONCES) return false;
  }
  nonces.set(key, now + NONCE_TTL_MS);
  return true;
}

/** 登录协商：验时间窗 + 随机数 + K_token 签名 → 生成服务端 P-256 临时密钥对 → ECDH → 派生三把会话密钥。
 *  返回 { ok, sessionId, serverPubKey, expiresAt, ts, nonce, sig }；失败统一 { ok:false }（不区分原因）。
 *  会话密钥只存在内存 Map，任何情况下都不出现在返回值里 */
function createSession({ clientPubKey, ts, nonce, sig } = {}) {
  const now = nowFn();
  pruneSessions(now);
  pruneNonces(now);
  if (typeof clientPubKey !== "string" || !clientPubKey || typeof nonce !== "string" || !nonce || typeof sig !== "string" || !sig) return { ok: false };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > CLOCK_SKEW_MS) return { ok: false };
  const kToken = kTokenOf();
  if (!sigEqual(sig, sign(kToken, [clientPubKey, String(t), nonce]))) return { ok: false };
  if (!takeNonce(`login:${nonce}`, now)) return { ok: false };
  let clientPub;
  try {
    clientPub = crypto.createPublicKey({ key: Buffer.from(clientPubKey, "base64"), format: "der", type: "spki" });
    if (clientPub.asymmetricKeyType !== "ec" || (clientPub.asymmetricKeyDetails && clientPub.asymmetricKeyDetails.namedCurve && clientPub.asymmetricKeyDetails.namedCurve !== "prime256v1")) return { ok: false };
  } catch {
    return { ok: false }; // 公钥解不出（非 SPKI / 非 P-256）按登录失败处理
  }
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: clientPub });
  } catch {
    return { ok: false };
  }
  const serverPubKey = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const sessionId = crypto.randomBytes(24).toString("hex");
  const expiresAt = now + SESSION_TTL_MS;
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // 淘汰最旧
  sessions.set(sessionId, { keys: deriveKeys(shared), createdAt: now, expiresAt });
  return { ok: true, sessionId, serverPubKey, expiresAt, ts: t, nonce, sig: sign(kToken, [serverPubKey, sessionId, String(t), nonce]) };
}

/** 请求鉴权：会话有效 + 时间窗 ±5 分钟 + 随机数未用过 + K_sig 签名一致。
 *  签名校验通过后才登记随机数（同步实现，无并发窗口）：无效请求不消耗合法请求的 nonce。
 *  返回 { ok:true, keys, expiresAt } 或 { ok:false }（失败原因不外露） */
function verifyRequest({ sessionId, ts, nonce, sig, bodyHash, method, path } = {}) {
  const now = nowFn();
  pruneSessions(now);
  const s = typeof sessionId === "string" && sessionId ? sessions.get(sessionId) : null;
  if (!s || s.expiresAt <= now) return { ok: false };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > CLOCK_SKEW_MS) return { ok: false };
  if (typeof nonce !== "string" || !nonce || typeof sig !== "string" || !sig) return { ok: false };
  const expect = sign(s.keys.kSig, [sessionId, String(method || "").toUpperCase(), String(path || ""), String(t), nonce, String(bodyHash || "")]);
  if (!sigEqual(sig, expect)) return { ok: false };
  if (!takeNonce(`${sessionId}:${nonce}`, now)) return { ok: false };
  return { ok: true, keys: s.keys, expiresAt: s.expiresAt };
}

/** 加密（默认 K_resp）：payload 为字符串 / Buffer 原样，其余 JSON.stringify。
 *  返回 { iv, ciphertext }，ciphertext = base64(密文‖tag) */
function seal(key, payload) {
  const iv = crypto.randomBytes(12);
  const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const out = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), ciphertext: out.toString("base64") };
}

/** 解密：GCM 认证失败（含密文被篡改）返回 null，调用方按统一 401 文案处理 */
function open(key, iv, ciphertext) {
  try {
    const raw = Buffer.from(String(ciphertext || ""), "base64");
    const ivBuf = Buffer.from(String(iv || ""), "base64");
    if (raw.length <= 16 || ivBuf.length !== 12) return null;
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 清空所有会话与随机数（改令牌 / 自测用）：随后调用清空回调（关闭 SSE 等长连接） */
function clearSessions() {
  sessions.clear();
  nonces.clear();
  for (const fn of [...clearedListeners]) {
    try {
      fn();
    } catch {
      /* 清理回调失败不影响会话已清空（浏览器重新登录兜底） */
    }
  }
}

function sessionCount() {
  return sessions.size;
}

/** 会话是否仍然有效（SSE 按此判断过期关闭） */
function hasSession(sessionId) {
  const s = typeof sessionId === "string" && sessionId ? sessions.get(sessionId) : null;
  return !!s && s.expiresAt > nowFn();
}

/** 会话清空回调（admin.cjs 用来在改令牌时关闭 SSE），返回退订函数 */
function onSessionsCleared(fn) {
  if (typeof fn !== "function") return () => {};
  clearedListeners.push(fn);
  return () => {
    const i = clearedListeners.indexOf(fn);
    if (i >= 0) clearedListeners.splice(i, 1);
  };
}

// 令牌变更 → 作废全部会话（Ruling 8：config.onAdminTokenChanged 钩子在此接线）
config.onAdminTokenChanged(() => clearSessions());

// 随机数 / 过期会话定期清理（unref：不拖住进程退出）
const cleaner = setInterval(() => {
  const now = nowFn();
  pruneSessions(now);
  pruneNonces(now);
}, CLEAN_INTERVAL_MS);
if (typeof cleaner.unref === "function") cleaner.unref();

module.exports = { createSession, verifyRequest, seal, open, bodyHashOf, clearSessions, sessionCount, hasSession, onSessionsCleared, __setNow };
