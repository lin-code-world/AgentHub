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
// 管理服务：局域网浏览器访问的 HTTP 入口（Express），监听 0.0.0.0，端口 = 反代端口 + 1。
// 挂载面：/api/capabilities、/api/status（公开只读）；/api/login、/api/rpc、/api/events 走 adminCrypto 的
// ECDH 会话鉴权（登录协商 → 请求签名 → AES-256-GCM 密文），鉴权失败一律 401 统一文案，不区分失败原因。
// 命令清单与 /api/rpc 门控按 browser 形态下发（modeOf/denyReason 的 form 参数，文案见 commandTable.cjs）。
//
// 结构上只依赖注入的 commandTable（collect/modeOf/denyReason）、adminCrypto 的会话鉴权与
// proxy/server.cjs 的轻量 status() 读数，不碰反代转发、选号、冷却、鉴权、计费：
// start({ port, commandTable, staticDir }) 的 port 是**反代端口**（监听 port + 1），返回实际监听端口，
// 容器形态（gateway）后续只换注入的命令表与 staticDir 即可复用。
// start/stop 在模块内串行化：并发调用若先检查后赋值，会两个都 listen、stop 只关一个（端口泄漏）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const adminCrypto = require("./adminCrypto.cjs");

let server = null; // http.Server：运行中的管理服务
let listenPort = 0; // 当前监听端口（= 反代端口 + 1），未启动为 0

// 401 统一文案：令牌错误 / 签名错误 / 时间窗过期 / 随机数重放 / 会话失效 / 密文被篡改，一律同一句话
const UNAUTHORIZED = "未授权";
const SSE_HEARTBEAT_MS = 25000; // SSE 心跳（加密帧），同时顺带检查会话是否已过期

/** 反代端口 → 管理端口：0 / 65535 / 非整数拒绝（+1 后无意义或越界），错误带 code 便于调用方分辨 */
function adminPortOf(proxyPort) {
  const p = Number(proxyPort);
  if (!Number.isInteger(p) || p < 1 || p > 65534) {
    const e = new Error(`反代端口 ${proxyPort} 非法：管理服务端口 = 反代端口 + 1，反代端口需为 1~65534 的整数（0 与 65535 均不可用）`);
    e.code = "EADMINPORT";
    throw e;
  }
  return p + 1;
}

/** 运行形态（平台铁律同 proxy/platform/index.cjs）：ELECTRON_RUN_AS_NODE 下 electron API 全不可用，按 node 处理 */
function platformForm() {
  return process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? "electron" : "node";
}

/** 应用版本：electron 形态取 app.getVersion()，纯 node（容器/自测）取不到给空串 */
function appVersion() {
  try {
    return String(require("electron").app.getVersion());
  } catch {
    return "";
  }
}

/** 模块归属：proxy_* → proxy，框架命令（load_config 等）→ app */
function modulesOf(commands) {
  return [...new Set([...commands.keys()].map((cmd) => (cmd.startsWith("proxy_") ? "proxy" : "app")))].sort();
}

/** /api/capabilities 载荷：命令清单按 browser 形态算（deny 集合同 container，文案换浏览器口径） */
function capabilitiesOf(commands, commandTable) {
  const out = {};
  for (const cmd of commands.keys()) {
    const mode = commandTable.modeOf(cmd, "browser");
    out[cmd] = mode === "deny" ? { mode, reason: commandTable.denyReason(cmd, "browser") } : { mode };
  }
  return {
    ok: true,
    form: "browser",
    platform: platformForm(),
    version: appVersion(),
    modules: modulesOf(commands),
    // 浏览器边界声明：服务启停 / 文件对话框在浏览器形态不可用；SSE 加密通道已提供（/api/events，
    // 事件源与浏览器侧解码留到任务 11）
    features: { serviceControl: false, sse: true, fileDialog: false },
    commands: out,
  };
}

/** /api/status 载荷：轻量状态（Ruling 14）——running / port / bind / version。
 *  只读 proxy/server.cjs 的 status()（内存读数，不碰库），不跑全量 proxy_status：
 *  无鉴权的公开端点不能每个请求都做 DB 统计 + 每渠道 poolSummary + listKeys，渠道 / Key / 用量
 *  等带鉴权后再下发。server 未加载或读数异常时降级为未运行 */
function statusOf() {
  let gateway = { running: false, port: 0, bind: "" };
  try {
    const s = require("./proxy/server.cjs").status();
    gateway = { running: !!s.running, port: Number(s.port || 0), bind: String(s.bind || "") };
  } catch {
    /* server 不可用时按未运行降级 */
  }
  return { ok: true, form: "browser", platform: platformForm(), version: appVersion(), gateway };
}

/** 鉴权失败统一响应：不区分令牌错误 / 签名错误 / 时间窗过期 / 随机数重放 / 会话失效 / 密文被篡改 */
function unauthorized(res) {
  return res.status(401).json({ ok: false, message: UNAUTHORIZED });
}

// ===== SSE 长连接登记：改令牌清空会话时要连带关掉（否则旧会话的流还在推数据） =====
const sseClients = new Set(); // { res, timer, sessionId }

function sendFrame(client, keys, payload) {
  try {
    const sealed = adminCrypto.seal(keys.kResp, JSON.stringify(payload));
    client.res.write(`data: ${JSON.stringify({ iv: sealed.iv, ciphertext: sealed.ciphertext })}\n\n`);
    return true;
  } catch {
    return false; // 连接已断：由调用方 closeSse 收尾
  }
}

function closeSse(client) {
  if (client.timer) clearInterval(client.timer);
  client.timer = null;
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* 连接已断，无需收尾 */
  }
}

adminCrypto.onSessionsCleared(() => {
  for (const client of [...sseClients]) closeSse(client);
});

/** POST /api/login：ECDH 登录协商（令牌由服务端从 config.admin.token 读，请求不带令牌，Ruling 3/9） */
function loginHandler(req, res) {
  const b = req.body || {};
  const r = adminCrypto.createSession({ clientPubKey: b.clientPubKey, ts: b.ts, nonce: b.nonce, sig: b.sig });
  if (!r.ok) return unauthorized(res);
  return res.json(r); // 只回公钥 / 会话号 / 签名，会话密钥不出内存（adminCrypto 的返回值里也没有）
}

/** POST /api/rpc：鉴权 → 解密请求 → 命令表门控（browser 形态）→ 执行 handler → 加密响应（回带请求 nonce） */
function rpcHandler({ commands, commandTable }) {
  return async (req, res) => {
    const b = req.body || {};
    const { sessionId, ts, nonce, sig, iv, ciphertext } = b;
    if (typeof ciphertext !== "string" || !ciphertext || typeof iv !== "string" || !iv) return unauthorized(res);
    const v = adminCrypto.verifyRequest({ sessionId, ts, nonce, sig, bodyHash: adminCrypto.bodyHashOf(ciphertext), method: "POST", path: "/api/rpc" });
    if (!v.ok) return unauthorized(res);
    const plain = adminCrypto.open(v.keys.kReq, iv, ciphertext);
    if (plain === null) return unauthorized(res); // GCM 认证失败（密文被篡改）
    let req2 = null;
    try {
      req2 = JSON.parse(plain);
    } catch {
      return unauthorized(res); // 明文不是合法 JSON 同样按篡改处理，不另给文案
    }
    const cmd = req2 && typeof req2.cmd === "string" ? req2.cmd : "";
    if (!cmd || !commands.has(cmd)) return res.status(404).json({ ok: false, message: "未知命令" });
    if (commandTable.modeOf(cmd, "browser") === "deny") return res.status(403).json({ ok: false, message: commandTable.denyReason(cmd, "browser") || "浏览器访问时不可用" });
    let result;
    try {
      result = await commands.get(cmd)(null, req2.args && typeof req2.args === "object" ? req2.args : {});
    } catch (e) {
      result = { ok: false, message: String((e && e.message) || e) };
    }
    if (result === undefined || result === null) result = { ok: true };
    // handler 返回 { ok:false }（业务失败）也走加密响应，不降级成明文错误
    const sealed = adminCrypto.seal(v.keys.kResp, JSON.stringify(result));
    return res.json({ nonce, iv: sealed.iv, ciphertext: sealed.ciphertext });
  };
}

/** GET /api/events：SSE（鉴权参数走 query，签名覆盖 GET /api/events、bodyHash 为空串）。
 *  每帧都用 K_resp 加密；心跳顺带查会话，过期或被清空即关闭连接 */
function eventsHandler() {
  return (req, res) => {
    const q = req.query || {};
    const v = adminCrypto.verifyRequest({ sessionId: q.sessionId, ts: q.ts, nonce: q.nonce, sig: q.sig, bodyHash: "", method: "GET", path: "/api/events" });
    if (!v.ok) return unauthorized(res);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const client = { res, timer: null, sessionId: q.sessionId };
    sseClients.add(client);
    sendFrame(client, v.keys, { type: "hello", ts: Date.now() });
    client.timer = setInterval(() => {
      if (!adminCrypto.hasSession(client.sessionId) || !sendFrame(client, v.keys, { type: "ping", ts: Date.now() })) closeSse(client);
    }, SSE_HEARTBEAT_MS);
    if (typeof client.timer.unref === "function") client.timer.unref();
    req.on("close", () => closeSse(client));
  };
}

/** Express 应用：/api/capabilities、/api/status、/api/login、/api/rpc、/api/events、静态资源、SPA 回退 */
function buildApp({ commandTable, staticDir }) {
  const commands = commandTable.collect(); // 命令表启动时收集一次（注册副作用幂等，时机在反代 boot 之后）
  const caps = capabilitiesOf(commands, commandTable);
  const app = express();
  app.disable("x-powered-by");
  const jsonBody = express.json({ limit: "1mb" });

  app.get("/api/capabilities", (_req, res) => res.json(caps));
  app.get("/api/status", (_req, res) => res.json(statusOf()));
  app.post("/api/login", jsonBody, loginHandler);
  app.post("/api/rpc", jsonBody, rpcHandler({ commands, commandTable }));
  app.get("/api/events", eventsHandler());
  // 请求体不是合法 JSON 时别让 Express 默认错误页（HTML）冒出来，前端解析会炸
  app.use((err, _req, res, next) => {
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ ok: false, message: "请求格式错误" });
    return next(err);
  });
  // 其余 /api 一律 404 JSON：SPA 回退只服务非 /api 路径，接口打错返回 HTML 会让前端解析炸掉
  app.use("/api", (_req, res) => res.status(404).json({ ok: false, message: "未知接口" }));

  const indexFile = staticDir ? path.join(staticDir, "index.html") : "";
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false }));
  }
  // SPA 回退：深链接 / 刷新都回 index.html（路由由前端接管）
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    if (!indexFile || !fs.existsSync(indexFile)) {
      res.status(404).json({ ok: false, message: `管理页面未构建：缺少 ${indexFile || "(未配置静态目录)"}` });
      return;
    }
    res.sendFile(indexFile);
  });
  return app;
}

// start/stop 串行化：并发 start 时「先检查后赋值」会两个都 listen、stop 只关一个（端口泄漏）；
// 一切启停排同一条链顺序执行，链上某步失败不拦后续操作（对 stop 与失败回滚重试友好）
let opChain = Promise.resolve();
function serialize(fn) {
  const run = opChain.then(fn);
  opChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** 启动管理服务：port 是反代端口（监听 port + 1，0.0.0.0）；已在运行则先停旧再启新（端口联动语义） */
function start({ port, commandTable, staticDir } = {}) {
  return serialize(() => doStart({ port, commandTable, staticDir }));
}

async function doStart({ port, commandTable, staticDir }) {
  const adminPort = adminPortOf(port); // 端口非法先拒绝，别碰已在跑的服务
  if (!commandTable || typeof commandTable.collect !== "function" || typeof commandTable.modeOf !== "function" || typeof commandTable.denyReason !== "function") {
    const e = new Error("命令表不合法：需要 { collect, modeOf, denyReason }（见 electron/backend/commandTable.cjs）");
    e.code = "EADMINTABLE";
    throw e;
  }
  if (server) await doStop(); // 链内重入必须走 doStop：调 stop() 会排到链尾等自己（死锁）
  const app = buildApp({ commandTable, staticDir });
  await new Promise((resolve, reject) => {
    const srv = app.listen(adminPort, "0.0.0.0", () => {
      srv.removeListener("error", onError);
      server = srv;
      listenPort = adminPort;
      resolve();
    });
    const onError = (e) => {
      const err = new Error(`管理服务启动失败（端口 ${adminPort}）：${e && e.code === "EADDRINUSE" ? "端口已被占用，请更换反代端口（管理端口 = 反代端口 + 1）" : String((e && e.message) || e)}`);
      err.code = (e && e.code) || "EADMINLISTEN";
      reject(err);
    };
    srv.once("error", onError);
  });
  return { port: adminPort };
}

/** 停止管理服务：未启动时幂等 */
function stop() {
  return serialize(doStop);
}

async function doStop() {
  const srv = server;
  server = null;
  listenPort = 0;
  for (const client of [...sseClients]) closeSse(client); // SSE 是长连接，不主动关 close() 会一直等
  if (!srv) return;
  await new Promise((resolve) => {
    // keep-alive 连接不主动断的话 close() 要等到空闲超时才回调，stop 后端口迟迟不释放
    if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
    srv.close(() => resolve());
  });
}

module.exports = { start, stop, adminPortOf, listenPort: () => listenPort };
