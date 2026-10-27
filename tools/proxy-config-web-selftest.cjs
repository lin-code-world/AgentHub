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

// 收集器注入空 handle：只拿 { 命令 → handler }，与桌面 IPC / 管理服务同一份实现
const commands = commandTable.collect({});

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
  console.log("=== 4 proxy_config_save：旧快照不得冲掉 out-of-band 字段 ===");
  if (!saveFn) {
    ok("proxy_config_save 可执行", false, "命令未注册");
    ok("proxy_config_save 拒绝非法入参", false, "命令未注册");
  } else {
    const badInput = await saveFn(null, { config: null });
    ok("非法入参返回 { ok:false }（不裸抛）", !!(badInput && badInput.ok === false), JSON.stringify(badInput));

    // 旧快照：out-of-band 四字段是「过期的错值」，port/bind 是浏览器不该改的两项
    const stale = JSON.parse(JSON.stringify(config.defaultConfig().proxy));
    stale.channelEnabled = { lobster: true };
    stale.checkinAutoRules = {};
    stale.enableAnthropic = true;
    stale.enableResponses = true;
    stale.port = 9600;
    stale.bind = "0.0.0.0";
    stale.concurrency = 8;
    const r = await saveFn(null, { config: stale });
    ok("保存成功", !!(r && r.ok === true), JSON.stringify(r));

    const after = config.loadConfig().proxy;
    ok("channelEnabled 以磁盘为准（lobster 仍关闭）", after.channelEnabled && after.channelEnabled.lobster === false, JSON.stringify(after.channelEnabled));
    ok("checkinAutoRules 以磁盘为准（lobster 规则未被冲掉）", !!(after.checkinAutoRules && after.checkinAutoRules.lobster && after.checkinAutoRules.lobster.enabled === true), JSON.stringify(after.checkinAutoRules));
    ok("enableAnthropic 以磁盘为准（仍 false）", after.enableAnthropic === false, JSON.stringify(after.enableAnthropic));
    ok("enableResponses 以磁盘为准（仍 false）", after.enableResponses === false, JSON.stringify(after.enableResponses));
    ok("concurrency=8 生效（设置页拥有的字段照常写入）", Number(after.concurrency) === 8, String(after.concurrency));
    ok("port 被忽略（仍 9527，浏览器改了不生效）", Number(after.port) === 9527, String(after.port));
    ok("bind 被忽略（仍 127.0.0.1）", after.bind === "127.0.0.1", String(after.bind));
    const whole = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    ok("只写 config.proxy（schedule.minimizeToTray 保持磁盘值）", whole.schedule && whole.schedule.minimizeToTray === true, JSON.stringify(whole.schedule));
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
  console.log("RESULT: " + pass + " passed / " + fail + " failed");
  if (bad.length) { console.log("failures:"); bad.forEach((x) => console.log("  - " + x)); }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
