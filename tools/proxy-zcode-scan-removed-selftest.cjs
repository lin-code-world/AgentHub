/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-31
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// ZCode 添加入口改造自测（Task 5 第 1 条）：下线「从本机软件导入」
//   1 基线：沙箱里放一份假 live 凭据，证明 scanZcode 原本能扫到候选（否则第 3 条是空过）；
//   2 isScanImportAllowed：zcode 为 false，其余渠道保持 true；
//   3 scanAll() 汇总里不再出现 zcode 候选（只摘 scanAll 的挂载，scanZcode 本身保留给 LIVE 探针）；
//   4 绕过界面直接调 proxy_scan_import 也被后端拒绝（只关界面挡不住直接调接口）。
// 沙箱：ZCODE_V2_DIR / APPDATA / AGENTHUB_DATA_DIR 全部指向临时目录（discovery 会拉起 store（sqlite）），
//       绝不读写真实用户数据。
// 用法（必须 Electron 的 Node，系统 Node 缺 node:sqlite）：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-scan-removed-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-scan-removed-"));
process.env.ZCODE_V2_DIR = SANDBOX;
process.env.APPDATA = SANDBOX;
process.env.AGENTHUB_DATA_DIR = path.join(SANDBOX, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const zcodeLocal = require(path.join(ROOT, "electron", "backend", "proxy", "zcodeLocal.cjs"));

// 假 live 凭据：只放 zcode 认的特征键（jwt + oauth:active_provider + 一对 oauth 令牌）
const UID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
fs.writeFileSync(
  zcodeLocal.paths().credentials,
  JSON.stringify({
    zcodejwttoken: zcodeLocal.encEncrypt(`h.${b64u({ user_id: UID })}.s`),
    "oauth:active_provider": zcodeLocal.encEncrypt("zai"),
    "oauth:zai:access_token": zcodeLocal.encEncrypt("at-fake"),
    "oauth:zai:refresh_token": zcodeLocal.encEncrypt("rt-fake"),
  }),
  "utf8"
);

const discovery = require(path.join(ROOT, "electron", "backend", "proxy", "discovery.cjs"));
const credits = require(path.join(ROOT, "electron", "backend", "proxy", "credits.cjs"));
const commandTable = require(path.join(ROOT, "electron", "backend", "commandTable.cjs"));

// 额度刷新测试替身：导入链路入池后会调它（真发请求会碰网络，这里只计数）
const refreshCalls = [];
credits.refreshAccount = async (id) => {
  refreshCalls.push(id);
  return {};
};

let pass = 0;
let fail = 0;
const bad = [];
// 断言用 thunk：函数内抛错（如函数未定义）也算失败，RED 阶段能给出可读输出而不是整个脚本崩掉
function ok(name, fn) {
  try {
    const r = typeof fn === "function" ? fn() : fn;
    if (r === true) {
      pass++;
      console.log(`  ok   ${name}`);
      return;
    }
    fail++;
    bad.push(name);
    console.log(`  FAIL ${name}（断言不成立）`);
  } catch (e) {
    fail++;
    bad.push(`${name}: ${(e && e.message) || e}`);
    console.log(`  FAIL ${name}: ${(e && e.message) || e}`);
  }
}

async function main() {
  console.log(`sandbox: ${SANDBOX}\n`);

  console.log("=== 0 基线：沙箱假 live 凭据能被 scanZcode 扫到 ===");
  ok("scanZcode() 产出候选（假凭据有效，后面摘除断言才有意义）", () => discovery.scanZcode().length > 0);
  ok("候选 uid 与假凭据一致", () => discovery.scanZcode()[0].uid === UID);

  console.log("");
  console.log("=== 1 isScanImportAllowed：zcode 关、其余渠道保持 ===");
  ok('isScanImportAllowed("zcode") === false', () => discovery.isScanImportAllowed("zcode") === false);
  ok('isScanImportAllowed("trae") === true', () => discovery.isScanImportAllowed("trae") === true);
  ok('isScanImportAllowed("qoder") === true', () => discovery.isScanImportAllowed("qoder") === true);

  console.log("");
  console.log("=== 2 scanAll() 汇总不再含 zcode 候选 ===");
  ok("scanAll() 结果里没有 channel === zcode", () => !discovery.scanAll().some((c) => c.channel === "zcode"));
  ok("scanZcode 仍单独可调（LIVE 探针用，仅从 scanAll 摘除）", () => typeof discovery.scanZcode === "function");

  console.log("");
  console.log("=== 3 proxy_scan_import 后端拒绝（绕过界面也挡）===");
  const commands = commandTable.collect({});
  const run = (cmd, args) => {
    const fn = commands.get(cmd);
    return fn ? fn(null, args) : Promise.resolve({ ok: false, message: `命令不存在：${cmd}` });
  };
  {
    const r = await run("proxy_scan_import", { index: 0, channel: "zcode", file: "credentials.json（当前登录）", uid: UID });
    ok("ok=false（后端拒绝）", () => r && r.ok === false);
    ok("提示说明该渠道不支持从本机导入", () => /本机/.test((r && r.message) || ""));
    ok("拒绝时没有落库（号池无 zcode 账号）", () => !refreshCalls.length);
  }
  {
    // 不带 file/uid 的裸下标调用同样要拒绝（前端有第二条调用形态）
    const r = await run("proxy_scan_import", { index: 0, channel: "zcode" });
    ok("裸下标调用同样被拒", () => r && r.ok === false && /本机/.test(r.message || ""));
  }
  {
    // proxy_scan 出口也不再列出 zcode 候选（扫描汇总口径一致）
    const scan = await run("proxy_scan", {});
    ok("proxy_scan 返回里没有 zcode 候选", () => Array.isArray(scan) && !scan.some((c) => c.channel === "zcode"));
  }

  console.log("");
  console.log("=== 4 resolveZcodeProvider：只认字面值 zai / bigmodel，其余一律回落配置默认 ===");
  // 语义：入参必须**原样**等于 zai 或 bigmodel；大小写变体、带空格、空串、非法值、
  // null/undefined 一律视为"没选"，回落配置默认 rules.zcode.oauthProvider，配置也缺失时兜底 zai
  // （选错一方会在兑换环节按错误的一方取值而失败）。
  ok("先确认已导出（否则本组断言无从谈起）", () => typeof discovery.resolveZcodeProvider === "function");
  ok('"zai" 原样（不被配置默认覆盖）', () => discovery.resolveZcodeProvider("zai", { oauthProvider: "bigmodel" }) === "zai");
  ok('"bigmodel" 原样（不被配置默认覆盖）', () => discovery.resolveZcodeProvider("bigmodel", { oauthProvider: "zai" }) === "bigmodel");
  ok('"ZAI" 大小写变体 → 回落配置默认 bigmodel', () => discovery.resolveZcodeProvider("ZAI", { oauthProvider: "bigmodel" }) === "bigmodel");
  ok('" zai " 带空格变体 → 回落配置默认 bigmodel', () => discovery.resolveZcodeProvider(" zai ", { oauthProvider: "bigmodel" }) === "bigmodel");
  ok('"weird" 非法值 → 回落配置默认 bigmodel', () => discovery.resolveZcodeProvider("weird", { oauthProvider: "bigmodel" }) === "bigmodel");
  ok('"" 空串 → 回落配置默认 bigmodel', () => discovery.resolveZcodeProvider("", { oauthProvider: "bigmodel" }) === "bigmodel");
  ok("undefined → 回落配置默认 bigmodel", () => discovery.resolveZcodeProvider(undefined, { oauthProvider: "bigmodel" }) === "bigmodel");
  ok("null → 回落配置默认 bigmodel", () => discovery.resolveZcodeProvider(null, { oauthProvider: "bigmodel" }) === "bigmodel");
  ok('配置也缺失 → 兜底 "zai"', () => discovery.resolveZcodeProvider(undefined, undefined) === "zai");
  ok('配置文件段为空对象 → 兜底 "zai"', () => discovery.resolveZcodeProvider("weird", {}) === "zai");

  console.log("");
  console.log(`结果：pass=${pass} fail=${fail}`);
  if (fail) {
    console.log(`失败项：\n  - ${bad.join("\n  - ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
