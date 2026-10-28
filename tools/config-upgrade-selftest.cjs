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
// 旧配置升级兼容自测：loadConfig() 对旧配置只补缺失字段、不覆盖已有值；
// 号池同步 / 远程实例残留字段剔除不报错；「最小化到托盘」升级时强制开启、用户显式关闭后不再强制；
// admin 令牌字段（密文）随默认配置补齐；版本升级标记（规格 9.1）旧配置置位、新配置不置位。
// 目录沙箱运行，绝不触碰真实配置。
// 用法：node tools/config-upgrade-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfgupgrade-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");

// 自测主体套 try/finally：抛错也保证沙箱被删（process.exit 在 finally 之后，finally 里不能提前 exit）
try {
  // —— 安全闸门：任何写盘都必须在沙箱内 ——
  const cfgPath = config.configPath();
  const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
  console.log("=== 安全闸门 ===");
  console.log("  沙箱 = " + SANDBOX);
  console.log("  配置路径 = " + cfgPath);
  if (!inSandbox) {
    console.error("配置路径不在沙箱内，中止！");
    // process.exit 不走 finally：这里手动收尾沙箱再退出
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 沙箱残留不影响结论 */ }
    process.exit(2);
  }

  /** 直接写磁盘配置（模拟手改 / 旧版本落盘的 config.json） */
  function writeDisk(cfg) {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  }

  // ===== A. 旧配置：只补缺失字段、不覆盖已有值 =====
  console.log("=== A. 旧配置读取（补缺不覆盖） ===");
  writeDisk({
    // 旧版号池同步 / 远程实例字段（任务 1/2 已删除功能的残留）
    webdavShared: { endpoint: "https://dav.example.com", enabled: true },
    remoteTargets: [{ id: "r1", name: "旧远程", base: "http://192.168.1.9:9528" }],
    // 旧版全局开关：升级时强制开启（用户显式关闭后不再强制，见 D 组）
    schedule: { minimizeToTray: false, autoStart: true },
    proxy: { poolsyncSchedule: { everyMin: 30 }, port: 9600 },
    theme: "dark",
  });
  let c = config.loadConfig();
  ok("A1 已有值不被覆盖：proxy.port=9600", c.proxy.port === 9600, String(c.proxy.port));
  ok("A2 已有值不被覆盖：theme=dark", c.theme === "dark", String(c.theme));
  ok("A3 已有值不被覆盖：schedule.autoStart=true", c.schedule.autoStart === true, String(c.schedule.autoStart));
  ok("A4 缺失字段补齐：proxy.concurrency=8", c.proxy.concurrency === 8, String(c.proxy.concurrency));
  ok("A5 缺失字段补齐：admin.token 为空串", c.admin && c.admin.token === "", JSON.stringify(c.admin));

  // ===== B. 升级强制托盘常驻 =====
  console.log("=== B. minimizeToTray 升级强制 ===");
  ok("B1 旧配置 minimizeToTray=false 读取后强制 true", c.schedule.minimizeToTray === true, String(c.schedule.minimizeToTray));

  // ===== C. 同步 / 远程残留字段剔除且不报错 =====
  console.log("=== C. 旧字段剔除 ===");
  ok("C1 webdavShared 不再读取", !("webdavShared" in c), Object.keys(c).join(","));
  ok("C2 remoteTargets 不再读取", !("remoteTargets" in c));
  ok("C3 proxy.poolsyncSchedule 不再读取", !("poolsyncSchedule" in c.proxy), Object.keys(c.proxy).join(","));
  ok("C4 残留字段剔除不抛错（loadConfig 正常返回）", c && typeof c === "object");

  // ===== D. 升级标记：用户显式关闭后不再强制 =====
  console.log("=== D. 用户显式关闭不被强制 ===");
  writeDisk({ configVersion: 2, schedule: { minimizeToTray: false }, proxy: { port: 9600 } });
  c = config.loadConfig();
  ok("D1 已升级配置的 minimizeToTray=false 保持 false", c.schedule.minimizeToTray === false, String(c.schedule.minimizeToTray));

  // ===== E. admin 令牌默认值 =====
  console.log("=== E. admin 默认值 ===");
  ok("E1 defaultConfig().admin.token === \"\"", config.defaultConfig().admin && config.defaultConfig().admin.token === "");
  ok("E2 defaultConfig() 含 configVersion 升级标记", config.defaultConfig().configVersion === 2, String(config.defaultConfig().configVersion));

  // ===== F. 版本升级标记（规格 9.1）：旧配置读取后标记为已升级；新配置不记 =====
  console.log("=== F. 版本升级标记 ===");
  writeDisk({ theme: "dark", proxy: { port: 9600 } }); // 无 configVersion 的旧配置
  c = config.loadConfig();
  ok("F1 旧配置（无 configVersion）读取后标记为已升级", config.wasLastLoadLegacy() === true, String(config.wasLastLoadLegacy()));
  writeDisk({ configVersion: 2, theme: "dark", proxy: { port: 9600 } });
  c = config.loadConfig();
  ok("F2 新配置（configVersion: 2）不标记升级", config.wasLastLoadLegacy() === false, String(config.wasLastLoadLegacy()));
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  ok("F3 main.cjs 接线升级日志（oplog「版本升级」，boot 后写、失败静默）", /版本升级/.test(mainSrc) && /wasLastLoadLegacy/.test(mainSrc) && /升级日志失败不影响启动/.test(mainSrc), "未找到版本升级日志接线");

  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) { console.log("失败项："); for (const b of bad) console.log("  - " + b); }
} finally {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
}
process.exit(fail ? 1 : 0);
