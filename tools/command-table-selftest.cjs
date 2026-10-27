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

ok('modeOf("proxy_pool") === "read"', commandTable.modeOf("proxy_pool") === "read", commandTable.modeOf("proxy_pool"));
ok('modeOf("proxy_start") === "deny"', commandTable.modeOf("proxy_start") === "deny", commandTable.modeOf("proxy_start"));
// I1：proxy_scan 只是界面分类为 read，浏览器形态必须在服务端也 deny（否则令牌能直读本机登录态候选）
ok('modeOf("proxy_scan", "browser") === "deny"', commandTable.modeOf("proxy_scan", "browser") === "deny", commandTable.modeOf("proxy_scan", "browser"));
ok('denyReason("proxy_scan", "browser") 有浏览器口径文案', /扫描本机登录态/.test(String(commandTable.denyReason("proxy_scan", "browser"))), String(commandTable.denyReason("proxy_scan", "browser")));
ok('容器形态 proxy_scan 仍为 read（口径不变）', commandTable.modeOf("proxy_scan") === "read", commandTable.modeOf("proxy_scan"));
ok('modeOf("save_config") === "write"', commandTable.modeOf("save_config") === "write", commandTable.modeOf("save_config"));
ok('denyReason("proxy_start") 是面向用户的文案', typeof commandTable.denyReason("proxy_start") === "string" && commandTable.denyReason("proxy_start").length >= 8, String(commandTable.denyReason("proxy_start")));
ok('denyReason("proxy_pool") 为空（非 deny 命令无原因）', commandTable.denyReason("proxy_pool") == null, String(commandTable.denyReason("proxy_pool")));

ok("任务 3 的管理命令在命令表里（桌面形态）", commands.has("admin_access_info") && commands.has("admin_set_token"), `admin_access_info=${commands.has("admin_access_info")} admin_set_token=${commands.has("admin_set_token")}`);

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
