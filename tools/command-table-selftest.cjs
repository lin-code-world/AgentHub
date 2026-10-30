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
// 命令表自测：commandTable.collect 的收集结果与门控语义。
// 桌面 IPC 与管理 HTTP 服务共用这一份 { 命令 → handler }：框架命令（load_config 等）
// 与网关命令（proxy_*）必须在同一张表里，收集漏了哪边就在 Web/远程端静默不可达。
// 纯 Node 跑（不加载 electron）：收集只注册闭包不执行，容器里没装 electron 包也能过。
// 用法：node tools/command-table-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cmdtable-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

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

const ROOT = path.join(__dirname, "..");
const commandTable = require(path.join(ROOT, "electron", "backend", "commandTable.cjs"));

// 注入收集器而不是 ipcMain：桌面注册与这里拿到的是同一批 handler 闭包
const injected = [];
const commands = commandTable.collect({ handle: (cmd, fn) => injected.push([cmd, fn]) });

ok("collect 同时收集框架命令与网关命令", commands.has("load_config") && commands.has("proxy_pool"), `load_config=${commands.has("load_config")} proxy_pool=${commands.has("proxy_pool")}`);
ok("每条命令的 handler 都是函数", commands.size > 0 && [...commands.values()].every((fn) => typeof fn === "function"), String(commands.size));
ok("注入的 handle 收到同一批 handler（IPC 只是转发）", injected.length === commands.size && injected.every(([c, fn]) => commands.get(c) === fn), `injected=${injected.length} commands=${commands.size}`);

// ===== 三集合比对（原 tools/proxy-command-table-selftest.cjs 并入）=====
// 真源是注册逻辑本身：ipc.cjs 的 handle("…") 与 proxy/index.cjs 的 ipcMain.handle("…")。
// 收集漏了 → 网页端静默不可达；preload 漏了 → 桌面端调用被白名单拦下。
function diff(a, b) {
  // Map 要取 keys()：直接 new Set(map) 得到的是 [key, fn] 条目对，has(字符串) 永远 false
  const bs = b instanceof Set ? b : new Set(b instanceof Map ? b.keys() : b);
  return [...a].filter((x) => !bs.has(x));
}
const registered = new Set([
  ...[...fs.readFileSync(path.join(ROOT, "electron", "backend", "ipc.cjs"), "utf8").matchAll(/handle\(\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", "index.cjs"), "utf8").matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]),
]);
const preloadSrc = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
const allowBlock = preloadSrc.slice(preloadSrc.indexOf("const ALLOWED_COMMANDS"), preloadSrc.indexOf("contextBridge.exposeInMainWorld"));
const allowed = new Set([...allowBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

ok("收集表非空且规模合理（≥60）", commands.size >= 60, String(commands.size));
ok(`收集集合 == 源码注册集合（${registered.size}）`, diff(commands.keys(), registered).length === 0 && diff(registered, commands.keys()).length === 0, `仅收集有: ${diff(commands.keys(), registered).join(",") || "-"} | 仅源码有: ${diff(registered, commands.keys()).join(",") || "-"}`);
ok(`收集集合 == preload 白名单集合（${allowed.size}）`, diff(commands.keys(), allowed).length === 0 && diff(allowed, commands.keys()).length === 0, `仅收集有: ${diff(commands.keys(), allowed).join(",") || "-"} | 仅白名单有: ${diff(allowed, commands.keys()).join(",") || "-"}`);
ok("分类闭合：每条命令都有 read/write/deny 之一", [...commands.keys()].every((c) => ["read", "write", "deny"].includes(commandTable.modeOf(c))));
ok("DENY_BROWSER 无未注册命令（防手滑写错名）", Object.keys(commandTable.DENY_BROWSER).every((c) => commands.has(c)), diff(new Set(Object.keys(commandTable.DENY_BROWSER)), commands).join(","));
ok("READ 无未注册命令", [...commandTable.READ].every((c) => commands.has(c)), diff(new Set(commandTable.READ), commands).join(","));
// proxy_scan 是唯一有意的重叠：界面分类为只读，网页端仍必须在服务端也拒（否则令牌能直读本机登录态候选）
ok("deny 与 read 无交集（proxy_scan 除外）", [...commandTable.READ].every((c) => c === "proxy_scan" || !commandTable.DENY_BROWSER[c]));
ok("每条 deny 都有面向用户的说明", Object.values(commandTable.DENY_BROWSER).every((v) => typeof v === "string" && v.length >= 8));

ok('modeOf("proxy_pool") === "read"', commandTable.modeOf("proxy_pool") === "read", commandTable.modeOf("proxy_pool"));
ok('modeOf("proxy_start") === "deny"', commandTable.modeOf("proxy_start") === "deny", commandTable.modeOf("proxy_start"));
// proxy_scan 只是界面分类为 read，网页端必须在服务端也 deny
ok('modeOf("proxy_scan") === "deny"', commandTable.modeOf("proxy_scan") === "deny", commandTable.modeOf("proxy_scan"));
ok('denyReason("proxy_scan") 有面向用户的文案', /扫描本机登录态/.test(String(commandTable.denyReason("proxy_scan"))), String(commandTable.denyReason("proxy_scan")));
ok('modeOf("save_config") === "deny"（网页端不允许整份配置读写）', commandTable.modeOf("save_config") === "deny", commandTable.modeOf("save_config"));
ok('denyReason("proxy_start") 是面向用户的文案', typeof commandTable.denyReason("proxy_start") === "string" && commandTable.denyReason("proxy_start").length >= 8, String(commandTable.denyReason("proxy_start")));
ok('denyReason("proxy_pool") 为空（非 deny 命令无原因）', commandTable.denyReason("proxy_pool") == null, String(commandTable.denyReason("proxy_pool")));

ok("任务 3 的管理命令在命令表里（桌面形态）", commands.has("admin_access_info") && commands.has("admin_reset_token"), `admin_access_info=${commands.has("admin_access_info")} admin_reset_token=${commands.has("admin_reset_token")}`);

(async () => {
  // 取 electron 的命令抛错时必须走 wrap 的 fail 收口（返回 { ok:false }），不能裸抛 reject 到调用方：
  // 注入必抛的 deps 模拟 electron 不可用，handler 没包 wrap 时这里会接到裸抛
  const boom = {
    app: {
      getVersion: () => {
        throw new Error("模拟 electron 不可用");
      },
    },
    shell: {
      openPath: async () => {
        throw new Error("模拟 electron 不可用");
      },
    },
    dialog: {
      showOpenDialog: async () => {
        throw new Error("模拟 electron 不可用");
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    nativeTheme: {},
  };
  const boomTable = commandTable.collect({ deps: boom });
  for (const cmd of ["get_app_version", "open_data_dir", "browse_dir"]) {
    try {
      const r = await boomTable.get(cmd)(null, {});
      ok(`${cmd} 抛错时走 fail 收口（不裸抛）`, !!r && r.ok === false, JSON.stringify(r));
    } catch (e) {
      ok(`${cmd} 抛错时走 fail 收口（不裸抛）`, false, "裸抛: " + ((e && e.message) || e));
    }
  }
  // 补 wrap 不改成功路径的返回值：get_app_version 仍回版本字符串
  const good = commandTable.collect({ deps: { app: { getVersion: () => "1.2.3" } } });
  const ver = await good.get("get_app_version")(null, {});
  ok("get_app_version 成功路径仍返回版本字符串（wrap 不改返回值）", ver === "1.2.3", JSON.stringify(ver));

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
