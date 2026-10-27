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
// 管理服务骨架：局域网浏览器访问的 HTTP 入口（Express），监听 0.0.0.0，端口 = 反代端口 + 1。
// 本骨架只挂 /api/capabilities、/api/status、静态资源与 SPA 回退；
// /api/rpc 刻意不挂——无鉴权的命令通道留到任务 6 接入鉴权后再说，避免出现临时后门。
// 命令清单按 browser 形态下发（modeOf/denyReason 的 form 参数，文案见 commandTable.cjs）。
//
// 结构上只依赖注入的 commandTable（collect/modeOf/denyReason），不碰反代转发、选号、冷却、鉴权、计费：
// start({ port, commandTable, staticDir }) 的 port 是**反代端口**（监听 port + 1），返回实际监听端口，
// 容器形态（gateway）后续只换注入的命令表与 staticDir 即可复用。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

let server = null; // http.Server：运行中的管理服务
let listenPort = 0; // 当前监听端口（= 反代端口 + 1），未启动为 0

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
    // 浏览器边界声明：服务启停 / SSE / 文件对话框在浏览器形态都不可用（后续任务按需放开）
    features: { serviceControl: false, sse: false, fileDialog: false },
    commands: out,
  };
}

/** /api/status 载荷：只给非敏感的运行摘要（渠道 / Key / 用量等带鉴权后再下发）。
 *  网关状态经命令表的 proxy_status 取（同桌面 IPC 同一份 handler），异常降级为未运行 */
async function statusOf(commands) {
  const base = { running: false, port: 0, bind: "" };
  try {
    const handler = commands.get("proxy_status");
    if (typeof handler !== "function") return { ok: true, form: "browser", platform: platformForm(), version: appVersion(), gateway: base };
    // 桌面 handler 形如 (event, args)，全部不使用 event（同 gateway 的 /api/rpc 约定），传 null 即可
    const r = await handler(null, {});
    if (r && r.ok === false) return { ok: true, form: "browser", platform: platformForm(), version: appVersion(), gateway: base };
    return {
      ok: true,
      form: "browser",
      platform: platformForm(),
      version: appVersion(),
      gateway: { running: !!(r && r.running), port: Number((r && r.port) || 0), bind: String((r && r.bind) || "") },
    };
  } catch {
    return { ok: true, form: "browser", platform: platformForm(), version: appVersion(), gateway: base };
  }
}

/** Express 应用：/api/capabilities、/api/status、静态资源、SPA 回退（非 /api 的 GET/HEAD 回 index.html） */
function buildApp({ commandTable, staticDir }) {
  const commands = commandTable.collect(); // 命令表启动时收集一次（注册副作用幂等，时机在反代 boot 之后）
  const caps = capabilitiesOf(commands, commandTable);
  const app = express();
  app.disable("x-powered-by");

  app.get("/api/capabilities", (_req, res) => res.json(caps));
  app.get("/api/status", async (_req, res) => res.json(await statusOf(commands)));
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

/** 启动管理服务：port 是反代端口（监听 port + 1，0.0.0.0）；已在运行则先停旧再启新（端口联动语义） */
async function start({ port, commandTable, staticDir } = {}) {
  const adminPort = adminPortOf(port); // 端口非法先拒绝，别碰已在跑的服务
  if (!commandTable || typeof commandTable.collect !== "function" || typeof commandTable.modeOf !== "function" || typeof commandTable.denyReason !== "function") {
    const e = new Error("命令表不合法：需要 { collect, modeOf, denyReason }（见 electron/backend/commandTable.cjs）");
    e.code = "EADMINTABLE";
    throw e;
  }
  if (server) await stop();
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
async function stop() {
  const srv = server;
  server = null;
  listenPort = 0;
  if (!srv) return;
  await new Promise((resolve) => {
    // keep-alive 连接不主动断的话 close() 要等到空闲超时才回调，stop 后端口迟迟不释放
    if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
    srv.close(() => resolve());
  });
}

module.exports = { start, stop, adminPortOf, listenPort: () => listenPort };
