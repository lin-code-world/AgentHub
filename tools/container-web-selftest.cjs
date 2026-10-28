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
// 容器 Web 控制台端到端自测（C1 形态分流 + I4 旧令牌清理 + I6 连接状态 / 空态纯函数）。
//
// 真实启动 gateway/src/index.cjs（临时数据目录 + 临时端口 + 真实 AGENTHUB_ADMIN_TOKEN），
// 再用前端真实模块（esbuild 直译 TS，Node 下跑真实现而不是副本）跑：
//   C1-1  /api/capabilities 声明 form:"container" 且 features.sse=true（前端据此选通道）
//   C1-2  容器登录函数 loginWithToken：错令牌「令牌不正确」且不落盘；对令牌成功并把令牌留在本地
//   C1-3  明文 RPC：webInvoke("proxy_pool") 走 Bearer 拿到真实号池视图
//   C1-4  令牌缺失时 RPC 401 → 统一「登录已失效」并清掉本地令牌
//   C1-5  SSE：订阅后状态 connected，服务端广播（proxy_config_save 的 config-changed）能被收到
//   C1-6  容器形态仍保持旧行为：令牌存 localStorage（桌面 ECDH 形态不存，见 admin-crypto-browser-selftest）
//   I4    桌面浏览器形态的升级残留清理 clearLegacyToken：未登录也清掉旧 agenthub.adminToken
//   I6-a  连接状态机：空流立即断线 → reconnecting；重连成功 → connected 且补发 {type:"resync"}
//   I6-b  空态三态纯函数 loadPhaseOf：loading / empty / failed 分开，失败可重试
//   I6-c  三页（号池 / 日志 / 统计）接线：消费 loadPhaseOf（或同款失败态）并给出「重试」
// 沙箱：临时数据目录 + 临时端口，不碰真实用户数据、不占固定端口。
// 用法：node tools/container-web-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-container-web-"));
const DATA_DIR = path.join(SANDBOX, "data");
const UI_DIR = path.join(SANDBOX, "no-ui"); // 不存在的 UI 目录：只测 API，跳过静态托管
const ADMIN_TOKEN = "selftest-admin-token-0123456789";

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

// ===== 工具 =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ===== 假 localStorage（Node 无 localStorage；容器登录把令牌存在这里） =====
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

// ===== TS 源文件直载（esbuild 编译成 CJS 后经 require.extensions 挂载）=====
function installTsLoader() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  Module._extensions[".ts"] = (mod, file) => {
    const src = fs.readFileSync(file, "utf8");
    const out = esbuild.transformSync(src, { loader: "ts", format: "cjs", sourcefile: file }).code;
    mod._compile(out, file);
  };
}

// ===== 假 SSE 流（I6 状态机用；不打真实网络）=====
const encoder = new TextEncoder();
function sseResponse(chunks, { keepOpen = false } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (!keepOpen) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function killChild(child) {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
}

(async () => {
  installTsLoader();
  const capsApi = require(path.join(ROOT, "src", "api", "caps.ts"));
  const transport = require(path.join(ROOT, "src", "api", "web-transport.ts"));
  const eventsApi = require(path.join(ROOT, "src", "api", "events.ts"));
  const adminCrypto = require(path.join(ROOT, "src", "api", "adminCrypto.ts"));
  const { loadPhaseOf } = require(path.join(ROOT, "src", "views", "proxy", "loadState.ts"));

  const proxyPort = await freePort();
  const adminPort = await freePort();
  const ADMIN_URL = `http://127.0.0.1:${adminPort}`;
  // 浏览器里是相对路径；Node 的 fetch 不解析相对 URL，测试装置统一转发到绝对地址（业务逻辑照测）。
  // 先抓住原生 fetch 再覆盖：relay 里若回指 globalThis.fetch 会自递归
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const relayFetch = (url, init) => nativeFetch(new URL(String(url), ADMIN_URL).toString(), init);
  globalThis.fetch = relayFetch;

  // ===== 启动容器入口（真实进程） =====
  console.log("=== 启动容器网关（gateway/src/index.cjs）===");
  const child = spawn(process.execPath, [path.join(ROOT, "gateway", "src", "index.cjs")], {
    cwd: SANDBOX,
    env: {
      ...process.env,
      AGENTHUB_DATA_DIR: DATA_DIR,
      AGENTHUB_PROXY_PORT: String(proxyPort),
      AGENTHUB_ADMIN_PORT: String(adminPort),
      AGENTHUB_ADMIN_HOST: "127.0.0.1",
      AGENTHUB_ADMIN_TOKEN: ADMIN_TOKEN,
      AGENTHUB_ALLOW_PLAINTEXT: "1", // 容器自测免 secret key（只测管理面，不测凭据加密）
      AGENTHUB_UI_DIR: UI_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b.toString()));
  child.stderr.on("data", (b) => (out += b.toString()));

  let started = false;
  try {
    started = await waitFor(async () => {
      try {
        const res = await nativeFetch(`${ADMIN_URL}/api/livez`);
        return res.ok;
      } catch {
        return false;
      }
    }, 30000);
    if (!started) {
      console.log("容器网关未能在 30s 内就绪，进程输出：\n" + out);
      ok("容器网关启动", false, "livez 未就绪");
      throw new Error("startup-failed");
    }
    ok("容器网关启动（临时端口 + 临时数据目录）", true);

    // ===== C1-1：capabilities 声明形态 =====
    console.log("=== C1-1 capabilities 声明 form=container ===");
    const caps = await capsApi.probeCaps();
    ok("probeCaps 拿到容器能力清单", !!caps, JSON.stringify(caps && { form: caps.form }));
    ok('capabilities.form === "container"', !!caps && caps.form === "container", String(caps && caps.form));
    ok("capabilities.features.sse === true（容器已有 /api/events）", !!caps && caps.features && caps.features.sse === true, JSON.stringify(caps && caps.features));
    ok("isContainerWeb() === true（前端选 Bearer 通道）", capsApi.isContainerWeb() === true);
    ok('webForm() === "container"', capsApi.webForm() === "container", String(capsApi.webForm()));
    ok("命令门控照旧：proxy_pool → read，proxy_start → deny", capsApi.commandMode("proxy_pool") === "read" && capsApi.commandMode("proxy_start") === "deny", capsApi.commandMode("proxy_pool") + "/" + capsApi.commandMode("proxy_start"));

    // ===== C1-2：真实前端登录函数 =====
    console.log("=== C1-2 容器登录 loginWithToken ===");
    let badErr = "";
    try {
      await transport.loginWithToken("definitely-wrong-token");
    } catch (e) {
      badErr = String((e && e.message) || e);
    }
    ok("错令牌登录失败且文案为「令牌不正确」", badErr === "令牌不正确", badErr);
    ok("错令牌不落 localStorage", transport.getToken() === "", transport.getToken());
    await transport.loginWithToken(ADMIN_TOKEN);
    ok("正确令牌登录成功", transport.getToken() === ADMIN_TOKEN, transport.getToken().slice(0, 6) + "…");
    ok("C1-6 容器形态把令牌留在 localStorage（旧行为保持）", JSON.stringify(storage._dump()).includes(ADMIN_TOKEN), Object.keys(storage._dump()).join(","));

    // ===== C1-3：明文 RPC =====
    console.log("=== C1-3 Bearer 明文 RPC ===");
    const poolRows = await transport.webInvoke("proxy_pool");
    ok("webInvoke('proxy_pool') 返回真实号池视图（数组）", Array.isArray(poolRows) && poolRows.length > 0, Array.isArray(poolRows) ? `rows=${poolRows.length}` : String(poolRows));
    const proxyCfg = await transport.webInvoke("proxy_config_get");
    ok("webInvoke('proxy_config_get') 返回反代配置段（含 port）", !!proxyCfg && typeof proxyCfg === "object" && Number.isInteger(Number(proxyCfg.port)), JSON.stringify(proxyCfg && { port: proxyCfg.port }));

    // ===== C1-5：SSE 收到一帧（真实服务端广播）=====
    console.log("=== C1-5 SSE 收到服务端广播帧 ===");
    const frames = [];
    let stateNow = "";
    const offState = eventsApi.onWebEventState((s) => (stateNow = s));
    const offStream = eventsApi.subscribeWebEvents((p) => frames.push(p));
    const connected = await waitFor(() => stateNow === "connected", 8000);
    ok("SSE 订阅后连接状态为 connected", connected, stateNow);
    // 触发一次服务端广播：上游启闭（容器命令表里的写命令）→ emit {type:"status"}。
    // 注意容器 platform.emit 只转发带 type 的事件（{event:"config-changed"} 这类在 node 形态被丢弃，
    // 属既有行为不在本轮调整），所以这里挑一条带 type 的真实广播
    const firstChannel = Array.isArray(poolRows) && poolRows[0] && poolRows[0].id;
    await transport.webInvoke("proxy_channel_toggle", { channel: firstChannel, enabled: true });
    const gotChunk = await waitFor(() => frames.some((f) => f && f.event === "proxy" && f.type === "status"), 8000);
    ok("SSE 收到服务端广播帧 {event:'proxy',type:'status'}", gotChunk, JSON.stringify(frames.slice(0, 3)));
    offStream();
    offState();

    // ===== C1-4：令牌失效 401 =====
    console.log("=== C1-4 令牌缺失 → 401 统一收口 ===");
    transport.clearToken();
    let lostErr = "";
    try {
      await transport.webInvoke("proxy_pool");
    } catch (e) {
      lostErr = String((e && e.message) || e);
    }
    ok("无令牌 RPC 抛「登录已失效」", lostErr === "登录已失效，请重新输入管理令牌", lostErr);
    ok("失效后本地令牌已清空", transport.getToken() === "", transport.getToken());
    await transport.loginWithToken(ADMIN_TOKEN); // 恢复到已登录态

    // ===== I4：旧令牌清理 =====
    console.log("=== I4 桌面浏览器形态清旧令牌 ===");
    storage.setItem("agenthub.adminToken", "legacy-plaintext-token");
    adminCrypto.clearLegacyToken();
    ok("clearLegacyToken 无条件删掉升级残留的明文令牌", storage.getItem("agenthub.adminToken") === null, String(storage.getItem("agenthub.adminToken")));
    ok("clearLegacyToken 不碰 ECDH 会话键（agenthub.adminSession）", storage.getItem("agenthub.adminSession") === null);
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");
    ok("main.ts 浏览器启动路径调用 clearLegacyToken", /clearLegacyToken\(\)/.test(mainSrc));
    ok("main.ts 只在桌面浏览器形态清（容器 Bearer 仍需要该键）", /caps\s*&&\s*!isContainerWeb\(\)\s*\)\s*clearLegacyToken\(\)/.test(mainSrc));
    ok("main.ts 登录判定按形态分流（容器看令牌 / 桌面看 ECDH 会话）", /isContainerWeb\(\)\s*\?\s*!!getToken\(\)\s*:\s*hasSession\(\)/.test(mainSrc));
    transport.setToken(ADMIN_TOKEN); // I4 清掉的只是旧键测试量；容器 Bearer 需要令牌，恢复已登录态

    // ===== I6-a：连接状态机（假 SSE，可控断线）=====
    console.log("=== I6-a 连接状态 connected / reconnecting / resync ===");
    const states = [];
    const resyncSeen = [];
    let round = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.startsWith("/api/events")) throw new Error("unexpected fetch " + u);
      round++;
      if (round === 1) return sseResponse([]); // 立即结束 = 断线
      // 第二次：保持打开并先给一帧（模拟重连成功后的数据）
      return sseResponse(['data: {"event":"proxy","type":"resync"}\n\n'], { keepOpen: true });
    };
    const offState2 = eventsApi.onWebEventState((s) => states.push(s));
    const offStream2 = eventsApi.subscribeWebEvents((p) => {
      if (p && p.type === "resync") resyncSeen.push(p);
    });
    const sawReconnect = await waitFor(() => states.includes("reconnecting"), 5000);
    ok("断流后状态变 reconnecting", sawReconnect, states.join(","));
    const sawReconnected = await waitFor(() => states.filter((s) => s === "connected").length >= 2, 8000);
    ok("重连成功后状态回到 connected", sawReconnected, states.join(","));
    const resynced = await waitFor(() => resyncSeen.length > 0, 3000);
    ok("重连成功补发 {type:'resync'}（断线期间漏的事件用一次全量刷新补上）", resynced, JSON.stringify(resyncSeen));
    offStream2();
    offState2();
    globalThis.fetch = relayFetch;

    // ===== I6-b：空态三态纯函数 =====
    console.log("=== I6-b 空态三态判定 ===");
    ok('首屏未返回 → "loading"', loadPhaseOf({ loading: true, error: "", count: 0 }) === "loading");
    ok('无数据且无错 → "empty"', loadPhaseOf({ loading: false, error: "", count: 0 }) === "empty");
    ok('有错 → "failed"（即便无数据）', loadPhaseOf({ loading: false, error: "HTTP 500", count: 0 }) === "failed");
    ok('有数据 → "ready"', loadPhaseOf({ loading: false, error: "", count: 3 }) === "ready");
    ok("加载中带旧错误仍显示 loading（不把首屏误报成失败）", loadPhaseOf({ loading: true, error: "旧错误", count: 0 }) === "loading");
    // 号池页整页级三态（I6 残余）：渠道列表为空时 v-for 里的失败态不渲染，
    // 判定必须落在 v-for 外的分支上
    ok("号池整页级：无渠道 + 有 loadErr → failed（带原因与重试）", loadPhaseOf({ loading: false, error: "HTTP 500", count: 0 }) === "failed");
    ok("号池整页级：无渠道 + 无 loadErr + 非加载中 → empty", loadPhaseOf({ loading: false, error: "", count: 0 }) === "empty");
    ok("号池整页级：首屏加载中 → loading", loadPhaseOf({ loading: true, error: "", count: 0 }) === "loading");

    // ===== I5：号池页只认 {type:"pool"} 并 2 秒节流 =====
    console.log("=== I5 号池事件接线 ===");
    const agentsSrc = fs.readFileSync(path.join(ROOT, "src", "views", "proxy", "ProxyAgentsView.vue"), "utf8");
    ok("号池页为 pool 事件挂独立 2 秒节流刷新", /schedulePoolRefresh\s*=\s*coalesceAsync\(refresh,\s*2000\)/.test(agentsSrc), "未找到 2 秒节流器");
    ok("pool 分支走该节流器（与 credits/status 的 1.2s 节流分开）", /p\.type === "pool"[\s\S]{0,220}schedulePoolRefresh\(\)/.test(agentsSrc), "pool 分支未接节流器");
    ok("卸载时取消号池节流器", /schedulePoolRefresh\.cancel\(\)/.test(agentsSrc), "未取消定时器");
    ok("断线重连补发的 resync 也触发一次号池全量", /p\.type === "resync"[\s\S]{0,220}schedulePoolRefresh\(\)/.test(agentsSrc), "resync 未接号池刷新");

    // ===== I6-c：三页接线 =====
    console.log("=== I6-c 三页空态接线 ===");
    // 号池整页级（I6 残余）：pool 为空时 v-for 里的失败态根本不渲染，
    // 失败原因与「重试」必须给在 v-for 之外
    ok("号池页在 v-for 之外给整页级失败态（pool-empty-card）", /v-if="!pool\.length && poolPhase !== 'loading'" class="card pool-empty-card"[\s\S]{0,260}poolPhase === ['"]failed['"][\s\S]{0,200}@click="refresh"/.test(agentsSrc), "未找到 v-for 外的失败态卡片");
    ok("切换条 !pool.length 分支是三态（加载中 / 加载失败 / 暂无渠道）", /v-if="!pool\.length" class="ch-strip-empty"[\s\S]{0,260}加载失败[\s\S]{0,120}暂无渠道/.test(agentsSrc), "切换条空态仍是恒显「加载中…」");
    for (const file of ["src/views/proxy/ProxyAgentsView.vue", "src/views/proxy/ProxyLogView.vue", "src/views/proxy/ProxyStatsView.vue"]) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      ok(`${file} 用 loadPhaseOf 区分空态与失败`, /loadPhaseOf\(/.test(src), "未找到 loadPhaseOf 接线");
      ok(`${file} 失败态带「重试」入口`, /加载失败[^]{0,120}重试/.test(src), "未找到失败态重试按钮");
    }
  } catch (e) {
    ok("自测执行未抛错", false, String((e && e.message) || e));
  } finally {
    killChild(child);
    await sleep(300);
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* 沙箱残留不影响结论 */
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("失败项：\n  - " + bad.join("\n  - "));
    process.exit(1);
  }
})();
