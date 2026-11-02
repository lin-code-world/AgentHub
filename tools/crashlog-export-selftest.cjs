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
// 崩溃日志导出自测（crashlog.buildArchive + export_crash_logs / export_crash_logs_data 命令）：
//   1 无日志 → ok:false「暂无崩溃日志」；
//   2 打包内容 = 全部 crash.log 分段（最新在前）+ info.txt 在最后；
//   3 解压回的内容与磁盘一致（证明段归属与顺序正确）；
//   4 info.txt 含应用版本 / 系统等环境信息；
//   5 桌面版命令 export_crash_logs 在表里、browser 形态 deny；
//   6 浏览器版命令 export_crash_logs_data 在表里、网页端可用，回传的 base64 能解出同一个 zip。
// 全部在临时目录内运行，绝不触碰真实日志目录。
// 用法：node tools/crashlog-export-selftest.cjs
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-crashzip-"));
process.env.AGENTHUB_CRASHLOG_DIR = path.join(SANDBOX, "logs");
process.env.AGENTHUB_CRASHLOG_SEGMENT_BYTES = "2048"; // 小段：快速造出多段

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

const crashlog = require("../electron/backend/crashlog.cjs");
const zipmod = require("../electron/backend/zip.cjs");
const commandTable = require("../electron/backend/commandTable.cjs");

const dir = process.env.AGENTHUB_CRASHLOG_DIR;
const file = path.join(dir, "crash.log");

async function main() {
  console.log("=== 1 无日志 ===");
  {
    const r = crashlog.buildArchive();
    ok("无日志时 ok:false", r.ok === false, JSON.stringify(r));
    ok("提示为「暂无崩溃日志」", r.message === "暂无崩溃日志", String(r.message));
  }

  console.log("");
  console.log("=== 2 造三段日志（每段 2KB，触发两次轮转）===");
  function fill() {
    const st = fs.statSync(file);
    const need = 2048 - st.size;
    if (need > 0) fs.appendFileSync(file, "x".repeat(need));
  }
  crashlog.write("mark1", "first");
  fill();
  crashlog.write("mark2", "second"); // 含 mark1 的段 → .1
  fill();
  crashlog.write("mark3", "third"); // .1 → .2，含 mark2 的段 → .1
  ok(
    "磁盘上有三段（crash.log / .1 / .2）",
    ["crash.log", "crash.log.1", "crash.log.2"].every((n) => fs.existsSync(path.join(dir, n))),
    fs.readdirSync(dir).join(",")
  );

  console.log("");
  console.log("=== 3 打包内容 ===");
  {
    const r = crashlog.buildArchive();
    ok("打包成功且段数 = 3", r.ok === true && r.count === 3, JSON.stringify({ ok: r.ok, count: r.count }));
    const entries = zipmod.readZip(r.buffer);
    const names = entries.map((e) => e.name);
    ok("顺序：最新在前 + info.txt 在最后", names.join(",") === "crash.log,crash.log.1,crash.log.2,info.txt", names.join(","));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString("utf8")]));
    ok("crash.log（当前段）含 mark3", byName["crash.log"].includes("mark3"), byName["crash.log"].slice(0, 60));
    ok(".1 段含 mark2", byName["crash.log.1"].includes("mark2"));
    ok(".2 段含 mark1", byName["crash.log.2"].includes("mark1"));
    ok("info.txt 含应用版本行", /应用版本：/.test(byName["info.txt"]), byName["info.txt"].split("\r\n")[2]);
    ok("info.txt 含系统信息行", /操作系统：/.test(byName["info.txt"]));
    ok("info.txt 含分段清单（列出三个段名）", /crash\.log\.2/.test(byName["info.txt"]));
  }

  console.log("");
  console.log("=== 4 桌面版命令分类 ===");
  const commands = commandTable.collect({ deps: { nativeTheme: {} } });
  {
    ok("export_crash_logs 在命令表里", commands.has("export_crash_logs"));
    ok('modeOf === "deny"（桌面专用）', commandTable.modeOf("export_crash_logs") === "deny", commandTable.modeOf("export_crash_logs"));
    ok("deny 原因非空且是面向用户文案", typeof commandTable.denyReason("export_crash_logs") === "string" && commandTable.denyReason("export_crash_logs").length >= 8, String(commandTable.denyReason("export_crash_logs")));
  }

  console.log("");
  console.log("=== 5 浏览器数据版命令（export_crash_logs_data）===");
  {
    const fn = commands.get("export_crash_logs_data");
    ok("export_crash_logs_data 在命令表里", !!fn);
    ok('modeOf === "write"（网页端可用）', commandTable.modeOf("export_crash_logs_data") === "write", commandTable.modeOf("export_crash_logs_data"));
    ok("不在 DENY_BROWSER（网页端可导出）", !commandTable.DENY_BROWSER.export_crash_logs_data && commandTable.denyReason("export_crash_logs_data") === null);
    if (fn) {
      const r = await fn(null, {});
      ok("回传 base64 且文件名以 .zip 结尾", !!(r && r.ok !== false && typeof r.base64 === "string" && r.base64.length > 0 && /\.zip$/.test(r.name || "")), JSON.stringify({ ok: r && r.ok, name: r && r.name, len: r && r.base64 && r.base64.length }));
      const back = zipmod.readZip(Buffer.from((r && r.base64) || "", "base64"));
      const bn = back.map((e) => e.name);
      ok("回传数据能解出 zip（含 crash.log 与 info.txt）", bn.includes("crash.log") && bn.includes("info.txt"), bn.join(","));
    }
  }

  console.log("");
  console.log("=== 6 网页端大小上限（压缩后超过 10MB 时拒绝）===");
  {
    const fn = commands.get("export_crash_logs_data");
    if (!fn) {
      ok("export_crash_logs_data 可执行", false, "命令未注册");
    } else {
      // 随机数据不可压缩，压后仍超限（全 0 / 重复字节会被 deflate 压到极小，测不出上限）
      fs.writeFileSync(file, crypto.randomBytes(11 * 1024 * 1024));
      const r = await fn(null, {});
      ok("超过上限时 ok:false", !!(r && r.ok === false), JSON.stringify({ ok: r && r.ok }));
      ok("提示包含「超过网页端上限」", /超过网页端上限/.test((r && r.message) || ""), String(r && r.message));
      fs.writeFileSync(file, "restore\n"); // 还原，避免残留大文件
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
