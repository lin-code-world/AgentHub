/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
// 崩溃/异常取证日志（main 与 backend 共用）：追加写 userData/logs/crash.log。
// 行格式与 main.cjs 取证块（PR #40）一致：[ISO] [pid=N] kind detail。
// main 侧为什么需要它之外还有本模块：app.on("child-process-gone") 只覆盖 Chromium 子进程，
// ELECTRON_RUN_AS_NODE 子进程（会话流水 worker 等）死亡不触发任何事件——
// 实测 worker 连崩 25 次（crashpad 25 个同签名 dump）而主进程日志零痕迹。
//
// 保留策略：分段轮转。当前段固定叫 crash.log，写满一段（默认 10MB）就改名成 crash.log.1
// （原来的 .1 依次后移成 .2 …），只保留最多 10 段（约 100MB），更旧的一段直接删。
// 写入永远是「末尾追加一行」、轮转只是「改名 + 删最旧」，任何时刻都不需要读或重写大文件；
// 崩溃当下已经落盘的行都在已完成的分段里，不会因为「正在挪内容」而丢。
// 唯一的一次性例外是迁移：旧版本遗留的 crash.log 可能大于一段（历史上限 1MB / 100MB），
// 轮转时把它裁到段上限并保留最新尾部，避免一份超大历史段长期占空间。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zip = require("./zip.cjs"); // 纯 Node 零依赖 zip（导出崩溃日志包用，与「本机存储」备份共用同一份）
// 段大小：默认 10MB；AGENTHUB_CRASHLOG_SEGMENT_BYTES 仅自测用（造小段加速轮转验证），生产不设
const SEGMENT_BYTES = Math.max(1024, Number(process.env.AGENTHUB_CRASHLOG_SEGMENT_BYTES) || 10 * 1024 * 1024);
// 最多段数（当前 crash.log + crash.log.1 ~ .9），合计约 100MB
const SEGMENTS = 10;

function logDir() {
  // 测试 / 纯 Node 场景可显式指定目录；否则优先 Electron app（主进程），回落 %APPDATA%\AgentHub
  if (process.env.AGENTHUB_CRASHLOG_DIR) return process.env.AGENTHUB_CRASHLOG_DIR;
  let dir = "";
  try {
    const electron = require("electron");
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === "function") dir = app.getPath("userData");
  } catch { /* ELECTRON_RUN_AS_NODE / 纯 Node 下无 electron 模块 */ }
  if (!dir) dir = path.join(process.env.APPDATA || os.homedir(), "AgentHub");
  return path.join(dir, "logs");
}

/** 把超出一段的文件裁到段上限，只保留尾部（迁移旧版本遗留的超大 crash.log 专用；
 *  正常轮转路径永远走不到——当前段在每次写入前就检查过大小） */
function trimToSegment(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return; // 不存在（轮转后才首次写入）：无需裁剪
  }
  if (st.size <= SEGMENT_BYTES) return;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(SEGMENT_BYTES);
    const read = fs.readSync(fd, buf, 0, SEGMENT_BYTES, st.size - SEGMENT_BYTES);
    const tail = buf.subarray(0, read);
    const nl = tail.indexOf(10); // 丢弃被截断的残行，从下一个完整行开始
    fs.writeFileSync(file, nl >= 0 ? tail.subarray(nl + 1) : tail);
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

/** 当前段写满就轮转：删最旧段 → 依次后移 → 当前段变成 .1（超大旧文件先裁到一段） */
function rotateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // 文件还不存在：不用轮转
  }
  if (size < SEGMENT_BYTES) return;
  fs.rmSync(`${file}.${SEGMENTS - 1}`, { force: true }); // 最旧一段（crash.log.9，缺省不存在）
  for (let i = SEGMENTS - 2; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  trimToSegment(file); // 迁移：旧版本遗留的大文件先裁到一段，再进历史
  fs.renameSync(file, `${file}.1`);
}

function write(kind, detail) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "crash.log");
    rotateIfNeeded(file);
    // 非字符串明细（对象/错误等）序列化后再落盘：String({}) 只会得到 "[object Object]"，
    // 把调用方想要的上下文丢光；序列化失败退回 String（脏输入绝不抛）
    let raw = "";
    if (detail != null) {
      if (typeof detail === "string") raw = detail;
      else { try { raw = JSON.stringify(detail); } catch { raw = String(detail); } }
    }
    const text = raw.replace(/\s+/g, " ").trim().slice(0, 3000);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [pid=${process.pid}] ${kind}${text ? " " + text : ""}\n`);
  } catch { /* 取证日志自身绝不反噬主流程 */ }
}

/** 日志目录下的分段文件（最新在前：crash.log → .1 → .2 …）；目录不存在 / 无日志时返回 [] */
function listSegments(dir = logDir()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const idxOf = (n) => (n === "crash.log" ? 0 : Number(n.slice("crash.log.".length)));
  return names
    .filter((n) => /^crash\.log(\.\d+)?$/.test(n))
    .map((n) => {
      let size = 0;
      try { size = fs.statSync(path.join(dir, n)).size; } catch { /* 读不到按 0 计 */ }
      return { name: n, path: path.join(dir, n), size };
    })
    .sort((a, b) => idxOf(a.name) - idxOf(b.name));
}

/** 应用版本：桌面取 Electron app.getVersion，纯 Node 回落仓库 package.json */
function appVersion() {
  try {
    const app = require("electron").app;
    if (app && typeof app.getVersion === "function") return app.getVersion();
  } catch { /* 纯 Node 无 electron */ }
  try {
    return require("../../package.json").version || "-";
  } catch {
    return "-";
  }
}

/** 环境信息小文本（随导出包附带，便于排查）：不含令牌等敏感内容 */
function infoText(segs, dir) {
  const now = new Date();
  const osVer = typeof os.version === "function" ? `（${os.version()}）` : "";
  return [
    "AgentApiGateway 崩溃日志导出",
    `导出时间：${now.toLocaleString()}（本地） / ${now.toISOString()}（UTC）`,
    `应用版本：${appVersion()}`,
    `Electron：${process.versions.electron || "-"} / Node：${process.versions.node || "-"} / Chromium：${process.versions.chrome || "-"}`,
    `操作系统：${os.type()} ${os.release()} ${os.arch()}${osVer}`,
    `数据目录：${path.dirname(dir)}`,
    "日志分段（最新在前）：",
    ...segs.map((s) => `  ${s.name}  ${s.size} 字节`),
    "",
    "说明：日志时间为 UTC，北京时间 = UTC + 8 小时；crash.log 为当前段，.1/.2… 为更早的历史段。",
  ].join("\r\n");
}

/** 打包成 zip：全部 crash.log 分段 + 一份 info.txt。无日志时返回 { ok:false, message } */
function buildArchive(dir = logDir()) {
  const segs = listSegments(dir);
  if (!segs.length) return { ok: false, message: "暂无崩溃日志" };
  const entries = segs.map((s) => ({ name: s.name, data: fs.readFileSync(s.path) }));
  entries.push({ name: "info.txt", data: Buffer.from(infoText(segs, dir) + "\r\n", "utf8") });
  return { ok: true, buffer: zip.createZip(entries), count: segs.length };
}

module.exports = { write, logDir, buildArchive };
