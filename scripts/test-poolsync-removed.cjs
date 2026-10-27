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
// 号池 WebDAV/S3 同步移除守卫：模块、配置字段、IPC 命令一律不得再出现，
// 同时钉住必须保留的自动签到入口（startCheckinAuto / proxy_checkin_auto_set）。
// 运行：node scripts/test-poolsync-removed.cjs
// 沙箱：AGENTHUB_DATA_DIR 指向临时目录，绝不读写真实用户数据。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-poolsync-removed-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${extra ? " —— " + extra : ""}`);
  }
}

// ===== 断言 1：被删模块 require 必须抛 MODULE_NOT_FOUND =====
{
  const gone = ["../electron/backend/webdav.cjs", "../electron/backend/s3.cjs", "../electron/backend/proxy/poolsync.cjs", "../electron/backend/proxy/poolsched.cjs"];
  for (const rel of gone) {
    const p = path.resolve(__dirname, rel);
    let err = null;
    try {
      require(p);
    } catch (e) {
      err = e;
    }
    ok(err && err.code === "MODULE_NOT_FOUND", `require ${rel} 抛 MODULE_NOT_FOUND`, err ? `${err.code || ""} ${err.message}` : "模块仍可加载");
  }
}

// ===== 断言 2：默认配置不含 webdavShared / webdav.deviceId / proxy.poolsyncSchedule =====
{
  const config = require("../electron/backend/config.cjs");
  const def = config.defaultConfig();
  ok(!Object.prototype.hasOwnProperty.call(def, "webdavShared"), "defaultConfig() 无 webdavShared");
  ok(!Object.prototype.hasOwnProperty.call(def, "webdav"), "defaultConfig() 无 webdav 段");
  ok(def.proxy && !Object.prototype.hasOwnProperty.call(def.proxy, "poolsyncSchedule"), "defaultConfig().proxy 无 poolsyncSchedule");
  ok(typeof config.moduleWebdav !== "function" && typeof config.loadSharedWebdav !== "function", "config 不再导出共享 WebDAV 读写函数");
  const cfg = config.loadConfig();
  ok(!Object.prototype.hasOwnProperty.call(cfg, "webdavShared") && !Object.prototype.hasOwnProperty.call(cfg, "webdav"), "loadConfig() 结果无 webdavShared / webdav 段");
  ok(cfg.proxy && !Object.prototype.hasOwnProperty.call(cfg.proxy, "poolsyncSchedule"), "loadConfig().proxy 无 poolsyncSchedule");
}

// ===== 断言 3：命令表不含 webdav_shared_* / proxy_poolsync_* =====
{
  const readSrc = (rel) => fs.readFileSync(path.resolve(ROOT, rel), "utf8");
  const preload = readSrc("electron/preload.cjs");
  for (const cmd of ["webdav_shared_get", "webdav_shared_save", "webdav_shared_test", "webdav_shared_clear", "proxy_poolsync_status", "proxy_poolsync_run", "proxy_poolsync_cancel"]) {
    ok(!preload.includes(cmd), `preload 白名单无 ${cmd}`);
  }
  const ipcSrc = readSrc("electron/backend/ipc.cjs");
  ok(!ipcSrc.includes("webdav_shared_"), "ipc.cjs 无 webdav_shared_* 处理器");
  const proxySrc = readSrc("electron/backend/proxy/index.cjs");
  ok(!proxySrc.includes("proxy_poolsync_"), "proxy/index.cjs 无 proxy_poolsync_* 处理器");
  const gwCommands = readSrc("gateway/src/commands.cjs");
  ok(!gwCommands.includes("proxy_poolsync_"), "gateway 命令表无 proxy_poolsync_*");
  const ipcTs = readSrc("src/api/ipc.ts");
  ok(!ipcTs.includes("webdav_shared_") && !ipcTs.includes("proxy_poolsync_"), "src/api/ipc.ts 无同步命令封装");
}

// ===== 断言 4：startCheckinAuto 仍存在且是函数（自动签到必须保留） =====
{
  const proxySrc = fs.readFileSync(path.resolve(ROOT, "electron/backend/proxy/index.cjs"), "utf8");
  ok(/function startCheckinAuto\s*\(/.test(proxySrc), "proxy/index.cjs 仍定义 startCheckinAuto");
  ok(/^\s*startCheckinAuto\(\);/m.test(proxySrc), "boot/setRuntime 仍调用 startCheckinAuto()");
  ok(proxySrc.includes('"proxy_checkin_auto_set"'), "proxy/index.cjs 保留 proxy_checkin_auto_set 处理器");
  const preload = fs.readFileSync(path.resolve(ROOT, "electron/preload.cjs"), "utf8");
  ok(preload.includes('"proxy_checkin_auto_set"'), "preload 白名单保留 proxy_checkin_auto_set");
}

const done = failed === 0;
console.log(`\n${done ? "OK" : "FAIL"} 号池同步移除守卫：${pass} 项通过，${failed} 项失败`);
process.exit(done ? 0 : 1);
