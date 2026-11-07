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
/**
 * ZCode 官方 system 提示词（上游 3012 风控的**内容指纹**）
 *
 * 事实基线：
 *   · 上游对 start-plan 对话的 `system` 做**内容指纹校验**：必须是客户端官方 system 的**前两段**，
 *     且整个 `system` **最多 3 段**。不满足 → HTTP 405 + code 3012「unusual activity」。
 *   · 2026-11-01 基线（本机客户端 3.16.3 逐项实测，抓的是客户端 model-io 请求记录）：
 *     第 0 段 `You are ZCode, an interactive coding agent`（42 字）；第 1 段 = 身份句 + 安全声明 +
 *     `# Harness` + `# ZCode Desktop Context`（约 3101 字）；官方第 3 段（约 7563 字）实测**非必需**；
 *     **第 3 段的位置可以放下游应用自己的 system**，实测放到 3 万字仍通过；
 *     第 1 段里的可视化目录路径**不参与校验**（换成别的用户名仍可通）。
 *   · 2026-11-07 更新（3.17.2 客户端真实请求复核）：上游随 3.17.2 **整体更换了底稿**——
 *     第 0 段变为 `You are ZCode, an interactive agent`（35 字），第 1 段全文重写（3119 字，
 *     仍含 `# Harness` / `# ZCode Desktop Context` / 可视化目录路径），官方第 3 段变为代码风格指令
 *     （3798 字）。3.16.3 旧底稿自 2026-11-02 起稳定被 3012 拦（HTTP 正文
 *     `request has been blocked due to unusual activity.`），同期本地 3.17.2 客户端同账号同模型正常；
 *     「前两段校验 + 最多 3 段 + 第 3 段放任」在 3.17.2 上**未复核**，按同口径打包实测收敛。
 *   · 自称的客户端版本必须是真实存在过的版本（`X-ZCode-App-Version` / UA），见 appVersion 注释。
 *
 * 数据从哪来（优先级从高到低）：
 *   ① `<数据目录>/proxy/zcode-official-system.json` —— **运行时从本机客户端自动采集**的副本；
 *      客户端每跑一轮新会话都会留下 model-io 记录，本模块据此重采，客户端升级后自动跟上。
 *   ② `assets/zcode-official-system.json` —— 随软件打包的一份（目标机器没装客户端时的唯一来源）。
 *   ③ 内置 1253 字常量 —— 只在上面两份都拿不到时兜底，**过不了现在的校验**，会告警。
 *
 * 目标形态：`system = [官方第 0 段, 官方第 1 段, 下游应用自己的 system]`——
 * 既过风控，又不牺牲下游提示词（参考实现把下游 system 塞进 user 消息，会削弱指令效果）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSET = path.join(__dirname, "assets", "zcode-official-system.json");
// 新旧两版底稿的公共前缀：3.16.3 是 "…interactive coding agent"，3.17.2 起是 "…interactive agent"。
// 判据只用于确认「这是官方 system 不是垃圾数据」，取公共前缀让两版记录与资产都能通过结构校验
const OFFICIAL_FIRST_BLOCK = "You are ZCode, an interactive";
const MIN_SEG1_LEN = 3000; // 实测 3101 字；低于这个数说明采到的不是完整第 1 段

/** 兜底常量（客户端 3.14.4 时期采集：CLI Prefix + Agent Identity，1253 字）。
 *  ⚠ 它**过不了**现在的指纹校验（实测两段 3143 字才够），只在上面两份都缺失时保证"发得出去"。 */
const FALLBACK_PREFIX =
  "You are ZCode, an interactive coding agent\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

// ===== 路径（环境变量钩子供自测注入，与 zcodeLocal.v2Dir 同口径） =====

function v2Dir() {
  return process.env.ZCODE_V2_DIR || path.join(os.homedir(), ".zcode", "v2");
}

/** 客户端 model-io 会话记录目录（设备授权登录后每跑一轮就有一条） */
function rolloutDir() {
  return process.env.ZCODE_ROLLOUT_DIR || path.join(os.homedir(), ".zcode", "cli", "rollout");
}

/** 运行时采集副本：落数据目录，不碰打包后的 asar（那里只读） */
function storedFile() {
  return path.join(require("../config.cjs").dataDir(), "proxy", "zcode-official-system.json");
}

// ===== 读：三来源 =====

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 结构校验：至少两段非空字符串，且第 0 段是官方开头、第 1 段够长 */
function looksUsable(blocks) {
  return Array.isArray(blocks) && blocks.length >= 2 && blocks.every((b) => typeof b === "string" && b.length > 0) && blocks[0].startsWith(OFFICIAL_FIRST_BLOCK) && blocks[1].length >= MIN_SEG1_LEN;
}

function readStored() {
  const j = readJsonFile(storedFile());
  if (!j || !looksUsable(j.blocks)) return null;
  return {
    blocks: j.blocks.slice(0, 2),
    clientVersion: String(j.sourceClientVersion || ""),
    sourceMtimeMs: Number(j.sourceMtimeMs) || 0,
  };
}

function readAsset() {
  const j = readJsonFile(ASSET);
  if (!j || !looksUsable(j.blocks)) return null;
  return { blocks: j.blocks.slice(0, 2), clientVersion: String(j.sourceClientVersion || "") };
}

// ===== 从本机客户端采集 =====

/** 客户端 runtime 目录里的版本号（~/.zcode/v2/runtime/provider/<平台>/<版本>/…），取最高版本。
 *  为什么用它：rules.zcode.appVersion 写死会随客户端升级而失效，而这里能读到真实版本。
 *  读不到返回空串，调用方回落配置值。 */
let versionCache = { at: 0, value: "" };
function detectedClientVersion() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < 60_000) return versionCache.value;
  let best = "";
  try {
    const root = path.join(v2Dir(), "runtime", "provider");
    for (const plat of fs.readdirSync(root, { withFileTypes: true })) {
      if (!plat.isDirectory()) continue;
      for (const ver of fs.readdirSync(path.join(root, plat.name), { withFileTypes: true })) {
        if (!ver.isDirectory() || !/^\d+\.\d+\.\d+$/.test(ver.name)) continue;
        const a = best.split(".").map(Number);
        const b = ver.name.split(".").map(Number);
        let newer = false;
        for (let i = 0; i < 3; i++) {
          if ((b[i] || 0) === (a[i] || 0)) continue;
          newer = (b[i] || 0) > (a[i] || 0);
          break;
        }
        if (!best || newer) best = ver.name;
      }
    }
  } catch {
    /* 没装客户端 / 结构变化：回落配置值 */
  }
  versionCache = { at: now, value: best };
  return best;
}

/** 客户端会话记录文件，按 mtime 从新到旧 */
function listRollouts() {
  let ents = [];
  try {
    ents = fs.readdirSync(rolloutDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isFile() && /^model-io-sess(?:ion)?[-_].*\.jsonl$/.test(e.name)) // 3.17.2 起文件名缩写为 model-io-sess_
    .map((e) => {
      const p = path.join(rolloutDir(), e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        /* 读不到时间戳按最旧处理 */
      }
      return { file: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 从一份会话记录里挑最新一条「三段 system」的请求，返回 { at, blocks, clientVersion } */
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
      continue; // 进程被中断留下的半截行
    }
    const req = rec && rec.request;
    const sys = req && req.body && req.body.system;
    if (!Array.isArray(sys) || sys.length !== 3) continue;
    if (!sys.every((b) => b && typeof b.text === "string")) continue;
    if (!sys[0].text.startsWith(OFFICIAL_FIRST_BLOCK)) continue;
    const at = String(rec.startedAt || "");
    if (!best || at > best.at) {
      best = {
        at,
        blocks: [sys[0].text, sys[1].text],
        clientVersion: String((req.headers && req.headers["x-zcode-app-version"]) || ""),
      };
    }
  }
  return best;
}

/** 从本机客户端采集最新的一份；没有客户端记录返回 null */
function captureFromClient() {
  const newest = listRollouts()[0];
  if (!newest) return null;
  const hit = pickFromFile(newest.file);
  if (!hit || !looksUsable(hit.blocks)) return null;
  return { ...hit, sourceFile: newest.file, sourceMtimeMs: newest.mtimeMs };
}

/** 原子落盘（临时文件 + rename，避免半截文件被下次读到） */
function writeStored(data) {
  const file = storedFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      console.warn("[zcode] 官方 system 副本落盘失败（不影响本次使用）：" + ((e && e.message) || e));
    } catch {
      /* 日志失败无碍 */
    }
    return false;
  }
}

// ===== 解析优先级 =====

let cache = null; // { blocks, origin, sourceMtimeMs }

function tryRefresh() {
  // 有客户端且记录比现有副本新 → 重采
  const newest = listRollouts()[0];
  if (newest && (!cache || !cache.sourceMtimeMs || newest.mtimeMs > cache.sourceMtimeMs)) {
    const cap = captureFromClient();
    if (cap) {
      writeStored({
        sourceClientVersion: cap.clientVersion || detectedClientVersion() || "",
        capturedAt: String(cap.at || "").slice(0, 10),
        sourceMtimeMs: cap.sourceMtimeMs,
        sourceFile: path.basename(cap.sourceFile),
        note: "由运行时从本机 ZCode 客户端会话记录自动采集；上游校验 system 前两段指纹，第三段留给下游应用。",
        blocks: cap.blocks,
      });
      cache = { blocks: cap.blocks, origin: "client:" + (cap.clientVersion || "?"), sourceMtimeMs: cap.sourceMtimeMs };
      return true;
    }
  }
  return false;
}

/**
 * 官方前两段 + 来源标记。
 * 顺序：客户端（自动采集并落盘）→ 落盘副本 → 打包 assets → 1253 字兜底。
 */
function officialSystemBlocks() {
  if (tryRefresh()) return { blocks: cache.blocks, origin: cache.origin };

  if (!cache) {
    const stored = readStored();
    if (stored && stored.sourceMtimeMs) {
      cache = { blocks: stored.blocks, origin: "stored:" + (stored.clientVersion || "?"), sourceMtimeMs: stored.sourceMtimeMs };
    }
  }
  if (cache) return { blocks: cache.blocks, origin: cache.origin };

  const stored = readStored();
  if (stored) {
    cache = { blocks: stored.blocks, origin: "stored:" + (stored.clientVersion || "?"), sourceMtimeMs: stored.sourceMtimeMs };
    return { blocks: cache.blocks, origin: cache.origin };
  }

  const asset = readAsset();
  if (asset) {
    cache = { blocks: asset.blocks, origin: "assets:" + (asset.clientVersion || "?"), sourceMtimeMs: 0 };
    return { blocks: cache.blocks, origin: cache.origin };
  }

  cache = { blocks: [FALLBACK_PREFIX], origin: "builtin-fallback", sourceMtimeMs: 0 };
  try {
    console.warn("[zcode] 官方 system 数据全部缺失，回落内置单段常量（很可能仍被 3012 拦截）");
  } catch {
    /* 日志失败无碍 */
  }
  return { blocks: cache.blocks, origin: cache.origin };
}

/** 把下游的 system（字符串 / Anthropic 文本块数组 / undefined）铺平成一段文本。
 *  上游只认 3 段，所以下游的多块 system 必须合并成一块。 */
function flattenSystem(system) {
  if (system === null || system === undefined) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return String(system);
}

/** 构造要发往上游的 `system`：`[官方第0段, 官方第1段, 下游system?]`。 */
function buildOfficialSystem(downstream) {
  const { blocks } = officialSystemBlocks();
  const out = blocks.map((text) => ({ type: "text", text }));
  const extra = flattenSystem(downstream).trim();
  if (extra) out.push({ type: "text", text: extra });
  return out;
}

/** 两段拼接形态：仅用于诊断与自测断言。 */
function resolveOfficialSystemPrefix() {
  return officialSystemBlocks().blocks.join("\n");
}

/** 供诊断：本次用的官方 system 来自哪里（client:<版本> / stored:<版本> / assets:<版本> / builtin-fallback）。 */
function officialSystemPrefixSource() {
  return officialSystemBlocks().origin;
}

module.exports = {
  FALLBACK_PREFIX,
  detectedClientVersion,
  captureFromClient,
  officialSystemBlocks,
  buildOfficialSystem,
  flattenSystem,
  resolveOfficialSystemPrefix,
  officialSystemPrefixSource,
};
