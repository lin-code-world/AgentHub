/**
 * 打包前置：生成「签名器缓存」并放进 build/qoder-signer/，
 * 由 electron-builder 以 extraResources 原样放进安装目录的 resources/qoder-signer/。
 * 运行时程序只从安装目录加载这份缓存，不再现场生成。
 *
 * 生成方式：
 *   ① 本机装了 Qoder 客户端 → 调用 qoderSigner 从客户端运行时里提取 + 打补丁，现场生成一份
 *      （与客户端版本严格对应，最准）；
 *   ② 没装客户端 → 用 AGENTHUB_QODER_SIGNER_SRC 或 %APPDATA%\AgentApiGateway\proxy\qoder-signer 里现成的；
 *   ③ 都没有 → 直接失败（不静默放过）。
 *
 * 说明：补丁模块自包含（只 import Node 内置模块），所以拷到没装客户端的机器也能跑。
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "build", "qoder-signer");
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

// 隔离缓存目录：生成过程不碰用户真实数据目录
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-stage-signer-"));

const signer = require(path.join(ROOT, "electron", "backend", "proxy", "qoderSigner.cjs"));

function copyFrom(dir, note) {
  const names = fs.readdirSync(dir).filter((f) => /^worker-qoder-.*(\.mjs|\.meta\.json)$/.test(f) && !f.includes(".tmp."));
  if (!names.length) throw new Error(`[stage-qoder-signer] ${dir} 里没有 worker-qoder-*.mjs`);
  for (const f of names) fs.copyFileSync(path.join(dir, f), path.join(DEST, f));
  const mjs = names.find((f) => f.endsWith(".mjs"));
  const mb = (fs.statSync(path.join(DEST, mjs)).size / 1048576).toFixed(1);
  console.log(`[stage-qoder-signer] ${note}：${mjs}（${mb} MB）→ build/qoder-signer/`);
}

fs.mkdirSync(DEST, { recursive: true });
for (const f of fs.readdirSync(DEST)) {
  if (/^worker-qoder-.*(\.mjs|\.meta\.json)$/.test(f)) fs.unlinkSync(path.join(DEST, f));
}

// ① 本机客户端 → 现场生成
const loc = signer.locate("qoder");
if (loc) {
  const file = signer.buildPatchedModule("qoder", loc);
  copyFrom(path.dirname(file), `从本机客户端 ${loc.version} 现场生成`);
} else {
  // ② 现成的缓存
  const src = String(process.env.AGENTHUB_QODER_SIGNER_SRC || "").trim() || path.join(APPDATA, "AgentApiGateway", "proxy", "qoder-signer");
  const srcDir = fs.statSync(src).isFile() ? path.dirname(src) : src;
  copyFrom(srcDir, `本机未装客户端，使用现成缓存 ${srcDir}`);
}
