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
// admin_access_info 的管理地址 = 反代端口 + 1（局域网 / 回环两个地址，端口非法时明确不可用），
// 不依赖管理服务是否已启动；
// admin_set_token 校验（非空、≥16 位）并在成功后触发令牌变更钩子（会话模块启动时注册 clearSessions）；
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

  // ===== A. 首次启动自动生成 admin 令牌 =====
  console.log("=== A. 令牌自动生成 ===");
  const t1 = config.ensureAdminToken();
  ok("A1 首次生成非空令牌", typeof t1 === "string" && t1.length > 0, String(t1));
  ok("A2 24 字节随机 = 48 位 hex", /^[0-9a-f]{48}$/.test(t1), t1);
  const rawDisk = fs.readFileSync(cfgPath, "utf8");
  ok("A3 落盘为密文（明文不进 config.json）", !rawDisk.includes(t1) && config.isEncrypted(config.loadConfig().admin.token), rawDisk.slice(0, 80));
  ok("A4 再次调用幂等（不换令牌）", config.ensureAdminToken() === t1);
  ok("A5 adminAccessInfo 解出同一明文", config.adminAccessInfo().token === t1);

  // ===== B. 管理地址 = 反代端口 + 1（局域网 / 回环两个地址） =====
  console.log("=== B. 管理地址 ===");
  const cfg = config.loadConfig();
  cfg.proxy.port = 9600;
  config.saveConfig(cfg);
  const info = config.adminAccessInfo();
  ok("B1 地址以 http:// 开头", String(info.url).startsWith("http://"), info.url);
  ok("B2 端口为反代端口 + 1", String(info.loopbackUrl).endsWith(":9601"), info.loopbackUrl);
  ok("B3 返回令牌明文（桌面 IPC 专用）", info.token === t1);
  ok("B4 端口 9600 合法时 available=true", info.available === true && info.message === "", JSON.stringify(info.message));
  ok("B5 回环地址固定 127.0.0.1", info.loopbackUrl === "http://127.0.0.1:9601", info.loopbackUrl);
  ok("B6 局域网地址为空或同端口 http 地址", info.lanUrl === "" || /^http:\/\/.+:9601$/.test(info.lanUrl), info.lanUrl);
  ok("B7 url 优先局域网、取不到回退回环", info.url === (info.lanUrl || info.loopbackUrl), info.url);

  // —— 端口非法（0 / 65535）→ 明确不可用 ——
  cfg.proxy.port = 0;
  config.saveConfig(cfg);
  const bad0 = config.adminAccessInfo();
  ok("B8 端口 0 → available=false、地址为空", bad0.available === false && bad0.url === "" && bad0.loopbackUrl === "" && bad0.lanUrl === "", JSON.stringify(bad0));
  ok("B9 不可用时有明确提示", String(bad0.message).length > 0, bad0.message);
  cfg.proxy.port = 65535;
  config.saveConfig(cfg);
  const bad1 = config.adminAccessInfo();
  ok("B10 端口 65535（+1 越界）→ available=false", bad1.available === false && bad1.url === "" && bad1.loopbackUrl === "", bad1.url);
  cfg.proxy.port = 9600;
  config.saveConfig(cfg);

  // ===== C. admin_set_token 校验 =====
  console.log("=== C. 令牌修改校验 ===");
  ok("C1 空串被拒绝", config.setAdminToken("").ok === false);
  ok("C2 15 位被拒绝", config.setAdminToken("x".repeat(15)).ok === false);
  ok("C3 被拒后令牌不变", config.adminAccessInfo().token === t1);
  const r = config.setAdminToken("n3w-t0ken-0123456789abcdef");
  ok("C4 16 位以上接受", r.ok === true, JSON.stringify(r));
  ok("C5 修改后令牌更新", config.adminAccessInfo().token === "n3w-t0ken-0123456789abcdef");
  ok("C6 新令牌同样加密落盘", !fs.readFileSync(cfgPath, "utf8").includes("n3w-t0ken"));

  // ===== D. 令牌变更钩子（会话模块 adminCrypto 启动时注册 clearSessions；这里验接线本身） =====
  console.log("=== D. 令牌变更钩子 ===");
  let hookCalls = 0;
  const offHook = config.onAdminTokenChanged(() => { hookCalls++; });
  config.setAdminToken("hook-t0ken-0123456789abcdef");
  ok("D1 修改令牌后钩子被调用一次", hookCalls === 1, String(hookCalls));
  config.setAdminToken("again-t0ken-0123456789ab");
  ok("D2 再次修改令牌钩子再被调用", hookCalls === 2, String(hookCalls));
  config.setAdminToken("short");
  ok("D3 校验被拒不触发钩子", hookCalls === 2, String(hookCalls));
  offHook();
  config.setAdminToken("after-off-0123456789abc");
  ok("D4 退订后不再触发", hookCalls === 2, String(hookCalls));

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
} finally {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
}
process.exit(fail ? 1 : 0);
