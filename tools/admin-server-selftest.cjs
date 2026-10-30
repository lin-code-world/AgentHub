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
// 覆盖：/api/capabilities（browser 形态命令清单 + 文案不含容器形态措辞）、/api/status（轻量状态，
// 不跑全量 proxy_status）、静态资源与 SPA 回退、/api 路径不回退 index.html、/api/rpc 未鉴权 401、
// 反代端口 0 / 65535 拒绝、端口联动的先停后启、并发 start 不泄漏端口、启动失败后旧端口可重新拉起。
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
const PROXY_PORT_C = 19569; // 并发 start 用例的第二个反代端口
const PROXY_PORT_D = 19589; // /api/status 轻量断言用例的反代端口

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

  // ===== 端口规则单一真源：adminPortOf 复用 config.validateProxyPort，两处结论必须一致 =====
  {
    const config = require(path.join(ROOT, "electron", "backend", "config.cjs"));
    const agree = [0, 65535, 9527, 65534].every((p) => {
      let rejected = false;
      try {
        admin.adminPortOf(p);
      } catch (e) {
        rejected = !!e && e.code === "EADMINPORT";
      }
      return rejected === !config.validateProxyPort(p).ok;
    });
    ok("adminPortOf 与 config.validateProxyPort 对 0 / 65535 / 正常值结论一致", agree);
    ok("adminPortOf(9527) 返回 9528", admin.adminPortOf(9527) === 9528, String(admin.adminPortOf(9527)));
  }

  // ===== 启动与 capabilities =====
  const first = await admin.start({ port: PROXY_PORT_A, commandTable, staticDir: STATIC_DIR });
  ok("start 返回管理端口 = 反代端口 + 1", !!first && first.port === PROXY_PORT_A + 1, JSON.stringify(first));

  const capsRes = await get(base(first.port) + "/api/capabilities");
  const caps = await capsRes.json();
  ok("GET /api/capabilities 200", capsRes.status === 200, String(capsRes.status));
  ok('capabilities.modules 含 "proxy"', Array.isArray(caps.modules) && caps.modules.includes("proxy"), JSON.stringify(caps.modules));
  ok("capabilities.commands 带 mode（proxy_status=read / proxy_start=deny）", !!caps.commands && !!caps.commands.proxy_status && caps.commands.proxy_status.mode === "read" && !!caps.commands.proxy_start && caps.commands.proxy_start.mode === "deny", JSON.stringify(caps.commands && caps.commands.proxy_start));
  ok("browser 形态 deny 原因带「浏览器访问时不可用」口径", !!(caps.commands && caps.commands.proxy_start) && typeof caps.commands.proxy_start.reason === "string" && caps.commands.proxy_start.reason.startsWith("浏览器访问时不可用"), String(caps.commands && caps.commands.proxy_start && caps.commands.proxy_start.reason));
  ok("Ruling 17：capabilities.features.sse === true（真实事件源已接通，前置条件满足）", !!caps.features && caps.features.sse === true && caps.features.serviceControl === false && caps.features.fileDialog === false, JSON.stringify(caps.features));

  // ===== 网页端文案表只有一张：27 条文案逐字固定（合并命令表时最容易手滑改字，这里当快照） =====
  // 桌面专用命令（admin_access_info 会吐明文令牌，绝不能漏）：网页端最容易被当成可用的越权入口
  const browserOnly = ["admin_access_info", "admin_reset_token", "browse_dir", "open_data_dir", "get_data_dir", "get_app_version", "load_config", "save_config"];
  ok("8 条桌面专用命令在网页端 deny", browserOnly.every((c) => commandTable.modeOf(c) === "deny"), JSON.stringify(browserOnly.map((c) => [c, commandTable.modeOf(c)])));

  const DENY_SNAPSHOT = {
    proxy_start: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
    proxy_stop: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
    proxy_restart: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
    proxy_open_data_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
    proxy_open_rules_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
    proxy_account_import_file: "浏览器访问时不可用：请改用「选择 JSON 文件上传，或粘贴 JSON」导入",
    proxy_scan_import: "浏览器访问时不可用：扫描本机登录态请在桌面窗口操作",
    proxy_scan: "浏览器访问时不可用：扫描本机登录态请在桌面窗口操作",
    proxy_oauth_begin: "浏览器访问时不可用：OAuth 登录请在桌面窗口操作",
    proxy_oauth_submit_callback: "浏览器访问时不可用：OAuth 登录请在桌面窗口操作",
    proxy_ide_status: "浏览器访问时不可用：IDE 切号请在桌面窗口操作",
    proxy_ide_switch: "浏览器访问时不可用：IDE 切号请在桌面窗口操作",
    proxy_oplog_export: "浏览器访问时不可用：导出日志请在桌面窗口操作",
    proxy_zcode_claim_mode: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
    proxy_zcode_device_repair: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
    proxy_zcode_device_status: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
    proxy_zcode_restore_mid: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
    proxy_zcode_switch_rollback: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
    proxy_zcode_solve_captcha: "浏览器访问时不可用：人机校验请在桌面号池页领取",
    admin_access_info: "浏览器访问时不可用：请在桌面窗口查看令牌",
    admin_reset_token: "浏览器访问时不可用：请在桌面窗口操作令牌",
    browse_dir: "浏览器访问时不可用：选择目录请在桌面窗口操作",
    open_data_dir: "浏览器访问时不可用：请在桌面窗口打开目录",
    get_data_dir: "浏览器访问时不可用：数据目录请在桌面窗口查看",
    get_app_version: "浏览器访问时不可用：版本信息请在桌面窗口查看",
    load_config: "浏览器访问时不可用：浏览器不支持整份配置读写，请用反代配置页",
    save_config: "浏览器访问时不可用：浏览器不支持整份配置读写，请用反代配置页",
  };
  const forbidden = ["容器", "编排", "docker", "宿主机", "gateway-data", "/api/accounts/import"];
  const denyCmds = Object.keys(commandTable.DENY_BROWSER);
  ok("DENY_BROWSER 命令集合 27 条", denyCmds.length === 27, String(denyCmds.length));
  const snapshotDiff = Object.keys(DENY_SNAPSHOT).filter((c) => commandTable.DENY_BROWSER[c] !== DENY_SNAPSHOT[c]);
  const extraCmds = denyCmds.filter((c) => !(c in DENY_SNAPSHOT));
  ok("27 条 deny 文案与快照逐字一致（合并时不许改字）", snapshotDiff.length === 0 && extraCmds.length === 0, `改动: ${snapshotDiff.join(",") || "-"} | 新增: ${extraCmds.join(",") || "-"}`);

  const leaks = [];
  for (const cmd of denyCmds) {
    const reason = String(commandTable.denyReason(cmd) || "");
    if (!reason) leaks.push(`${cmd}: 文案为空`);
    for (const w of forbidden) if (reason.includes(w)) leaks.push(`${cmd}: 含「${w}」`);
  }
  ok("每条 deny 文案不含容器形态措辞", leaks.length === 0, leaks.join("; "));
  ok(
    "capabilities 里桌面专用命令同样下发 deny",
    browserOnly.every((c) => caps.commands && caps.commands[c] && caps.commands[c].mode === "deny" && !!caps.commands[c].reason),
    JSON.stringify(browserOnly.map((c) => caps.commands && caps.commands[c]))
  );
  ok(
    "capabilities 里下发的 deny 原因不带容器形态措辞",
    Object.entries(caps.commands || {}).every(([cmd, v]) => v.mode !== "deny" || !forbidden.some((w) => String(v.reason || "").includes(w))),
    JSON.stringify(Object.entries(caps.commands || {}).filter(([cmd, v]) => v.mode === "deny" && forbidden.some((w) => String(v.reason || "").includes(w))))
  );

  // ===== /api/status：轻量状态（Ruling 14），不跑全量 proxy_status =====
  const stRes = await get(base(first.port) + "/api/status");
  const st = await stRes.json();
  ok("GET /api/status 200 且 ok", stRes.status === 200 && st.ok === true, `status=${stRes.status} body=${JSON.stringify(st).slice(0, 200)}`);
  ok("/api/status 只给轻量字段（running/port/bind/version，无 today/channels/keyCount）", st.ok === true && !!st.gateway && typeof st.gateway.running === "boolean" && typeof st.gateway.port === "number" && typeof st.gateway.bind === "string" && typeof st.version === "string" && !("today" in st) && !("channels" in st) && !("keyCount" in st), JSON.stringify(st).slice(0, 300));

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
  const rpcBody = await rpcRes.json();
  ok("POST /api/rpc 已挂载且未鉴权被拒（401 统一文案）", rpcRes.status === 401 && !!rpcBody && rpcBody.message === "未授权", `status=${rpcRes.status} body=${JSON.stringify(rpcBody)}`);

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

  // ===== 并发 start 不泄漏端口（模块内串行化，评审 Important 2） =====
  const [concA, concB] = await Promise.all([admin.start({ port: PROXY_PORT_A, commandTable, staticDir: STATIC_DIR }), admin.start({ port: PROXY_PORT_C, commandTable, staticDir: STATIC_DIR })]);
  ok("并发两次 start 各自返回端口", !!concA && !!concB && concA.port === PROXY_PORT_A + 1 && concB.port === PROXY_PORT_C + 1, `${JSON.stringify(concA)} ${JSON.stringify(concB)}`);
  await admin.stop();
  ok("并发 start 后 stop 全部关闭（A 端口）", !(await reachable(concA.port)));
  ok("并发 start 后 stop 全部关闭（C 端口）", !(await reachable(concB.port)));

  // ===== 启动失败后仍能重新启动旧端口 =====
  // 注意：这条验证的是 start/stop 的可恢复性；main.cjs 的「失败回滚」分支在纯 Node 下无法覆盖
  // （需要 Electron 主进程 + 反代事件联动），留待手工验证，不在自测通过数里冒充已测。
  let rejectErr = null;
  try {
    await admin.start({ port: 65535, commandTable, staticDir: STATIC_DIR });
  } catch (e) {
    rejectErr = e;
  }
  const back = await admin.start({ port: PROXY_PORT_A, commandTable, staticDir: STATIC_DIR });
  ok("启动失败后仍能重新启动旧端口", !!rejectErr && !!back && back.port === first.port && (await reachable(back.port)), `rejectErr=${rejectErr && rejectErr.message} back=${JSON.stringify(back)}`);
  await admin.stop();

  // ===== /api/status 不执行全量 proxy_status handler（Ruling 14，评审 Important 3） =====
  let proxyStatusCalls = 0;
  const realCommands = commandTable.collect();
  const counted = new Map(realCommands);
  const realStatus = realCommands.get("proxy_status");
  counted.set("proxy_status", (...args) => {
    proxyStatusCalls++;
    return realStatus(...args);
  });
  const countedTable = { collect: () => counted, modeOf: (c) => commandTable.modeOf(c), denyReason: (c) => commandTable.denyReason(c) };
  await admin.start({ port: PROXY_PORT_D, commandTable: countedTable, staticDir: STATIC_DIR });
  const st2 = await (await get(base(PROXY_PORT_D + 1) + "/api/status")).json();
  await get(base(PROXY_PORT_D + 1) + "/api/status");
  ok("/api/status 未调用 proxy_status handler（轻量状态）", proxyStatusCalls === 0 && st2.ok === true, `calls=${proxyStatusCalls} body=${JSON.stringify(st2).slice(0, 200)}`);
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
