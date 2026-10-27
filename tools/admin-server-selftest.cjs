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
// 管理服务骨架自测：admin.start / admin.stop 与 Express 挂载面（任务 5）。
// 覆盖：/api/capabilities（browser 形态命令清单）、/api/status、静态资源与 SPA 回退、
// /api 路径不回退 index.html、/api/rpc 不挂（无鉴权通道留到任务 6）、
// 反代端口 0 / 65535 拒绝、端口联动的先停后启与失败回滚重启。
// 纯 Node 跑（不加载 electron）：命令表只收集不执行。用法：node tools/admin-server-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-adminsrv-"));
process.env.AGENTHUB_DATA_DIR = path.join(SANDBOX, "data");

const STATIC_DIR = path.join(SANDBOX, "dist");
fs.mkdirSync(path.join(STATIC_DIR, "assets"), { recursive: true });
fs.writeFileSync(path.join(STATIC_DIR, "index.html"), "<!doctype html><html><body>admin-spa-index</body></html>");
fs.writeFileSync(path.join(STATIC_DIR, "assets", "app.js"), 'console.log("admin-static-asset");');

const PROXY_PORT_A = 19529; // 简报指定的测试反代端口：管理端口 = 反代端口 + 1
const PROXY_PORT_B = 19549; // 端口联动用例的第二个反代端口

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

const commandTable = require(path.join(ROOT, "electron", "backend", "commandTable.cjs"));
const admin = require(path.join(ROOT, "electron", "backend", "admin.cjs"));

const base = (p) => `http://127.0.0.1:${p}`;
function get(url, opts) {
  return fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(5000) });
}
async function reachable(p) {
  try {
    await get(base(p) + "/api/capabilities");
    return true;
  } catch {
    return false;
  }
}

(async () => {
  // ===== 反代端口非法拒绝（0 / 65535 → 管理端口 = 反代端口 + 1 越界或无意义） =====
  for (const p of [0, 65535]) {
    let err = null;
    try {
      await admin.start({ port: p, commandTable, staticDir: STATIC_DIR });
    } catch (e) {
      err = e;
    }
    ok(`反代端口 ${p} 拒绝启动管理服务`, !!err && /端口/.test(String((err && err.message) || err)), err ? String(err.message) : "未抛错");
  }

  // ===== 启动与 capabilities =====
  const first = await admin.start({ port: PROXY_PORT_A, commandTable, staticDir: STATIC_DIR });
  ok("start 返回管理端口 = 反代端口 + 1", !!first && first.port === PROXY_PORT_A + 1, JSON.stringify(first));

  const capsRes = await get(base(first.port) + "/api/capabilities");
  const caps = await capsRes.json();
  ok("GET /api/capabilities 200", capsRes.status === 200, String(capsRes.status));
  ok('capabilities.modules 含 "proxy"', Array.isArray(caps.modules) && caps.modules.includes("proxy"), JSON.stringify(caps.modules));
  ok("capabilities.commands 带 mode（proxy_status=read / proxy_start=deny）", !!caps.commands && !!caps.commands.proxy_status && caps.commands.proxy_status.mode === "read" && !!caps.commands.proxy_start && caps.commands.proxy_start.mode === "deny", JSON.stringify(caps.commands && caps.commands.proxy_start));
  ok("browser 形态 deny 原因带「浏览器访问时不可用」前缀", !!(caps.commands && caps.commands.proxy_start) && typeof caps.commands.proxy_start.reason === "string" && caps.commands.proxy_start.reason.startsWith("浏览器访问时不可用"), String(caps.commands && caps.commands.proxy_start && caps.commands.proxy_start.reason));

  // ===== Ruling 11：形态参数（browser 换文案前缀，container 保持原文案；deny 集合一致） =====
  const containerReason = commandTable.denyReason("proxy_start", "container");
  ok('denyReason("proxy_start", "container") 保持原文案', typeof containerReason === "string" && !containerReason.includes("浏览器访问时不可用"), String(containerReason));
  ok("denyReason 默认形态 = container", commandTable.denyReason("proxy_start") === containerReason);
  ok(
    "modeOf 的门控判定两形态一致",
    ["proxy_start", "proxy_pool", "save_config"].every((c) => commandTable.modeOf(c, "browser") === commandTable.modeOf(c, "container"))
  );

  // ===== /api/status =====
  const stRes = await get(base(first.port) + "/api/status");
  const st = await stRes.json();
  ok("GET /api/status 200 且 ok", stRes.status === 200 && st.ok === true, `status=${stRes.status} body=${JSON.stringify(st).slice(0, 200)}`);

  // ===== 静态资源与 SPA 回退 =====
  const idx = await get(base(first.port) + "/");
  ok("GET / 返回 index.html", idx.status === 200 && String(idx.headers.get("content-type")).includes("text/html") && (await idx.text()).includes("admin-spa-index"), `status=${idx.status} ct=${idx.headers.get("content-type")}`);
  const spa = await get(base(first.port) + "/some/spa/route");
  ok("GET /some/spa/route 回退 index.html", spa.status === 200 && String(spa.headers.get("content-type")).includes("text/html") && (await spa.text()).includes("admin-spa-index"), `status=${spa.status}`);
  const asset = await get(base(first.port) + "/assets/app.js");
  ok("GET /assets/app.js 返回静态资源", asset.status === 200 && (await asset.text()).includes("admin-static-asset"), String(asset.status));

  // ===== /api 不回退 HTML、/api/rpc 不挂 =====
  const miss = await get(base(first.port) + "/api/unknown");
  ok("GET /api/unknown 404 JSON（不回退 index.html）", miss.status === 404 && String(miss.headers.get("content-type")).includes("application/json"), `status=${miss.status} ct=${miss.headers.get("content-type")}`);
  const rpcRes = await fetch(base(first.port) + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "proxy_status" }), signal: AbortSignal.timeout(5000) });
  ok("POST /api/rpc 未挂载（404）", rpcRes.status === 404, String(rpcRes.status));

  // ===== stop 后端口关闭 =====
  await admin.stop();
  ok("stop() 后端口关闭", !(await reachable(first.port)));
  let stopErr = null;
  try {
    await admin.stop();
  } catch (e) {
    stopErr = e;
  }
  ok("stop() 幂等（重复停止不抛）", !stopErr, String(stopErr && stopErr.message));

  // ===== 端口联动：不 stop 直接换端口 start（先停旧再启新） =====
  const second = await admin.start({ port: PROXY_PORT_B, commandTable, staticDir: STATIC_DIR });
  ok("换端口 start 后新端口可用", !!second && second.port === PROXY_PORT_B + 1 && (await reachable(second.port)), JSON.stringify(second));
  ok("换端口 start 后旧端口已关闭", !(await reachable(first.port)));

  // ===== 失败回滚：新端口起失败后旧端口可重新拉起 =====
  await admin.stop();
  let rollbackErr = null;
  try {
    await admin.start({ port: 65535, commandTable, staticDir: STATIC_DIR });
  } catch (e) {
    rollbackErr = e;
  }
  const back = await admin.start({ port: PROXY_PORT_A, commandTable, staticDir: STATIC_DIR });
  ok("启动失败后可用旧端口回滚重启", !!rollbackErr && !!back && back.port === first.port && (await reachable(back.port)), `rollbackErr=${rollbackErr && rollbackErr.message} back=${JSON.stringify(back)}`);
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
