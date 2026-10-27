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
// 浏览器端反代配置读写自测（proxy_config_get / proxy_config_save）：
//   1 命令在收集表里、browser 形态不被 deny（Ruling 24），load_config / save_config 仍 deny；
//   2 proxy_config_get 返回 config.proxy 的真实值（不是默认值），且不吐整份配置；
//   3 proxy_config_save 只写反代配置段：
//     · 四个 out-of-band 字段（channelEnabled / checkinAutoRules / enableAnthropic / enableResponses）
//       以磁盘为准——渲染层旧快照提交不得冲掉（与 issue #90 同源风险，走同一份合并函数）；
//     · concurrency 等设置页拥有的字段照常生效；
//     · port / bind 忽略（浏览器改了也不生效：重启监听在 browser 形态被 deny）；
//     · 其它段（schedule.minimizeToTray 等）不受影响。
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实配置。
// 用法：node tools/proxy-config-web-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-proxy-cfg-web-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
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
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

// 收集器注入空 handle：只拿 { 命令 → handler }，与桌面 IPC / 管理服务同一份实现；
// 注入 deps.nativeTheme 是给 load_config 用的（纯 Node 没有 electron，取不到 nativeTheme 会走 fail 收口）
const commands = commandTable.collect({ deps: { nativeTheme: {} } });

console.log("");
console.log("=== 1 命令存在与形态门控（Ruling 24）===");
ok("proxy_config_get 在命令表里", commands.has("proxy_config_get"));
ok("proxy_config_save 在命令表里", commands.has("proxy_config_save"));
ok('modeOf("proxy_config_get", "browser") === "read"', commandTable.modeOf("proxy_config_get", "browser") === "read", commandTable.modeOf("proxy_config_get", "browser"));
ok('modeOf("proxy_config_save", "browser") === "write"', commandTable.modeOf("proxy_config_save", "browser") === "write", commandTable.modeOf("proxy_config_save", "browser"));
ok("两命令容器形态同口径（read / write）", commandTable.modeOf("proxy_config_get") === "read" && commandTable.modeOf("proxy_config_save") === "write", commandTable.modeOf("proxy_config_get") + "/" + commandTable.modeOf("proxy_config_save"));
ok("两命令均不在 DENY_BROWSER（浏览器可用、无 deny 文案）", !commandTable.DENY_BROWSER.proxy_config_get && !commandTable.DENY_BROWSER.proxy_config_save && commandTable.denyReason("proxy_config_get", "browser") == null && commandTable.denyReason("proxy_config_save", "browser") == null);
ok("load_config / save_config 在 browser 形态仍 deny", commandTable.modeOf("load_config", "browser") === "deny" && commandTable.modeOf("save_config", "browser") === "deny", commandTable.modeOf("load_config", "browser") + "/" + commandTable.modeOf("save_config", "browser"));
ok("proxy_config_get 在 READ 集合（仅界面分类）", commandTable.READ.has("proxy_config_get") && !commandTable.READ.has("proxy_config_save"));

// —— 磁盘初值：模拟用户已用「上游启闭 / 自动签到」弹窗与手工改 config.json 设好 ——
console.log("");
console.log("=== 2 磁盘初始状态 ===");
{
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = { lobster: false };
  cfg.proxy.checkinAutoRules = { lobster: { enabled: true, time: "08:30", jitterMin: 30 } };
  cfg.proxy.enableAnthropic = false;
  cfg.proxy.enableResponses = false;
  cfg.proxy.concurrency = 3;
  cfg.proxy.port = 9527;
  cfg.proxy.bind = "127.0.0.1";
  // 三个「提交后要被改掉」的基准值（都取非默认值，防默认值撞车假绿）+ 一个「不许被重置」的字段
  cfg.proxy.debugStatus = false;
  cfg.proxy.usageRetentionDays = 77;
  cfg.proxy.channelCooldownMs = 45000;
  cfg.schedule.minimizeToTray = true;
  config.saveConfig(cfg);
}
const disk0 = config.loadConfig().proxy;
ok("磁盘已记录 channelEnabled.lobster=false", disk0.channelEnabled && disk0.channelEnabled.lobster === false);
ok("磁盘已记录 checkinAutoRules.lobster 开", !!(disk0.checkinAutoRules && disk0.checkinAutoRules.lobster && disk0.checkinAutoRules.lobster.enabled === true));
ok("磁盘已记录 enableAnthropic=false / enableResponses=false", disk0.enableAnthropic === false && disk0.enableResponses === false);

(async () => {
  const getFn = commands.get("proxy_config_get");
  const saveFn = commands.get("proxy_config_save");

  console.log("");
  console.log("=== 3 proxy_config_get：返回真实值、不吐整份配置 ===");
  if (!getFn) {
    ok("proxy_config_get 可执行", false, "命令未注册");
  } else {
    const got = await getFn(null, {});
    ok("返回 config.proxy 真实值（channelEnabled.lobster=false）", !!(got && got.channelEnabled && got.channelEnabled.lobster === false), JSON.stringify(got && got.channelEnabled));
    ok("返回磁盘 concurrency（3，不是默认值）", !!(got && Number(got.concurrency) === 3), String(got && got.concurrency));
    ok("不吐整份配置（无 theme / admin / schedule 段）", !!got && !("theme" in got) && !("admin" in got) && !("schedule" in got), got ? Object.keys(got).slice(0, 8).join(",") : "null");
  }

  console.log("");
  console.log("=== 4 proxy_config_save：真实前端入参形状（{ config: <反代配置段> }）===");
  if (!saveFn) {
    ok("proxy_config_save 可执行", false, "命令未注册");
    ok("proxy_config_save 拒绝非法入参", false, "命令未注册");
  } else {
    const badInput = await saveFn(null, { config: null });
    ok("非法入参返回 { ok:false }（不裸抛）", !!(badInput && badInput.ok === false), JSON.stringify(badInput));
    const arrInput = await saveFn(null, { config: [1, 2, 3] });
    ok("proxy 段为数组时拒绝（Ruling 27）", !!(arrInput && arrInput.ok === false), JSON.stringify(arrInput));

    // 前端（ConfigProxySection.vue）提交的就是反代配置段本身（表单快照），不是整份配置；
    // 值一律取非默认值（concurrency 默认恰好是 8，用 8 会撞默认值假绿）
    const stale = {
      channelEnabled: { lobster: true },
      checkinAutoRules: {},
      enableAnthropic: true,
      enableResponses: true,
      port: 9600,
      bind: "0.0.0.0",
      concurrency: 9,
      debugStatus: true,
      usageRetentionDays: 30,
    };
    const r = await saveFn(null, { config: stale });
    ok("保存成功", !!(r && r.ok === true), JSON.stringify(r));

    const after = config.loadConfig().proxy;
    ok("channelEnabled 以磁盘为准（lobster 仍关闭）", after.channelEnabled && after.channelEnabled.lobster === false, JSON.stringify(after.channelEnabled));
    ok("checkinAutoRules 以磁盘为准（lobster 规则未被冲掉）", !!(after.checkinAutoRules && after.checkinAutoRules.lobster && after.checkinAutoRules.lobster.enabled === true), JSON.stringify(after.checkinAutoRules));
    ok("enableAnthropic 以磁盘为准（仍 false）", after.enableAnthropic === false, JSON.stringify(after.enableAnthropic));
    ok("enableResponses 以磁盘为准（仍 false）", after.enableResponses === false, JSON.stringify(after.enableResponses));
    ok("concurrency=9 真正落盘", Number(after.concurrency) === 9, String(after.concurrency));
    ok("debugStatus=true 真正落盘", after.debugStatus === true, String(after.debugStatus));
    ok("usageRetentionDays=30 真正落盘", Number(after.usageRetentionDays) === 30, String(after.usageRetentionDays));
    ok("未提交字段保持磁盘值（channelCooldownMs=45000 不被重置）", Number(after.channelCooldownMs) === 45000, String(after.channelCooldownMs));
    ok("port 被忽略（仍 9527，浏览器改了不生效）", Number(after.port) === 9527, String(after.port));
    ok("bind 被忽略（仍 127.0.0.1）", after.bind === "127.0.0.1", String(after.bind));
    const whole = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    ok("只写 config.proxy（schedule.minimizeToTray 保持磁盘值）", whole.schedule && whole.schedule.minimizeToTray === true, JSON.stringify(whole.schedule));
    ok("数组入参被拒后 config.json 未被写坏（proxy 仍是对象）", !Array.isArray(whole.proxy) && typeof whole.proxy === "object", JSON.stringify(Array.isArray(whole.proxy) ? "proxy 是数组" : typeof whole.proxy));
  }

  console.log("");
  console.log("=== 5 磁盘无键时提交伪值也不落盘（严格磁盘优先）===");
  if (!saveFn) {
    ok("磁盘无键时提交的伪值不落盘", false, "命令未注册");
  } else {
    // 手工把这两个键从 config.json 里删掉 = 用户从未设置过，浏览器提交的值同样不该写进去
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    delete raw.proxy.enableAnthropic;
    delete raw.proxy.enableResponses;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
    const forged = JSON.parse(JSON.stringify(config.loadConfig().proxy));
    forged.enableAnthropic = true;
    forged.enableResponses = true;
    await saveFn(null, { config: forged });
    const after = config.loadConfig().proxy;
    ok("磁盘无键时提交的伪值不落盘", !("enableAnthropic" in after) && !("enableResponses" in after), JSON.stringify({ enableAnthropic: after.enableAnthropic, enableResponses: after.enableResponses }));
    const whole = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    ok("落盘文件里也没有这两个键", !("enableAnthropic" in whole.proxy) && !("enableResponses" in whole.proxy));
  }

  console.log("");
  console.log("=== 6 写盘后 load_config 快照立即反映（Ruling 26）===");
  const loadFn = commands.get("load_config");
  if (!saveFn || !loadFn) {
    ok("load_config / proxy_config_save 可执行", false, "命令未注册");
  } else {
    const c1 = await loadFn(null, {});
    ok("load_config 返回整份配置（含 proxy 段）", !!(c1 && c1.ok !== false && c1.proxy && c1.schedule), JSON.stringify(c1 && Object.keys(c1).slice(0, 6)));
    await saveFn(null, { config: { concurrency: 6 } });
    const c2 = await loadFn(null, {});
    ok("proxy_config_save 写盘后 load_config 立即拿到新值（concurrency=6）", !!(c2 && c2.proxy && Number(c2.proxy.concurrency) === 6), JSON.stringify(c2 && c2.proxy && c2.proxy.concurrency));
    ok("快照同步不破坏其余段（schedule.minimizeToTray 仍 true）", !!(c2 && c2.schedule && c2.schedule.minimizeToTray === true), JSON.stringify(c2 && c2.schedule));
  }

  console.log("");
  console.log("=== 7 写盘成功后广播 config-changed（Ruling 28）===");
  // proxy/index.cjs 是按模块对象调 events.emit(...) 的，换掉 emit 即可当监听器
  const eventsModule = require("../electron/backend/proxy/events.cjs");
  const emitted = [];
  const origEmit = eventsModule.emit;
  eventsModule.emit = (payload) => emitted.push(payload);
  if (!saveFn || !loadFn || !commands.get("save_config")) {
    ok("proxy_config_save 广播 config-changed", false, "命令未注册");
    ok("入参非法被拒时不广播", false, "命令未注册");
    ok("浏览器写入不被桌面旧快照整份保存回滚", false, "命令未注册");
  } else {
    emitted.length = 0;
    await saveFn(null, { config: { concurrency: 4 } });
    ok('写盘成功后广播 { event: "config-changed" }', emitted.some((p) => p && p.event === "config-changed"), JSON.stringify(emitted));
    emitted.length = 0;
    await saveFn(null, { config: [1, 2] });
    ok("入参非法被拒时不广播", emitted.length === 0, JSON.stringify(emitted));

    // 模拟评审实测的回滚链路：浏览器写入 → 桌面收到 config-changed → refreshConfig（即 load_config）
    // → 桌面随后整份保存（切主题等）。快照必须取到浏览器刚写的值，整份保存才不会把它写回去
    await saveFn(null, { config: { concurrency: 9 } });
    const deskSnap = await loadFn(null, {});
    ok("桌面快照含浏览器写入值（concurrency=9）", !!(deskSnap && deskSnap.proxy && Number(deskSnap.proxy.concurrency) === 9), JSON.stringify(deskSnap && deskSnap.proxy && deskSnap.proxy.concurrency));
    const r2 = await commands.get("save_config")(null, { config: deskSnap });
    ok("整份保存成功", !!(r2 && r2.ok === true), JSON.stringify(r2));
    ok("浏览器写入未被整份保存回滚（concurrency 仍 9）", Number(config.loadConfig().proxy.concurrency) === 9, String(config.loadConfig().proxy.concurrency));
  }
  eventsModule.emit = origEmit;

  console.log("");
  console.log("RESULT: " + pass + " passed / " + fail + " failed");
  if (bad.length) { console.log("failures:"); bad.forEach((x) => console.log("  - " + x)); }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
