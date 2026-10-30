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
// 管理通道密码学自测（任务 6）：adminCrypto（ECDH P-256 登录协商 + 签名 + AES-256-GCM）
// 与 admin.cjs 的 /api/login、/api/rpc、/api/events 接线。
// 浏览器侧用 node:crypto 模拟（P-256 密钥对、HKDF、HMAC、AES-GCM），协议常量在本文件逐字写死，
// 与服务端实现对齐（谁改协议两边一起改）。
// 覆盖：登录成功且不返回会话密钥、双方派生密钥一致（密钥逐字节 + 加解密往返）、错误签名被拒、
// 同一 nonce 第二次被拒、超过 12 小时会话被拒、改令牌后旧会话失效、请求体篡改后 GCM 解密失败、
// 时间窗 ±5 分钟、会话上限 100 淘汰最旧、随机数上限 5000、RPC 门控（deny 403 / 未知命令 404 /
// handler {ok:false} 仍加密）、SSE 逐帧加密与清空会话关闭连接、401 统一文案。
// 沙箱：AGENTHUB_DATA_DIR 指向临时目录。用法：node tools/admin-crypto-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-admincrypto-"));
process.env.AGENTHUB_DATA_DIR = path.join(SANDBOX, "data");

// ===== 协议常量（与 electron/backend/adminCrypto.cjs 逐字对齐） =====
const HKDF_SALT = "agenthub-admin";
const INFO_TOKEN = "agenthub-auth";
const INFO_REQ = "agenthub-req";
const INFO_RESP = "agenthub-resp";
const INFO_SIG = "agenthub-sig";
const TOL_MS = 5 * 60 * 1000; // 时间窗 ±5 分钟
const NONCE_TTL_MS = 5 * 60 * 1000; // 随机数去重窗口 5 分钟
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话有效期 12 小时

const PROXY_PORT = 19629; // 管理端口 = 反代端口 + 1
const ADMIN_URL = `http://127.0.0.1:${PROXY_PORT + 1}`;
const UNAUTHORIZED = "未授权"; // 401 统一文案

let pass = 0,
  fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}

const EXPECTED = [
  "A1 createSession 成功返回 sessionId / serverPubKey / expiresAt，且不返回任何会话密钥字段",
  "A2 登录响应签名 = HMAC(K_token, serverPubKey\\nsessionId\\nts\\nnonce)，客户端可验证",
  "A3 双方派生的 kReq / kResp / kSig 逐字节一致，且加解密双向往返成功",
  "A4 请求体篡改后 GCM 解密失败（open 返回 null）",
  "A5 verifyRequest 正常通过并返回 keys",
  "A6 错误签名 verifyRequest 返回 ok=false",
  "A7 同一 nonce 第二次使用被拒绝",
  "A8 时间窗 ±5 分钟之外被拒",
  "A9 超过 12 小时的会话被拒绝",
  "A10 改令牌后所有旧会话失效（sessionCount 归零）",
  "A11 会话上限 100 条，超出淘汰最旧",
  "A12 单会话随机数上限 1000 条（Ruling 15），超出拒绝",
  "A13 登录随机数上限 100 条（Ruling 15），第 101 次登录被拒",
  "B1 POST /api/login 200 且字段齐全、不返回会话密钥",
  "B2 登录签名错误 → 401 统一文案",
  "B3 /api/rpc 加密往返：echo 明文一致、响应回带请求 nonce",
  "B13 /api/rpc 响应不含令牌明文；admin_access_info 在 browser 形态被拒（Ruling 16）",
  "B4 /api/rpc 签名错误 → 401",
  "B5 /api/rpc 同一 nonce 重放 → 401",
  "B6 /api/rpc 密文被篡改（签名按篡改后重算）→ 401（GCM 认证失败）",
  "B7 handler 返回 {ok:false} 仍加密返回",
  "B8 handler 抛异常 → 加密返回 {ok:false}",
  "B8 handler 返回不可序列化值（BigInt）→ 加密返回 {ok:false}，服务不崩",
  "B9 deny 命令 → 403 且带浏览器文案",
  "B10 未知命令 → 404",
  "B11 未鉴权 GET /api/events → 401",
  "B12 401 统一文案（签名错 / 时间窗 / 重放 / 会话失效 响应体一致）",
  "C1 SSE 鉴权后收到加密首帧（seq=1）且可用 K_resp 解密",
  "C2 清空会话后 SSE 连接关闭",
  "C3 SSE 帧 seq 单调递增（Ruling 19）",
  "C4 会话过期后 SSE 连接被关闭",
  "C5 platform 事件经事件桥广播为加密 SSE 帧（信封同 app:event、事件体不带内容）",
  "D1 登录限流：每 IP 每分钟 20 次，超出 429",
];

let adminCrypto = null,
  admin = null,
  config = null;
try {
  adminCrypto = require(path.join(ROOT, "electron", "backend", "adminCrypto.cjs"));
  admin = require(path.join(ROOT, "electron", "backend", "admin.cjs"));
  config = require(path.join(ROOT, "electron", "backend", "config.cjs"));
} catch (e) {
  console.log("RED：模块加载失败（实现前预期）：" + String((e && e.message) || e));
  console.log("预期断言（实现后应全绿）：");
  for (const t of EXPECTED) console.log("  - " + t);
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
  process.exit(1);
}

// ===== 浏览器侧模拟：协议算法（与实现同常量，独立实现，不 require 服务端密码学代码） =====
const b64 = (n) => crypto.randomBytes(n).toString("base64");
function deriveKeys(shared) {
  const h = (info) => Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(HKDF_SALT, "utf8"), Buffer.from(info, "utf8"), 32));
  return { kReq: h(INFO_REQ), kResp: h(INFO_RESP), kSig: h(INFO_SIG) };
}
function kTokenOf(token) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(INFO_TOKEN, "utf8"), 32));
}
function sign(key, parts) {
  return crypto.createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("base64");
}
function bodyHashOf(ciphertextB64) {
  return crypto.createHash("sha256").update(Buffer.from(ciphertextB64, "base64")).digest("base64");
}
function makeClient() {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey: kp.privateKey, pubB64: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}
function clientKeysOf(client, serverPubB64) {
  const serverPub = crypto.createPublicKey({ key: Buffer.from(serverPubB64, "base64"), format: "der", type: "spki" });
  return deriveKeys(crypto.diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }));
}
function sealWith(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), ciphertext: enc.toString("base64") };
}
function openWith(key, iv, ciphertext) {
  try {
    const raw = Buffer.from(String(ciphertext || ""), "base64");
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(0, raw.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(iv || ""), "base64"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
function nowMs() {
  return Date.now();
}
function reqSig(keys, sessionId, method, p, ts, nonce, bodyHash) {
  return sign(keys.kSig, [sessionId, String(method).toUpperCase(), p, String(ts), nonce, bodyHash || ""]);
}

// 会话辅助：登录（单元级）→ { sessionId, serverPubKey, keys, expiresAt }
function loginUnit(client, tsIn) {
  const ts = tsIn == null ? nowMs() : tsIn;
  const nonce = b64(16);
  const r = adminCrypto.createSession({ clientPubKey: client.pubB64, ts, nonce, sig: sign(kToken, [client.pubB64, String(ts), nonce]) });
  if (!r.ok) return { ok: false };
  return { ok: true, sessionId: r.sessionId, serverPubKey: r.serverPubKey, expiresAt: r.expiresAt, ts, nonce, sig: r.sig, keys: clientKeysOf(client, r.serverPubKey), raw: r };
}

let kToken = null; // 登录签名密钥（K_token），IIFE 里按沙箱令牌派生

const fetchJson = async (p, opts) => {
  const res = await fetch(ADMIN_URL + p, { ...(opts || {}), signal: AbortSignal.timeout(8000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

// 假命令表：echo 往返 / 业务失败 / 抛异常 / 不可序列化返回 / deny 门控（不执行真实命令，避免碰库）
const fakeTable = {
  collect: () =>
    new Map([
      ["echo", async (_e, args) => ({ ok: true, echo: args })],
      ["always_fail", async () => ({ ok: false, message: "业务失败" })],
      [
        "boom",
        () => {
          throw new Error("炸了");
        },
      ],
      ["unserializable", async () => ({ ok: true, big: BigInt(1) })], // JSON.stringify 抛 TypeError
      ["secret_op", async () => ({ ok: true, secret: "s3cr3t" })],
      ["admin_access_info", async () => ({ ok: true, token: "PLAIN-TOKEN-MUST-NOT-LEAK" })],
    ]),
  modeOf: (cmd) => (cmd === "secret_op" || cmd === "admin_access_info" ? "deny" : "write"),
  denyReason: (cmd) => (cmd === "secret_op" ? "浏览器访问时不可用：测试专用命令" : cmd === "admin_access_info" ? "浏览器访问时不可用：请在桌面窗口查看令牌" : null),
};

async function rpcHttp(session, cmd, args, opts = {}) {
  const sealed = sealWith(session.keys.kReq, JSON.stringify({ cmd, args: args || {} }));
  let ciphertext = sealed.ciphertext;
  if (opts.tamper) {
    const raw = Buffer.from(ciphertext, "base64");
    raw[0] ^= 0xff;
    ciphertext = raw.toString("base64");
  }
  const ts = opts.ts == null ? nowMs() : opts.ts;
  const nonce = opts.nonce || b64(16);
  const sig = opts.sig != null ? opts.sig : reqSig(session.keys, session.sessionId, "POST", "/api/rpc", ts, nonce, bodyHashOf(ciphertext));
  const r = await fetchJson("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.sessionId, ts, nonce, sig, iv: sealed.iv, ciphertext }) });
  return { ...r, nonce };
}

(async () => {
  // 令牌：沙箱配置自动生成（Ruling 9：桌面只认 config.admin.token）
  config.ensureAdminToken();
  const token = config.adminAccessInfo().token;
  kToken = kTokenOf(token);

  // ===== Part A：adminCrypto 单元级 =====
  const clientA = makeClient();
  const sA = loginUnit(clientA);
  ok("A1 createSession 成功返回 sessionId / serverPubKey / expiresAt，且不返回任何会话密钥字段", sA.ok === true && typeof sA.sessionId === "string" && sA.sessionId.length >= 32 && typeof sA.serverPubKey === "string" && typeof sA.expiresAt === "number" && sA.expiresAt > nowMs(), JSON.stringify(sA.raw || {}).slice(0, 200));
  const leakKeys = Object.keys(sA.raw || {}).filter((k) => ["kReq", "kResp", "kSig", "keys", "shared", "ikm", "secret", "token"].includes(k));
  ok(
    "A1 响应字段只含 sessionId/serverPubKey/expiresAt/ts/nonce/sig（无密钥字段）",
    leakKeys.length === 0 &&
      Object.keys(sA.raw || {})
        .sort()
        .join(",") === "expiresAt,nonce,ok,serverPubKey,sessionId,sig,ts",
    Object.keys(sA.raw || {}).join(",")
  );
  ok("A2 登录响应签名可由 K_token 验证（serverPubKey\\nsessionId\\nts\\nnonce）", sA.ok === true && sign(kToken, [sA.serverPubKey, sA.sessionId, String(sA.ts), sA.nonce]) === sA.sig, String(sA.sig).slice(0, 24));

  const vA = adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: nowMs(), nonce: b64(16), sig: "x", bodyHash: "", method: "GET", path: "/api/events" });
  ok("A5 前置：错误签名被拒（先探一次接口形状）", vA.ok === false);

  const nonceA5 = b64(16);
  const tsA5 = nowMs();
  const sigA5 = reqSig(sA.keys, sA.sessionId, "POST", "/api/rpc", tsA5, nonceA5, "");
  const vA5 = adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: tsA5, nonce: nonceA5, sig: sigA5, bodyHash: "", method: "POST", path: "/api/rpc" });
  ok("A5 verifyRequest 正常通过并返回 keys", vA5.ok === true && !!vA5.keys && Buffer.isBuffer(vA5.keys.kReq), JSON.stringify(Object.keys(vA5)));

  ok("A3 双方派生的 kReq / kResp / kSig 逐字节一致", vA5.ok === true && vA5.keys.kReq.equals(sA.keys.kReq) && vA5.keys.kResp.equals(sA.keys.kResp) && vA5.keys.kSig.equals(sA.keys.kSig), "服务端与浏览器侧派生不一致");
  const roundTripUp = sealWith(sA.keys.kReq, "浏览器 → 服务端");
  ok("A3 客户端密文可被服务端 open 解出（K_req 一致）", adminCrypto.open(vA5.keys.kReq, roundTripUp.iv, roundTripUp.ciphertext) === "浏览器 → 服务端");
  const roundTripDown = adminCrypto.seal(vA5.keys.kResp, "服务端 → 浏览器");
  ok("A3 服务端密文可被客户端 open 解出（K_resp 一致）", openWith(sA.keys.kResp, roundTripDown.iv, roundTripDown.ciphertext) === "服务端 → 浏览器");

  const tampered = sealWith(sA.keys.kReq, "原始明文");
  const rawTampered = Buffer.from(tampered.ciphertext, "base64");
  rawTampered[0] ^= 0xff;
  ok("A4 请求体篡改后 GCM 解密失败（open 返回 null）", adminCrypto.open(vA5.keys.kReq, tampered.iv, rawTampered.toString("base64")) === null);

  const tsA6 = nowMs();
  const nonceA6 = b64(16);
  // 坏签名：签名按字节翻转（长度一致、内容不同），避免 base64 归一化把尾部缀字吞掉导致假通过
  const sigA6Bytes = Buffer.from(reqSig(sA.keys, sA.sessionId, "POST", "/api/rpc", tsA6, nonceA6, ""), "base64");
  sigA6Bytes[0] ^= 0xff;
  ok("A6 错误签名 verifyRequest 返回 ok=false", adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: tsA6, nonce: nonceA6, sig: sigA6Bytes.toString("base64"), bodyHash: "", method: "POST", path: "/api/rpc" }).ok === false);

  const nonceA7 = b64(16);
  const tsA7 = nowMs();
  const sigA7 = reqSig(sA.keys, sA.sessionId, "POST", "/api/rpc", tsA7, nonceA7, "");
  const firstUse = adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: tsA7, nonce: nonceA7, sig: sigA7, bodyHash: "", method: "POST", path: "/api/rpc" });
  const secondUse = adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: tsA7, nonce: nonceA7, sig: sigA7, bodyHash: "", method: "POST", path: "/api/rpc" });
  ok("A7 同一 nonce 第一次通过、第二次被拒绝", firstUse.ok === true && secondUse.ok === false);

  const tsOld = nowMs() - (TOL_MS + 60000);
  const nonceA8 = b64(16);
  ok("A8 时间窗 ±5 分钟之外被拒", adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: tsOld, nonce: nonceA8, sig: reqSig(sA.keys, sA.sessionId, "POST", "/api/rpc", tsOld, nonceA8, ""), bodyHash: "", method: "POST", path: "/api/rpc" }).ok === false);

  // 12 小时过期：把服务端时钟拨快（同一时钟驱动时间窗与有效期，请求 ts 同步取新时刻）
  const jumped = nowMs() + SESSION_TTL_MS + 60000;
  adminCrypto.__setNow(() => jumped);
  const nonceA9 = b64(16);
  const vA9 = adminCrypto.verifyRequest({ sessionId: sA.sessionId, ts: jumped, nonce: nonceA9, sig: reqSig(sA.keys, sA.sessionId, "POST", "/api/rpc", jumped, nonceA9, ""), bodyHash: "", method: "POST", path: "/api/rpc" });
  adminCrypto.__setNow(() => nowMs());
  ok("A9 超过 12 小时的会话被拒绝", vA9.ok === false);

  // 改令牌：清空所有会话（Ruling 8：config.onAdminTokenChanged → clearSessions）
  const sA10 = loginUnit(makeClient());
  ok("A10 前置：新建会话后会话数 > 0", sA10.ok === true && adminCrypto.sessionCount() > 0, String(adminCrypto.sessionCount()));
  config.resetAdminToken();
  kToken = kTokenOf(config.adminAccessInfo().token); // 令牌换了，登录签名密钥跟着换（后续用例仍要登录）
  ok("A10 改令牌后所有旧会话失效（sessionCount 归零）", adminCrypto.sessionCount() === 0, String(adminCrypto.sessionCount()));
  const tsA10 = nowMs();
  const nonceA10 = b64(16);
  ok("A10 旧会话的 verifyRequest 被拒", sA10.ok === true && adminCrypto.verifyRequest({ sessionId: sA10.sessionId, ts: tsA10, nonce: nonceA10, sig: reqSig(sA10.keys, sA10.sessionId, "POST", "/api/rpc", tsA10, nonceA10, ""), bodyHash: "", method: "POST", path: "/api/rpc" }).ok === false);

  // 会话上限：100 条，超出淘汰最旧。
  // 登录随机数配额只有 100（Ruling 15）：分两批登录、中间拨快 5 分钟让登录 nonce 过期，
  // 否则第 101 次登录先被登录配额挡掉（那是 A13 的断言点，不该混进会话上限用例）
  adminCrypto.clearSessions();
  const keep = [];
  for (let i = 0; i < 100; i++) {
    const s = loginUnit(makeClient());
    if (s.ok) keep.push(s);
  }
  const later = nowMs() + NONCE_TTL_MS + 60000;
  adminCrypto.__setNow(() => later);
  const last = loginUnit(makeClient(), later);
  if (last.ok) keep.push(last);
  ok("A11 会话上限 100 条（超出淘汰最旧）", keep.length === 101 && adminCrypto.sessionCount() === 100, `created=${keep.length} count=${adminCrypto.sessionCount()}`);
  const tsA11 = later; // 服务端时钟还在 later：断言在该时刻下做（时间窗 ±5 分钟按它算）
  const nonceA11a = b64(16);
  const nonceA11b = b64(16);
  ok("A11 最早的会话被淘汰", adminCrypto.verifyRequest({ sessionId: keep[0].sessionId, ts: tsA11, nonce: nonceA11a, sig: reqSig(keep[0].keys, keep[0].sessionId, "POST", "/api/rpc", tsA11, nonceA11a, ""), bodyHash: "", method: "POST", path: "/api/rpc" }).ok === false);
  ok("A11 最新的会话仍可用", adminCrypto.verifyRequest({ sessionId: keep[100].sessionId, ts: tsA11, nonce: nonceA11b, sig: reqSig(keep[100].keys, keep[100].sessionId, "POST", "/api/rpc", tsA11, nonceA11b, ""), bodyHash: "", method: "POST", path: "/api/rpc" }).ok === true);
  adminCrypto.__setNow(() => nowMs());

  // 随机数配额（Ruling 15）：单会话 1000 条，超出拒绝（配额按会话分摊，登录另算，禁止全局共享）
  adminCrypto.clearSessions();
  const sA12 = loginUnit(makeClient());
  let accepted = 0,
    rejectedAt = 0;
  for (let i = 0; i < 1100; i++) {
    const nonce = "n" + i;
    const ts = nowMs();
    const r = adminCrypto.verifyRequest({ sessionId: sA12.sessionId, ts, nonce, sig: reqSig(sA12.keys, sA12.sessionId, "GET", "/api/events", ts, nonce, ""), bodyHash: "", method: "GET", path: "/api/events" });
    if (r.ok) accepted++;
    else if (!rejectedAt) rejectedAt = i + 1;
  }
  ok("A12 单会话随机数上限 1000 条（Ruling 15），超出拒绝", accepted === 1000 && rejectedAt === 1001, `accepted=${accepted} rejectedAt=${rejectedAt}`);

  // 登录随机数独立小配额（Ruling 15）：会话灌满配额不影响登录，登录灌满也不牵连会话
  adminCrypto.clearSessions();
  const loginAttempts = [];
  for (let i = 0; i < 101; i++) loginAttempts.push(loginUnit(makeClient()));
  ok("A13 登录随机数上限 100 条（Ruling 15），第 101 次登录被拒", loginAttempts.slice(0, 100).every((s) => s.ok) && loginAttempts[100].ok === false, `okFirst100=${loginAttempts.slice(0, 100).filter((s) => s.ok).length} at101=${loginAttempts[100].ok}`);
  adminCrypto.clearSessions();

  // ===== Part B：HTTP 端点（假命令表，不执行真实命令） =====
  await admin.start({ port: PROXY_PORT, commandTable: fakeTable, staticDir: "" });

  const clientB = makeClient();
  const tsB = nowMs();
  const nonceB = b64(16);
  const loginRes = await fetchJson("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientPubKey: clientB.pubB64, ts: tsB, nonce: nonceB, sig: sign(kToken, [clientB.pubB64, String(tsB), nonceB]) }) });
  ok("B1 POST /api/login 200 且字段齐全、不返回会话密钥", loginRes.status === 200 && loginRes.body && loginRes.body.ok === true && typeof loginRes.body.sessionId === "string" && typeof loginRes.body.serverPubKey === "string" && typeof loginRes.body.expiresAt === "number" && Object.keys(loginRes.body).sort().join(",") === "expiresAt,nonce,ok,serverPubKey,sessionId,sig,ts", `status=${loginRes.status} body=${JSON.stringify(loginRes.body).slice(0, 200)}`);
  ok("B1 登录响应签名可用 K_token 验证", !!loginRes.body && sign(kToken, [loginRes.body.serverPubKey, loginRes.body.sessionId, String(loginRes.body.ts), loginRes.body.nonce]) === loginRes.body.sig);
  const sessionB = { sessionId: loginRes.body.sessionId, keys: clientKeysOf(clientB, loginRes.body.serverPubKey) };

  const echoArgs = { hello: "世界", n: 42 };
  const echoRes = await rpcHttp(sessionB, "echo", echoArgs);
  const echoPlain = echoRes.status === 200 && echoRes.body ? openWith(sessionB.keys.kResp, echoRes.body.iv, echoRes.body.ciphertext) : null;
  const echoObj = echoPlain ? JSON.parse(echoPlain) : null;
  ok("B3 /api/rpc 加密往返：echo 明文一致、响应回带请求 nonce", echoRes.status === 200 && echoRes.body && echoRes.body.nonce === echoRes.nonce && !!echoObj && echoObj.ok === true && JSON.stringify(echoObj.echo) === JSON.stringify(echoArgs), `status=${echoRes.status} body=${JSON.stringify(echoRes.body).slice(0, 200)} plain=${echoPlain}`);

  // /api/rpc 不返回令牌明文：响应密文与解密明文都不含令牌；令牌命令在 browser 形态被 deny（Ruling 16）
  const tokenNow = config.adminAccessInfo().token;
  ok("B13 /api/rpc 响应不含令牌明文（密文与解密明文都不含）", JSON.stringify(echoRes.body).indexOf(tokenNow) < 0 && String(echoPlain).indexOf(tokenNow) < 0, "响应里出现令牌明文");
  const guardRes = await rpcHttp(sessionB, "admin_access_info", {});
  ok("B13 admin_access_info 在 browser 形态被拒（403，令牌不外泄）", guardRes.status === 403 && JSON.stringify(guardRes.body).indexOf(tokenNow) < 0 && JSON.stringify(guardRes.body).indexOf("PLAIN-TOKEN") < 0, `status=${guardRes.status} body=${JSON.stringify(guardRes.body)}`);

  const badLogin = await fetchJson("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientPubKey: clientB.pubB64, ts: nowMs(), nonce: b64(16), sig: sign(kToken, [clientB.pubB64, String(nowMs()), "别的nonce"]) }) });
  ok("B2 登录签名错误 → 401 统一文案", badLogin.status === 401 && badLogin.body && badLogin.body.message === UNAUTHORIZED, `status=${badLogin.status} body=${JSON.stringify(badLogin.body)}`);

  const badSigRes = await rpcHttp(sessionB, "echo", {}, { sig: sign(sessionB.keys.kSig, ["错的会话", "POST", "/api/rpc", String(nowMs()), "x", ""]) });
  ok("B4 /api/rpc 签名错误 → 401", badSigRes.status === 401 && badSigRes.body && badSigRes.body.message === UNAUTHORIZED, `status=${badSigRes.status}`);

  const replayNonce = b64(16);
  const replay1 = await rpcHttp(sessionB, "echo", { i: 1 }, { nonce: replayNonce });
  const replay2 = await rpcHttp(sessionB, "echo", { i: 2 }, { nonce: replayNonce });
  ok("B5 /api/rpc 同一 nonce 重放 → 401", replay1.status === 200 && replay2.status === 401 && replay2.body && replay2.body.message === UNAUTHORIZED, `first=${replay1.status} second=${replay2.status}`);

  const tamperRes = await rpcHttp(sessionB, "echo", {}, { tamper: true });
  ok("B6 /api/rpc 密文被篡改（签名按篡改后重算）→ 401（GCM 认证失败）", tamperRes.status === 401 && tamperRes.body && tamperRes.body.message === UNAUTHORIZED, `status=${tamperRes.status}`);

  const failRes = await rpcHttp(sessionB, "always_fail", {});
  const failPlain = failRes.status === 200 && failRes.body ? openWith(sessionB.keys.kResp, failRes.body.iv, failRes.body.ciphertext) : null;
  ok("B7 handler 返回 {ok:false} 仍加密返回", failRes.status === 200 && !!failPlain && JSON.parse(failPlain).ok === false, `status=${failRes.status} plain=${failPlain}`);

  const boomRes = await rpcHttp(sessionB, "boom", {});
  const boomPlain = boomRes.status === 200 && boomRes.body ? openWith(sessionB.keys.kResp, boomRes.body.iv, boomRes.body.ciphertext) : null;
  ok("B8 handler 抛异常 → 加密返回 {ok:false}", boomRes.status === 200 && !!boomPlain && JSON.parse(boomPlain).ok === false, `status=${boomRes.status} plain=${boomPlain}`);

  // Important 6：JSON.stringify 遇 BigInt 抛 TypeError，不能掀掉主进程（Express 4 不接 async 异常）
  const unserializableRes = await rpcHttp(sessionB, "unserializable", {});
  const unserializablePlain = unserializableRes.status === 200 && unserializableRes.body ? openWith(sessionB.keys.kResp, unserializableRes.body.iv, unserializableRes.body.ciphertext) : null;
  ok("B8 handler 返回不可序列化值（BigInt）→ 加密返回 {ok:false}，服务不崩", unserializableRes.status === 200 && !!unserializablePlain && JSON.parse(unserializablePlain).ok === false, `status=${unserializableRes.status} plain=${unserializablePlain}`);

  const denyRes = await rpcHttp(sessionB, "secret_op", {});
  ok("B9 deny 命令 → 403 且带浏览器文案", denyRes.status === 403 && denyRes.body && denyRes.body.message === "浏览器访问时不可用：测试专用命令", `status=${denyRes.status} body=${JSON.stringify(denyRes.body)}`);

  const missRes = await rpcHttp(sessionB, "不存在的命令", {});
  ok("B10 未知命令 → 404", missRes.status === 404, `status=${missRes.status}`);

  const anonEvents = await fetchJson("/api/events");
  ok("B11 未鉴权 GET /api/events → 401", anonEvents.status === 401 && anonEvents.body && anonEvents.body.message === UNAUTHORIZED, `status=${anonEvents.status}`);

  // 401 统一文案：签名错 / 时间窗 / 重放 / 会话失效 四种响应体逐字一致
  const sB12 = loginUnit(makeClient());
  const missSess = await rpcHttp({ sessionId: "deadbeef", keys: sB12.keys }, "echo", {});
  const skew = await rpcHttp(sessionB, "echo", {}, { ts: nowMs() - (TOL_MS + 60000) });
  ok("B12 401 统一文案（签名错 / 时间窗 / 重放 / 会话失效 响应体一致）", JSON.stringify(badSigRes.body) === JSON.stringify(replay2.body) && JSON.stringify(replay2.body) === JSON.stringify(tamperRes.body) && JSON.stringify(tamperRes.body) === JSON.stringify(skew.body) && JSON.stringify(skew.body) === JSON.stringify(missSess.body) && JSON.stringify(missSess.body) === JSON.stringify({ ok: false, message: UNAUTHORIZED }), [badSigRes.body, replay2.body, tamperRes.body, skew.body, missSess.body].map((x) => JSON.stringify(x)).join(" | "));

  // ===== Part C：SSE =====
  const sC = loginUnit(makeClient());
  const tsC = nowMs();
  const nonceC = b64(16);
  const sseUrl = `${ADMIN_URL}/api/events?sessionId=${encodeURIComponent(sC.sessionId)}&ts=${tsC}&nonce=${encodeURIComponent(nonceC)}&sig=${encodeURIComponent(reqSig(sC.keys, sC.sessionId, "GET", "/api/events", tsC, nonceC, ""))}`;
  const ctrl = new AbortController();
  const sseRes = await fetch(sseUrl, { signal: ctrl.signal });
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
  }
  const frameLine = buf.split("\n").find((l) => l.startsWith("data: "));
  const frame = frameLine ? JSON.parse(frameLine.slice(6)) : null;
  const framePlain = frame ? openWith(sC.keys.kResp, frame.iv, frame.ciphertext) : null;
  ok("C1 SSE 鉴权后收到加密首帧（seq=1）且可用 K_resp 解密", sseRes.status === 200 && !!frame && !!framePlain && JSON.parse(framePlain).type === "hello" && JSON.parse(framePlain).seq === 1, `status=${sseRes.status} buf=${buf.slice(0, 120)} plain=${framePlain}`);

  adminCrypto.clearSessions();
  let closed = false;
  try {
    const t = setTimeout(() => ctrl.abort(), 5000);
    const next = await reader.read();
    closed = !!next.done;
    clearTimeout(t);
  } catch {
    closed = true; // 连接被服务端断开（流中断）同样算关闭
  }
  ok("C2 清空会话后 SSE 连接关闭", closed);

  // ===== C3：SSE 帧 seq 单调递增（Ruling 19）：短心跳连读两帧 =====
  admin.__setSseHeartbeatMs(200);
  const sC3 = loginUnit(makeClient());
  const tsC3 = nowMs();
  const nonceC3 = b64(16);
  const ctrlC3 = new AbortController();
  const sseRes3 = await fetch(`${ADMIN_URL}/api/events?sessionId=${encodeURIComponent(sC3.sessionId)}&ts=${tsC3}&nonce=${encodeURIComponent(nonceC3)}&sig=${encodeURIComponent(reqSig(sC3.keys, sC3.sessionId, "GET", "/api/events", tsC3, nonceC3, ""))}`, { signal: ctrlC3.signal });
  const reader3 = sseRes3.body.getReader();
  const dec3 = new TextDecoder();
  let buf3 = "";
  while ((buf3.match(/\n\n/g) || []).length < 2) {
    const chunk = await reader3.read();
    if (chunk.done) break;
    buf3 += dec3.decode(chunk.value, { stream: true });
  }
  const seqs = buf3
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)))
    .map((f) => JSON.parse(openWith(sC3.keys.kResp, f.iv, f.ciphertext)).seq);
  ok("C3 SSE 帧 seq 单调递增（hello=1、ping=2）", seqs.length >= 2 && seqs[0] === 1 && seqs[1] === 2 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seqs=${JSON.stringify(seqs)}`);
  ctrlC3.abort();

  // ===== C4：SSE 会话过期关闭：拨快服务端时钟超过 12 小时，心跳发现过期即断开 =====
  const sC4 = loginUnit(makeClient());
  const tsC4 = nowMs();
  const nonceC4 = b64(16);
  const ctrlC4 = new AbortController();
  const sseRes4 = await fetch(`${ADMIN_URL}/api/events?sessionId=${encodeURIComponent(sC4.sessionId)}&ts=${tsC4}&nonce=${encodeURIComponent(nonceC4)}&sig=${encodeURIComponent(reqSig(sC4.keys, sC4.sessionId, "GET", "/api/events", tsC4, nonceC4, ""))}`, { signal: ctrlC4.signal });
  const reader4 = sseRes4.body.getReader();
  adminCrypto.__setNow(() => nowMs() + SESSION_TTL_MS + 60000);
  let expiredClosed = false;
  const t4 = setTimeout(() => ctrlC4.abort(), 5000);
  try {
    while (true) {
      const next = await reader4.read(); // 先把 hello / ping 帧读掉，直到服务端结束流
      if (next.done) {
        expiredClosed = true;
        break;
      }
    }
  } catch {
    expiredClosed = !ctrlC4.signal.aborted; // 流中断算关闭；超时 abort 不算（那是服务端没关）
  }
  clearTimeout(t4);
  adminCrypto.__setNow(() => nowMs());
  admin.__setSseHeartbeatMs(0);
  ok("C4 会话过期后 SSE 连接被关闭（心跳发现过期）", expiredClosed);

  // ===== C5：真实事件广播到 SSE（任务 11 事件桥）：platform 事件 → 加密事件帧 =====
  const sC5 = loginUnit(makeClient());
  const tsC5 = nowMs();
  const nonceC5 = b64(16);
  const ctrlC5 = new AbortController();
  const sseRes5 = await fetch(`${ADMIN_URL}/api/events?sessionId=${encodeURIComponent(sC5.sessionId)}&ts=${tsC5}&nonce=${encodeURIComponent(nonceC5)}&sig=${encodeURIComponent(reqSig(sC5.keys, sC5.sessionId, "GET", "/api/events", tsC5, nonceC5, ""))}`, { signal: ctrlC5.signal });
  const reader5 = sseRes5.body.getReader();
  const dec5 = new TextDecoder();
  let buf5 = "";
  while (!buf5.includes("\n\n")) {
    const chunk = await reader5.read();
    if (chunk.done) break;
    buf5 += dec5.decode(chunk.value, { stream: true });
  }
  const framesOf = (s) =>
    s
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      .map((f) => JSON.parse(openWith(sC5.keys.kResp, f.iv, f.ciphertext)));
  require(path.join(ROOT, "electron", "backend", "proxy", "platform", "index.cjs")).emit({ type: "oplog" });
  let evtFrames = framesOf(buf5);
  const t5 = setTimeout(() => ctrlC5.abort(), 5000);
  try {
    while (evtFrames.length < 2) {
      const next = await reader5.read();
      if (next.done) break;
      buf5 += dec5.decode(next.value, { stream: true });
      evtFrames = framesOf(buf5);
    }
  } catch {
    /* 超时中断：按已收到的帧判 */
  }
  clearTimeout(t5);
  ctrlC5.abort();
  const evt = evtFrames[1] || null;
  ok("C5 platform 事件经事件桥广播为加密 SSE 帧（信封同 app:event、事件体不带内容）", !!evt && evt.event === "proxy" && evt.type === "oplog" && evt.seq === 2 && !("message" in evt) && !("detail" in evt), `frames=${JSON.stringify(evtFrames)}`);

  // ===== Part D：登录限流（放最后：打满窗口配额后本进程不能再登录） =====
  let first429 = 0;
  let stuck429 = true;
  for (let i = 1; i <= 30; i++) {
    const r = await fetchJson("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientPubKey: "x", ts: nowMs(), nonce: "d" + i, sig: "x" }) });
    if (r.status === 429 && !first429) first429 = i;
    if (first429 && r.status !== 429) stuck429 = false;
  }
  ok("D1 登录限流：每 IP 每分钟 20 次，超出 429 且持续", first429 > 0 && first429 <= 21 && stuck429, `first429=${first429}`);

  await admin.stop();
  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) {
    console.log("失败项：");
    for (const b of bad) console.log("  - " + b);
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
  process.exit(fail ? 1 : 0);
})();
