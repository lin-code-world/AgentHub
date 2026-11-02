/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-02
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 监听参数独立保存自测（proxy_set_listen，「设置 · 局域网访问」的「保存并重启」专用）：
//   1 命令在收集表里、browser 形态 deny（改监听地址属桌面专用能力）；
//   2 只改端口与绑定：其他字段（并发 / 保留期 / 刷新周期 / 渠道启闭 / 自动签到 / schedule 段）逐字不动；
//   3 端口守卫：0 / 65535 / 非数字拒绝且不写盘；
//   4 绑定地址归一化：只有显式 127.0.0.1 算仅本机，其余按 0.0.0.0；
//   5 写盘成功后广播 config-changed（与 proxy_config_save 同口径）。
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实配置。
// 用法：node tools/proxy-set-listen-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-set-listen-"));
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

const config = require("../electron/backend/config.cjs");
const commandTable = require("../electron/backend/commandTable.cjs");

// —— 安全闸门 ——
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  配置路径 = " + cfgPath);
ok("配置路径在沙箱内（绝不写真实配置）", inSandbox);
if (!inSandbox) {
  console.error("拒绝运行：配置路径不在沙箱内");
  process.exit(2);
}

const commands = commandTable.collect({ deps: { nativeTheme: {} } });

console.log("");
console.log("=== 1 命令存在与形态门控 ===");
ok("proxy_set_listen 在命令表里", commands.has("proxy_set_listen"));
ok('modeOf("proxy_set_listen") === "deny"（桌面专用）', commandTable.modeOf("proxy_set_listen") === "deny", commandTable.modeOf("proxy_set_listen"));
ok("deny 原因非空且是面向用户文案", typeof commandTable.denyReason("proxy_set_listen") === "string" && commandTable.denyReason("proxy_set_listen").length >= 8, String(commandTable.denyReason("proxy_set_listen")));
ok("不在 READ 集合（有副作用）", !commandTable.READ.has("proxy_set_listen"));

console.log("");
console.log("=== 2 磁盘初始状态（其他字段都设成非默认值，便于验「一个都没动」）===");
{
  const cfg = config.loadConfig();
  cfg.proxy.port = 9527;
  cfg.proxy.bind = "127.0.0.1";
  cfg.proxy.concurrency = 3;
  cfg.proxy.usageRetentionDays = 77;
  cfg.proxy.creditsRefreshMin = 60;
  cfg.proxy.channelEnabled = { lobster: false };
  cfg.proxy.checkinAutoRules = { lobster: { enabled: true, time: "08:30", jitterMin: 30 } };
  cfg.schedule.minimizeToTray = true;
  config.saveConfig(cfg);
  const d = config.loadConfig();
  ok("磁盘端口 9527 / 绑定 127.0.0.1", d.proxy.port === 9527 && d.proxy.bind === "127.0.0.1", JSON.stringify({ port: d.proxy.port, bind: d.proxy.bind }));
  ok("磁盘并发 3 / 保留期 77 / 刷新 60", d.proxy.concurrency === 3 && d.proxy.usageRetentionDays === 77 && d.proxy.creditsRefreshMin === 60, JSON.stringify({ c: d.proxy.concurrency, u: d.proxy.usageRetentionDays, r: d.proxy.creditsRefreshMin }));
}

async function main() {
  const setFn = commands.get("proxy_set_listen");
  if (!setFn) {
    ok("proxy_set_listen 可执行", false, "命令未注册");
    return;
  }

  console.log("");
  console.log("=== 3 只改端口与绑定：其他字段一个都没动 ===");
  {
    const r = await setFn(null, { port: 9600, bind: "0.0.0.0" });
    ok("调用返回 ok 且回带新值", !!(r && r.ok !== false && r.port === 9600 && r.bind === "0.0.0.0"), JSON.stringify(r));
    const after = config.loadConfig();
    ok("端口落盘 9600", after.proxy.port === 9600, String(after.proxy.port));
    ok("绑定落盘 0.0.0.0", after.proxy.bind === "0.0.0.0", String(after.proxy.bind));
    ok("并发保持 3（未被夹取 / 重置）", after.proxy.concurrency === 3, String(after.proxy.concurrency));
    ok("保留期保持 77", after.proxy.usageRetentionDays === 77, String(after.proxy.usageRetentionDays));
    ok("刷新周期保持 60", after.proxy.creditsRefreshMin === 60, String(after.proxy.creditsRefreshMin));
    ok("渠道启闭保持磁盘值（lobster=false）", after.proxy.channelEnabled && after.proxy.channelEnabled.lobster === false, JSON.stringify(after.proxy.channelEnabled));
    ok("自动签到规则保持磁盘值", !!(after.proxy.checkinAutoRules && after.proxy.checkinAutoRules.lobster && after.proxy.checkinAutoRules.lobster.enabled === true), JSON.stringify(after.proxy.checkinAutoRules));
    ok("非 proxy 段未受影响（schedule.minimizeToTray 仍 true）", after.schedule && after.schedule.minimizeToTray === true, JSON.stringify(after.schedule));
  }

  console.log("");
  console.log("=== 4 端口守卫：非法一律拒绝且不写盘 ===");
  {
    const before = config.loadConfig().proxy.port;
    for (const [label, p] of [["0", 0], ["65535", 65535], ["非数字", "abc"]]) {
      const r = await setFn(null, { port: p, bind: "0.0.0.0" });
      ok(`端口 ${label} 被拒（ok:false）`, !!(r && r.ok === false), JSON.stringify(r));
    }
    ok("被拒后端口未被写坏", config.loadConfig().proxy.port === before, String(config.loadConfig().proxy.port));
  }

  console.log("");
  console.log("=== 5 绑定地址归一化 ===");
  {
    const r = await setFn(null, { port: 9600, bind: "1.2.3.4" });
    ok("意外绑定值兜底 0.0.0.0", !!(r && r.ok !== false && config.loadConfig().proxy.bind === "0.0.0.0"), JSON.stringify(r));
    await setFn(null, { port: 9600, bind: "127.0.0.1" });
    ok("显式 127.0.0.1 保留", config.loadConfig().proxy.bind === "127.0.0.1", config.loadConfig().proxy.bind);
  }

  console.log("");
  console.log("=== 6 写盘成功后广播 config-changed ===");
  {
    // proxy/index.cjs 是按模块对象调 events.emit(...) 的，换掉 emit 即可当监听器
    const eventsModule = require("../electron/backend/proxy/events.cjs");
    const emitted = [];
    const origEmit = eventsModule.emit;
    eventsModule.emit = (payload) => emitted.push(payload);
    try {
      emitted.length = 0;
      await setFn(null, { port: 9700, bind: "0.0.0.0" });
      ok('成功写入广播 { event: "config-changed" }', emitted.some((p) => p && p.event === "config-changed"), JSON.stringify(emitted));
      emitted.length = 0;
      await setFn(null, { port: 0, bind: "0.0.0.0" });
      ok("非法端口被拒时不广播", emitted.length === 0, JSON.stringify(emitted));
    } finally {
      eventsModule.emit = origEmit;
    }
  }
}

main().then(() => {
  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) {
    console.log("失败项：");
    for (const b of bad) console.log("  - " + b);
  }
  process.exit(fail ? 1 : 0);
});
