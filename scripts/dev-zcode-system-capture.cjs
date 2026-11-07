/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-01
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 一次性采集 ZCode 官方 system 提示词（前两段）并落盘到仓库 assets 目录。
//
// 为什么要有它：上游对 start-plan 对话的 `system` 做**内容指纹校验**，不满足一律回
// HTTP 405 + code 3012「unusual activity」。而这段提示词随客户端版本变化——客户端升级后
// 若再次出现 3012，重跑本脚本即可，不用改代码。
//
// 2026-11-07 实测：3.17.2 上游整体更换了底稿（首句从 `You are ZCode, an interactive coding agent`
// 改为 `You are ZCode, an interactive agent`，第 1 段全文重写）——3.16.3 旧底稿自 2026-11-02 起
// 稳定被 3012 拦截，同期本地 3.17.2 客户端正常。首句判据因此放宽到两版公共前缀。
//
// 数据来源：客户端自己的 model-io 会话记录
//   ~/.zcode/cli/rollout/model-io-session-*.jsonl
// 每行是一条真实模型请求。取最近一条「request.body.system 为三段文本」的记录：
// 前两段正是上游要校验的内容（第 3 段是官方代码风格指令，3.16.3 时代实测非必需，未采集）。
//
// 用法：
//   node scripts/dev-zcode-system-capture.cjs
//   ZCODE_PROFILE_USER=Administrator node scripts/dev-zcode-system-capture.cjs   # 指定落盘时的用户名
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROLLOUT_DIR = path.join(os.homedir(), ".zcode", "cli", "rollout");
const OUT = path.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-official-system.json");
// 落盘时的用户名：目标机器是 Administrator。提示词里的可视化目录路径不参与上游校验
// （实测换成别的用户名仍可通），这里统一写成目标机器，避免把采集者的用户名带进仓库。
const TARGET_USER = String(process.env.ZCODE_PROFILE_USER || "Administrator").trim() || "Administrator";
// 新旧两版底稿的公共前缀（3.16.3 是 …interactive coding agent，3.17.2 起是 …interactive agent）：
// 判据只用于确认「这是官方 system 不是垃圾数据」，放宽到公共前缀后两版记录都能采到
const OFFICIAL_FIRST_BLOCK = "You are ZCode, an interactive";

function listRollouts() {
  let ents = [];
  try {
    ents = fs.readdirSync(ROLLOUT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isFile() && /^model-io-sess(?:ion)?[-_].*\.jsonl$/.test(e.name)) // 3.17.2 起文件名缩写为 model-io-sess_
    .map((e) => {
      const p = path.join(ROLLOUT_DIR, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        /* 读不到时间戳就按最旧处理 */
      }
      return { file: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 扫一份会话记录，返回其中最新的「三段 system」请求；没有则 null */
function pickFromFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let best = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 半截行（进程被中断）跳过
    }
    const body = rec && rec.request && rec.request.body;
    const system = body && body.system;
    if (!Array.isArray(system) || system.length !== 3) continue;
    if (!system.every((b) => b && typeof b.text === "string")) continue;
    if (!system[0].text.startsWith(OFFICIAL_FIRST_BLOCK)) continue;
    const at = String(rec.startedAt || "");
    if (!best || at > best.at) best = { at, system, headers: rec.request.headers || {} };
  }
  return best;
}

function main() {
  const files = listRollouts();
  if (!files.length) {
    console.error(`没找到客户端会话记录：${ROLLOUT_DIR}`);
    console.error("请在 ZCode 客户端里随便发一条消息（任意模型），再重跑本脚本。");
    process.exit(1);
  }

  let picked = null;
  let pickedFile = "";
  for (const f of files) {
    const hit = pickFromFile(f.file);
    if (!hit) continue;
    if (!picked || String(hit.at) > String(picked.at)) {
      picked = hit;
      pickedFile = f.file;
    }
  }
  if (!picked) {
    console.error(`扫了 ${files.length} 份会话记录，没有一条含三段 system 的模型请求。`);
    console.error("请在 ZCode 客户端里发一条消息（不要用纯本地模型），再重跑本脚本。");
    process.exit(1);
  }

  const [seg0, seg1] = picked.system.map((b) => b.text);
  if (seg1.length < 3000) {
    console.error(`第 1 段只有 ${seg1.length} 字，明显不完整（实测需要 ~3101 字），拒绝落盘。`);
    process.exit(1);
  }

  // 文本里的路径是字面双反斜杠（C:\\Users\\<name>\\），整段换成目标机器的用户名
  const userRe = /C:\\\\Users\\\\[^\\]+/g;
  const replaced = seg1.match(userRe) || [];
  const seg1Out = seg1.replace(userRe, `C:\\\\Users\\\\${TARGET_USER}`);

  const data = {
    sourceClientVersion: String(picked.headers["x-zcode-app-version"] || ""),
    capturedAt: String(picked.at || "").slice(0, 10),
    note: "ZCode 桌面客户端真实模型请求的 system 前两段原文。" + "上游对该 system 做内容指纹校验：前两段必须逐字一致、且最多 3 段，否则回 405/3012。" + "第三段留给下游应用自己的 system（3.16.3 时代实测任意长度均可；3.17.2 是否仍如此未复核，按同口径打包实测）。" + "官方自己的第 3 段（代码风格指令）未采集。第 1 段里的可视化目录路径不参与校验（换成目标机器用户名仍可通）。",
    blocks: [seg0, seg1Out],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data), "utf8");

  console.log("来源记录：", pickedFile);
  console.log("请求时间：", picked.at, "| 客户端版本：", data.sourceClientVersion || "(记录里没有)");
  console.log("用户名替换：", replaced.length, "处 →", TARGET_USER, replaced.length ? `（原值 ${replaced[0]}…）` : "");
  console.log("已写入：", OUT);
  console.log("第 0 段", seg0.length, "字 | 第 1 段", seg1Out.length, "字 | 合计", seg0.length + seg1Out.length);
  console.log("\n下一步：跑 `node tools/proxy-zcode-selftest.cjs`（需 Electron 的 Node）确认 T19 通过，再提交。");
}

main();
