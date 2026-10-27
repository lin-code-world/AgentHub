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
// 管理令牌与局域网访问信息自测：首次启动自动生成 24 字节随机令牌（加密落盘、不写日志）；
// admin_access_info 的管理地址 = 反代端口 + 1（不依赖管理服务是否已启动）；
// admin_set_token 校验（非空、≥16 位）并作废所有会话（会话模块落地前 sessionCount 恒 0）；
// 三处同步守护：ipc.cjs 注册 == preload 白名单 == src/api/ipc.ts 封装。
// 目录沙箱运行，绝不触碰真实配置。用法：node tools/admin-access-info-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-admininfo-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;
// 自测环境无 Electron safeStorage：给密钥走 enc:v2:（AES-256-GCM）密文，
// 与 proxy-crypto-envelope-selftest.cjs 同款沙箱做法；不给密钥时 encryptSecret 是明文降级（既有行为）
process.env.AGENTHUB_SECRET_KEY = "selftest-secret-key-please-rotate";

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");

// —— 安全闸门：任何写盘都必须在沙箱内 ——
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  配置路径 = " + cfgPath);
if (!inSandbox) {
  console.error("配置路径不在沙箱内，中止！");
  process.exit(2);
}

// ===== A. 首次启动自动生成 admin 令牌 =====
console.log("=== A. 令牌自动生成 ===");
const t1 = config.ensureAdminToken();
ok("A1 首次生成非空令牌", typeof t1 === "string" && t1.length > 0, String(t1));
ok("A2 24 字节随机 = 48 位 hex", /^[0-9a-f]{48}$/.test(t1), t1);
const rawDisk = fs.readFileSync(cfgPath, "utf8");
ok("A3 落盘为密文（明文不进 config.json）", !rawDisk.includes(t1) && config.isEncrypted(config.loadConfig().admin.token), rawDisk.slice(0, 80));
ok("A4 再次调用幂等（不换令牌）", config.ensureAdminToken() === t1);
ok("A5 adminAccessInfo 解出同一明文", config.adminAccessInfo().token === t1);

// ===== B. 管理地址 = 反代端口 + 1 =====
console.log("=== B. 管理地址 ===");
const cfg = config.loadConfig();
cfg.proxy.port = 9600;
config.saveConfig(cfg);
const info = config.adminAccessInfo();
ok("B1 地址以 http:// 开头", String(info.url).startsWith("http://"), info.url);
ok("B2 端口为反代端口 + 1", String(info.url).endsWith(":9601"), info.url);
ok("B3 返回令牌明文（桌面 IPC 专用）", info.token === t1);

// ===== C. admin_set_token 校验 =====
console.log("=== C. 令牌修改校验 ===");
ok("C1 空串被拒绝", config.setAdminToken("").ok === false);
ok("C2 15 位被拒绝", config.setAdminToken("x".repeat(15)).ok === false);
ok("C3 被拒后令牌不变", config.adminAccessInfo().token === t1);
const r = config.setAdminToken("n3w-t0ken-0123456789abcdef");
ok("C4 16 位以上接受", r.ok === true, JSON.stringify(r));
ok("C5 修改后令牌更新", config.adminAccessInfo().token === "n3w-t0ken-0123456789abcdef");
ok("C6 新令牌同样加密落盘", !fs.readFileSync(cfgPath, "utf8").includes("n3w-t0ken"));

// ===== D. 修改令牌后清空所有会话（会话模块任务 6 落地前 sessionCount 恒 0） =====
console.log("=== D. 会话清空 ===");
ok("D1 修改令牌后 sessionCount() === 0", config.sessionCount() === 0, String(config.sessionCount()));
ok("D2 clearAdminSessions 占位存在且可调用", typeof config.clearAdminSessions === "function" && config.clearAdminSessions() === undefined);

// ===== E. 三处同步：ipc.cjs 注册 == preload 白名单 == src/api/ipc.ts 封装 =====
console.log("=== E. IPC 三处同步 ===");
const ROOT = path.join(__dirname, "..");
const ipcSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "ipc.cjs"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "src", "api", "ipc.ts"), "utf8");
for (const cmd of ["admin_access_info", "admin_set_token"]) {
  ok(`E[${cmd}] ipc.cjs 已注册`, ipcSrc.includes(`"${cmd}"`));
  ok(`E[${cmd}] preload 白名单已放行`, preloadSrc.includes(`"${cmd}"`));
  ok(`E[${cmd}] src/api/ipc.ts 已封装`, apiSrc.includes(`"${cmd}"`));
}

console.log("");
console.log(`RESULT: ${pass} passed / ${fail} failed`);
if (bad.length) { console.log("失败项："); for (const b of bad) console.log("  - " + b); }
process.exit(fail ? 1 : 0);
