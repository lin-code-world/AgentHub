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
// 浏览器端加密传输层自测（任务 7）：src/api/adminCrypto.ts（WebCrypto 的 ECDH/HKDF/HMAC/AES-GCM）
// 与 src/api/events.ts（fetch 流 SSE + 断线重签）在 Node 下跑通真实服务端 electron/backend/admin.cjs。
// Node 没有浏览器模块加载器：用 esbuild 把 TS 编译成 CJS 后经 Module._extensions[".ts"] 直接 require 源文件，
// 测的是真实实现而不是副本；localStorage 以假存储注入 globalThis，SSE 流用 ReadableStream 造假响应。
// 协议常量在本文件逐字写死（与 electron/backend/adminCrypto.cjs 逐字对齐，谁改协议两边一起改）。
// 覆盖：
//   S1  登录后 localStorage 只有 sessionId / 密钥 / 登录时间，不含令牌
//   S2  登录响应签名被篡改 → 拒绝，不落会话
//   S3  /api/rpc 请求体是密文（不含明文 cmd 与参数值）
//   S4  加密往返：echo 明文一致
//   S5  响应回带 nonce 不符 → 判失败（清会话 + 跳登录）
//   S6  响应密文被篡改 → GCM 解密失败（清会话 + 跳登录）
//   S7  401 → 清会话 + 可注入跳转函数被调，错误文案不泄漏校验细节
//   S8  SSE 帧 seq 严格递增：跳帧 / 重放被拒，新解码器基线清零
//   S9  SSE 重连后 seq 基线清零（重连首帧 seq=1 不被误判跳帧，Ruling 19）
//   S10 一次性签名 eventsUrl 可连真实 /api/events，首帧 seq=1 可解密
//   S11 本地会话过期判断（登录时间超 12 小时 → hasSession false）
//   S12 旧版令牌存储（agenthub.adminToken）登录后被清除
//   S13 屏蔽 crypto.subtle（模拟局域网 http 非安全上下文）下，登录 / 请求加解密 / SSE 帧解密仍可用（Ruling 20）
// 全程屏蔽 globalThis.crypto.subtle（浏览器在 http://IP 非安全上下文下不暴露 WebCrypto），
// S1~S13 都在「无 WebCrypto」环境下跑，S13 再独立断言一次。
// 沙箱：AGENTHUB_DATA_DIR 指向临时目录。用法：node tools/admin-crypto-browser-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-adminbrowser-"));
process.env.AGENTHUB_DATA_DIR = path.join(SANDBOX, "data");

const PROXY_PORT = 19847; // 管理端口 = 反代端口 + 1
const ADMIN_URL = `http://127.0.0.1:${PROXY_PORT + 1}`;

// ===== 协议常量（与 electron/backend/adminCrypto.cjs 逐字对齐） =====
const SESSION_KEY = "agenthub.adminSession";
const LEGACY_TOKEN_KEY = "agenthub.adminToken";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

const EXPECTED = ["S1 登录后 localStorage 只有 sessionId / 密钥 / 登录时间，不含令牌", "S2 登录响应签名被篡改 → 拒绝，不落会话", "S3 /api/rpc 请求体是密文（不含明文 cmd 与参数值）", "S4 加密往返：echo 明文一致", "S5 响应回带 nonce 不符 → 判失败（清会话 + 跳登录）", "S6 响应密文被篡改 → GCM 解密失败（清会话 + 跳登录）", "S7 401 → 清会话 + 可注入跳转函数被调，错误文案不泄漏校验细节", "S8 SSE 帧 seq 严格递增：跳帧 / 重放被拒，新解码器基线清零", "S9 SSE 重连后 seq 基线清零（重连首帧 seq=1 不被误判跳帧）", "S10 一次性签名 eventsUrl 可连真实 /api/events，首帧 seq=1 可解密", "S11 本地会话过期判断（登录时间超 12 小时 → hasSession false）", "S12 旧版令牌存储（agenthub.adminToken）登录后被清除", "S13 屏蔽 crypto.subtle（模拟局域网 http 非安全上下文）下登录 / 请求加解密 / SSE 帧解密仍可用（Ruling 20）"];

// ===== TS 源文件直载：esbuild 编译成 CJS 后经 require.extensions 挂载 =====
function installTsLoader() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  Module._extensions[".ts"] = (mod, file) => {
    const src = fs.readFileSync(file, "utf8");
    const out = esbuild.transformSync(src, { loader: "ts", format: "cjs", sourcefile: file }).code;
    mod._compile(out, file);
  };
}

// ===== 假 localStorage（Node 无 localStorage） =====
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(String(k)),
    clear: () => void map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map),
  };
}
const storage = makeStorage();
globalThis.localStorage = storage;

// ===== 浏览器侧协议算法（独立实现，与服务端对齐；造假 SSE 帧用） =====
function sealWith(keyBuf, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), ciphertext: enc.toString("base64") };
}

// ===== fetch 辅助 =====
const realFetch = (...a) => globalThis.fetch(...a);
const abs = (url) => new URL(String(url), ADMIN_URL).toString();
// Node 的 fetch 不接受相对 URL（浏览器里才解析）：测试装置统一转发绝对地址，业务逻辑照测
const relayFetch = (url, init) => realFetch(abs(url), init);

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** 读响应文本后按函数改写 JSON，返回新 Response（篡改响应体用） */
async function rewriteJson(res, fn) {
  const obj = JSON.parse(await res.text());
  const next = fn(obj) || obj;
  return jsonResponse(res.status, next);
}

function sseStreamResponse(frames) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode("data: " + JSON.stringify(f) + "\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

const fakeTable = {
  collect: () => new Map([["echo_secret_probe", async (_e, args) => ({ ok: true, echo: args })]]),
  modeOf: () => "write",
  denyReason: () => null,
};

(async () => {
  // 模拟局域网 http 非安全上下文：屏蔽 crypto.subtle（浏览器在 http://IP 下不暴露 WebCrypto，getRandomValues 保留），
  // 整个自测在「无 WebCrypto」环境下跑，S13 再独立断言一次（Ruling 20：纯 JS 密码库不依赖 WebCrypto）
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }, configurable: true });
  installTsLoader();
  let adminCrypto = null,
    eventsApi = null,
    admin = null,
    config = null;
  try {
    adminCrypto = require(path.join(ROOT, "src", "api", "adminCrypto.ts"));
    eventsApi = require(path.join(ROOT, "src", "api", "events.ts"));
    admin = require(path.join(ROOT, "electron", "backend", "admin.cjs"));
    config = require(path.join(ROOT, "electron", "backend", "config.cjs"));
  } catch (e) {
    console.log("RED：浏览器传输层模块加载失败（实现前预期）：" + String((e && e.message) || e));
    console.log("预期断言（实现后应全绿）：");
    for (const t of EXPECTED) console.log("  - " + t);
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* 沙箱残留不影响结论 */
    }
    process.exit(1);
  }

  // 令牌：沙箱配置自动生成（Ruling 9：桌面只认 config.admin.token）
  config.ensureAdminToken();
  const TOKEN = config.adminAccessInfo().token;
  await admin.start({ port: PROXY_PORT, commandTable: fakeTable, staticDir: "" });

  // 跳转函数注入：401 清会话后回登录页的动作（浏览器里是 reload），这里计数断言
  let navCount = 0;
  adminCrypto.__setFetch(relayFetch);
  adminCrypto.__setNavigate(() => {
    navCount++;
  });
  const sessRaw = () => storage.getItem(SESSION_KEY);
  const sessOf = () => JSON.parse(sessRaw() || "null");

  // ===== S2：登录响应签名被篡改 → 拒绝，不落会话 =====
  console.log("S2 登录响应签名校验");
  adminCrypto.__setFetch(async (url, init) => {
    const res = await relayFetch(url, init);
    return rewriteJson(res, (obj) => {
      const raw = Buffer.from(String(obj.sig || ""), "base64");
      if (raw.length) {
        raw[0] ^= 0xff;
        obj.sig = raw.toString("base64");
      }
      return obj;
    });
  });
  let s2err = "";
  try {
    await adminCrypto.login(TOKEN);
  } catch (e) {
    s2err = String((e && e.message) || e);
  }
  adminCrypto.__setFetch(relayFetch);
  ok("S2 登录响应签名被篡改 → login 失败", s2err.length > 0 && sessRaw() === null, `err=${s2err}`);

  // ===== S1 / S12：登录后 localStorage 只有 sessionId / 密钥 / 登录时间，不含令牌 =====
  console.log("S1 登录落盘内容");
  storage.setItem(LEGACY_TOKEN_KEY, "LEGACY-TOKEN-MUST-GONE"); // 旧版令牌存储：登录后必须被清
  await adminCrypto.login(TOKEN);
  const keys1 = Object.keys(storage._dump());
  ok("S1 登录后 localStorage 只有会话一个键", keys1.join(",") === SESSION_KEY, keys1.join(","));
  const sess1 = sessOf();
  ok("S1 会话只含 sessionId / 密钥 / 登录时间", !!sess1 && Object.keys(sess1).sort().join(",") === "keys,loginAt,sessionId" && typeof sess1.sessionId === "string" && !!sess1.sessionId && typeof sess1.loginAt === "number" && !!sess1.keys && Object.keys(sess1.keys).sort().join(",") === "kReq,kResp,kSig", JSON.stringify(sess1 ? Object.keys(sess1) : null));
  const dump1 = JSON.stringify(storage._dump());
  ok("S1 不含令牌明文（令牌登录后即丢弃）", dump1.indexOf(TOKEN) < 0, "令牌出现在 localStorage");
  ok("S12 旧版令牌存储（agenthub.adminToken）被清除", storage.getItem(LEGACY_TOKEN_KEY) === null);

  // ===== S3 / S4：请求体是密文 + 加密往返 =====
  console.log("S3/S4 /api/rpc 密文请求与往返");
  let captured = null;
  adminCrypto.__setFetch(async (url, init) => {
    if (String(url).indexOf("/api/rpc") >= 0) captured = { url: String(url), body: String(init.body) };
    return relayFetch(url, init);
  });
  const echoArgs = { secretArg: "SECRET-明文参数-XYZ", hello: "世界", n: 42 };
  const echoRes = await adminCrypto.request("echo_secret_probe", echoArgs);
  adminCrypto.__setFetch(relayFetch);
  const bodyKeys = captured ? Object.keys(JSON.parse(captured.body)).sort().join(",") : "";
  ok("S3 请求体字段恰为 ciphertext/iv/nonce/sessionId/sig/ts", bodyKeys === "ciphertext,iv,nonce,sessionId,sig,ts", `keys=${bodyKeys} body=${String((captured && captured.body) || "").slice(0, 160)}`);
  ok("S3 请求体不含明文 cmd 与参数值", !!captured && captured.body.indexOf("echo_secret_probe") < 0 && captured.body.indexOf("SECRET-明文参数-XYZ") < 0 && captured.body.indexOf("secretArg") < 0 && captured.body.indexOf("世界") < 0, `body=${String((captured && captured.body) || "").slice(0, 160)}`);
  ok("S4 加密往返：解密结果与请求明文一致", !!echoRes && echoRes.ok === true && JSON.stringify(echoRes.echo) === JSON.stringify(echoArgs), JSON.stringify(echoRes));

  // ===== S5：响应回带 nonce 不符 → 判失败（清会话 + 跳登录） =====
  console.log("S5 响应回带 nonce 校验");
  await adminCrypto.login(TOKEN);
  const nav5 = navCount;
  adminCrypto.__setFetch(async (url, init) => {
    const res = await relayFetch(url, init);
    return rewriteJson(res, (obj) => {
      obj.nonce = "NOT-THE-REQUEST-NONCE";
      return obj;
    });
  });
  let s5err = "";
  try {
    await adminCrypto.request("echo_secret_probe", { x: 1 });
  } catch (e) {
    s5err = String((e && e.message) || e);
  }
  adminCrypto.__setFetch(relayFetch);
  ok("S5 nonce 不符 → 请求失败", s5err.length > 0, `err=${s5err}`);
  ok("S5 nonce 不符 → 清会话并跳登录", sessRaw() === null && !adminCrypto.hasSession() && navCount === nav5 + 1, `nav=${navCount - nav5} sess=${sessRaw()}`);

  // ===== S6：响应密文被篡改 → GCM 解密失败（清会话 + 跳登录） =====
  console.log("S6 响应密文篡改");
  await adminCrypto.login(TOKEN);
  const nav6 = navCount;
  adminCrypto.__setFetch(async (url, init) => {
    const res = await relayFetch(url, init);
    return rewriteJson(res, (obj) => {
      const raw = Buffer.from(String(obj.ciphertext || ""), "base64");
      raw[0] ^= 0xff;
      obj.ciphertext = raw.toString("base64");
      return obj;
    });
  });
  let s6err = "";
  try {
    await adminCrypto.request("echo_secret_probe", { x: 2 });
  } catch (e) {
    s6err = String((e && e.message) || e);
  }
  adminCrypto.__setFetch(relayFetch);
  ok("S6 密文篡改 → 请求失败（GCM 认证不过）", s6err.length > 0, `err=${s6err}`);
  ok("S6 密文篡改 → 清会话并跳登录", sessRaw() === null && navCount === nav6 + 1, `nav=${navCount - nav6} sess=${sessRaw()}`);

  // ===== S10：一次性签名 eventsUrl 可连真实 /api/events，首帧 seq=1 可解密 =====
  console.log("S10 真实 SSE 互通");
  await adminCrypto.login(TOKEN);
  const urlA = await adminCrypto.eventsUrl();
  const urlB = await adminCrypto.eventsUrl();
  ok("S10 eventsUrl 每次重签（一次性 nonce）", urlA !== urlB && urlA.indexOf("/api/events?sessionId=") === 0, `a=${urlA} b=${urlB}`);
  const ctrl10 = new AbortController();
  const sseRes = await realFetch(abs(urlA), { signal: ctrl10.signal });
  const reader10 = sseRes.body.getReader();
  const dec10 = new TextDecoder();
  let buf10 = "";
  while (buf10.indexOf("\n\n") < 0) {
    const chunk = await reader10.read();
    if (chunk.done) break;
    buf10 += dec10.decode(chunk.value, { stream: true });
  }
  ctrl10.abort();
  const line10 = buf10.split("\n").find((l) => l.startsWith("data:"));
  const frame10 = line10 ? JSON.parse(line10.slice(5).trim()) : null;
  const payload10 = frame10 ? await adminCrypto.createEventFrameDecoder()(frame10) : null;
  ok("S10 真实 SSE 首帧可解密且 seq=1（hello）", sseRes.status === 200 && !!payload10 && payload10.type === "hello" && payload10.seq === 1, `status=${sseRes.status} buf=${buf10.slice(0, 120)} payload=${JSON.stringify(payload10)}`);

  // ===== S8：SSE 帧 seq 严格递增，跳帧 / 重放被拒，新解码器基线清零 =====
  console.log("S8 SSE 帧 seq 校验");
  const kResp = Buffer.from(sessOf().keys.kResp, "base64");
  const frameOf = (seq, type) => sealWith(kResp, JSON.stringify({ type: type || "ping", seq, ts: Date.now() }));
  const decode8 = adminCrypto.createEventFrameDecoder();
  ok("S8 seq 严格递增依次接受", ((await decode8(frameOf(1, "hello"))) || {}).seq === 1 && ((await decode8(frameOf(2))) || {}).seq === 2);
  ok("S8 跳帧被拒（seq=5 ≠ 3）", (await decode8(frameOf(5))) === null);
  ok("S8 重放被拒（旧 seq=2）", (await decode8(frameOf(2))) === null);
  ok("S8 新解码器基线清零（接受 seq=1）", ((await adminCrypto.createEventFrameDecoder()(frameOf(1, "hello"))) || {}).seq === 1);

  // ===== S9：SSE 重连后 seq 基线清零（连接 2 的首帧 seq=1 不被误判跳帧） =====
  console.log("S9 SSE 重连基线清零");
  const seen = [];
  let conns = 0;
  adminCrypto.__setFetch(async () => {
    conns++;
    return sseStreamResponse(conns === 1 ? [frameOf(1, "hello"), frameOf(2)] : [frameOf(1, "hello")]);
  });
  const unsub = eventsApi.subscribeWebEvents((p) => seen.push(p));
  await waitFor(() => seen.length >= 3, 6000);
  unsub();
  adminCrypto.__setFetch(relayFetch);
  ok("S9 重连后 seq 基线清零：重连首帧（seq=1）被接受", seen.length >= 3 && seen[2] && seen[2].seq === 1, `conns=${conns} seqs=${JSON.stringify(seen.map((p) => p && p.seq))}`);

  // ===== S11：本地会话过期判断 =====
  console.log("S11 本地会话过期");
  const sess11 = sessOf();
  sess11.loginAt = Date.now() - (SESSION_TTL_MS + 60000);
  storage.setItem(SESSION_KEY, JSON.stringify(sess11));
  ok("S11 登录时间超 12 小时 → hasSession false", adminCrypto.hasSession() === false);
  storage.removeItem(SESSION_KEY);

  // ===== S7：401 → 清会话 + 跳转函数被调，文案不泄漏校验细节 =====
  console.log("S7 401 清会话跳登录");
  await adminCrypto.login(TOKEN);
  const sess7 = sessOf();
  sess7.sessionId = "deadbeef".repeat(6); // 服务端不认识的会话号：请求必然 401
  storage.setItem(SESSION_KEY, JSON.stringify(sess7));
  const nav7 = navCount;
  let s7err = "";
  try {
    await adminCrypto.request("echo_secret_probe", { x: 3 });
  } catch (e) {
    s7err = String((e && e.message) || e);
  }
  ok("S7 401 → 清会话", sessRaw() === null && !adminCrypto.hasSession(), `sess=${sessRaw()}`);
  ok("S7 401 → 可注入跳转函数被调用一次", navCount === nav7 + 1, `nav=${navCount - nav7}`);
  ok("S7 401 错误文案统一、不泄漏校验细节", s7err.length > 0 && !/签名|nonce|重放|时间窗|篡改|sig|hash|GCM/i.test(s7err), `err=${s7err}`);

  // ===== S13：屏蔽 crypto.subtle 后（非安全上下文）全链路仍可用（Ruling 20：纯 JS 密码库） =====
  console.log("S13 非安全上下文（无 crypto.subtle）");
  ok("S13 屏蔽生效：crypto.subtle 不存在（模拟局域网 http 非安全上下文）", typeof (globalThis.crypto && globalThis.crypto.subtle) === "undefined");
  await adminCrypto.login(TOKEN);
  const r13 = await adminCrypto.request("echo_secret_probe", { ctx: "insecure-web" });
  ok("S13 无 WebCrypto 下登录 + 请求加解密往返成功", !!r13 && r13.ok === true && JSON.stringify(r13.echo) === JSON.stringify({ ctx: "insecure-web" }), JSON.stringify(r13));
  const k13 = Buffer.from(sessOf().keys.kResp, "base64");
  const payload13 = await adminCrypto.createEventFrameDecoder()(sealWith(k13, JSON.stringify({ type: "hello", seq: 1, ts: Date.now() })));
  ok("S13 无 WebCrypto 下 SSE 帧解密成功", !!payload13 && payload13.seq === 1, JSON.stringify(payload13));

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
