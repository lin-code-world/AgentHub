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
// 远程实例模块移除守卫：后端模块、配置字段、IPC 命令、前端入口一律不得再出现，
// 同时钉住 zcode 设备指纹（anchor.remoteMid）不得被误当远程实例删掉。
// 运行：node scripts/test-remote-removed.cjs
// 沙箱：AGENTHUB_DATA_DIR 指向临时目录，绝不读写真实用户数据。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-remote-removed-"));
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

const readSrc = (rel) => fs.readFileSync(path.resolve(ROOT, rel), "utf8");

// ===== 断言 1：被删模块 require 必须抛 MODULE_NOT_FOUND =====
{
  let err = null;
  try {
    require(path.resolve(__dirname, "../electron/backend/proxy/remote.cjs"));
  } catch (e) {
    err = e;
  }
  ok(err && err.code === "MODULE_NOT_FOUND", "require electron/backend/proxy/remote.cjs 抛 MODULE_NOT_FOUND", err ? `${err.code || ""} ${err.message}` : "模块仍可加载");
  for (const rel of ["src/api/remote.ts", "src/components/config/ConfigRemoteTargets.vue"]) {
    ok(!fs.existsSync(path.resolve(ROOT, rel)), `${rel} 文件已删除`);
  }
}

// ===== 断言 2：配置不含 remoteTargets / remoteActiveId =====
{
  const config = require("../electron/backend/config.cjs");
  const def = config.defaultConfig();
  ok(!Object.prototype.hasOwnProperty.call(def, "remoteTargets"), "defaultConfig() 无 remoteTargets");
  ok(!Object.prototype.hasOwnProperty.call(def, "remoteActiveId"), "defaultConfig() 无 remoteActiveId");
  // 旧配置残留字段：读取不许报错，且被剔除（不回流到保存结果）
  fs.writeFileSync(path.join(process.env.AGENTHUB_DATA_DIR, "config.json"), JSON.stringify({ remoteTargets: [{ id: "t1", alias: "旧目标", baseUrl: "http://10.0.0.2:9527", tokenEnc: "enc:v1:x" }], remoteActiveId: "t1" }), "utf8");
  let cfg = null;
  let loadErr = null;
  try {
    cfg = config.loadConfig();
  } catch (e) {
    loadErr = e;
  }
  ok(!loadErr && !!cfg, "旧配置残留 remoteTargets/remoteActiveId 时 loadConfig() 不抛错", loadErr ? loadErr.message : "无返回");
  ok(cfg && !Object.prototype.hasOwnProperty.call(cfg, "remoteTargets") && !Object.prototype.hasOwnProperty.call(cfg, "remoteActiveId"), "loadConfig() 剔除 remoteTargets / remoteActiveId");
}

// ===== 断言 3：IPC 三处（backend/ipc.cjs、preload.cjs、src/api/ipc.ts）无远程命令 =====
{
  const cmds = ["remote_targets_list", "remote_targets_save", "remote_targets_delete", "remote_targets_activate", "remote_test", "remote_invoke"];
  for (const rel of ["electron/backend/ipc.cjs", "electron/preload.cjs", "src/api/ipc.ts"]) {
    const src = readSrc(rel);
    for (const cmd of cmds) ok(!src.includes(cmd), `${rel} 无 ${cmd}`);
    ok(!/remoteActive|LOCAL_ONLY_CMDS/.test(src), `${rel} 无 remoteActive() / LOCAL_ONLY_CMDS 残留`);
  }
}

// ===== 断言 4：前端入口无远程目标切换与管理 =====
{
  const pageTabs = readSrc("src/components/PageTabs.vue");
  ok(!/remoteState|remoteActive|onRemoteCommand|tab-remote/.test(pageTabs), "PageTabs.vue 无本机/远程切换按钮");
  const section = readSrc("src/components/config/ConfigProxySection.vue");
  ok(!/ConfigRemoteTargets|远程实例/.test(section), "ConfigProxySection.vue 无「远程实例」子板块");
  const mainTs = readSrc("src/main.ts");
  ok(!/refreshRemoteState/.test(mainTs), "main.ts 无 refreshRemoteState");
  const types = readSrc("src/types/index.ts");
  ok(!/RemoteTarget|RemoteTestResult|remoteTargets|remoteActiveId/.test(types), "types 无 RemoteTarget / RemoteTestResult");
  const ipcTs = readSrc("src/api/ipc.ts");
  ok(!/RemoteTarget|remoteTargets/.test(ipcTs), "ipc.ts 无远程目标封装");
}

// ===== 断言 5：zcode 设备指纹（anchor.remoteMid）不属于远程实例，必须保留 =====
{
  const zl = readSrc("electron/backend/proxy/zcodeLocal.cjs");
  ok(/function restoreRemoteMid\s*\(/.test(zl) && /function remoteMidState\s*\(/.test(zl), "zcodeLocal.cjs 保留 restoreRemoteMid / remoteMidState");
}

const done = failed === 0;
console.log(`\n${done ? "OK" : "FAIL"} 远程实例移除守卫：${pass} 项通过，${failed} 项失败`);
process.exit(done ? 0 : 1);
