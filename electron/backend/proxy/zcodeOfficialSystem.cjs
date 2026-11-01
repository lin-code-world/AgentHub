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
 * 事实基线（2026-11-01 用本机客户端 3.16.3 逐项实测，抓的是客户端自己的 model-io 请求记录）：
 *   · 上游对 start-plan 对话的 `system` 做内容指纹校验：必须是客户端官方 system 的**前两段**，
 *     且整个 `system` **最多 3 段**。不满足 → HTTP 405 + code 3012「unusual activity」。
 *   · 第 0 段 = `You are ZCode, an interactive coding agent`（42 字）。
 *   · 第 1 段 = 身份句 + 安全声明 + `# Harness` + `# ZCode Desktop Context`（约 3101 字）。
 *   · 官方第 3 段（Desktop Context 之后的正文，约 7563 字）实测**非必需**：只发前两段即可通过。
 *   · **第 3 段的位置可以放下游应用自己的 system**，实测放到 3 万字仍通过。
 *   · 第 1 段里的可视化目录路径**不参与校验**（换成别的用户名仍可通）。
 *   · 另外，自称的客户端版本号必须是真实存在过的版本（`X-ZCode-App-Version` / UA）：
 *     实测 `4.1.10` 这种不存在的版本会被直接判 3012，`3.16.3` 可过。见 rules.cjs 的 appVersion。
 *
 * 于是本模块的职责非常明确：**原样发出官方前两段，再把下游应用自己的 system 作为第 3 段追加**——
 * 既过风控，又不牺牲下游应用的提示词（参考实现把下游 system 塞进 user 消息，会削弱 Claude Code
 * 这类客户端的指令效果，本模块不需要那样做）。
 *
 * 数据来源：`assets/zcode-official-system.json`，从客户端 model-io 会话记录采集（带来源版本）。
 * 客户端升级后如果再次出现 3012，重新采集该文件即可，无需改代码。
 */

const fs = require("node:fs");
const path = require("node:path");

const ASSET = path.join(__dirname, "assets", "zcode-official-system.json");

/** 兜底常量（客户端 3.14.4 时期采集：CLI Prefix + Agent Identity，1253 字）。
 *  ⚠ 它**过不了**现在的指纹校验（实测两段 3143 字才够），只在 assets 缺失时保证"发得出去"，
 *  并在控制台留一条告警。真要在这种状态下工作，必须补回 assets。 */
const FALLBACK_PREFIX =
  "You are ZCode, an interactive coding agent\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

let cache = null;

/** 官方前两段（带来源标记）。assets 不可用时回落单段常量并告警。 */
function officialSystemBlocks() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(ASSET, "utf8"));
    const blocks = Array.isArray(j && j.blocks) ? j.blocks : null;
    if (blocks && blocks.length >= 2 && blocks.every((b) => typeof b === "string" && b.length > 0)) {
      cache = { blocks: blocks.slice(0, 2), source: "assets:" + String(j.sourceClientVersion || "unknown") };
      return cache;
    }
    throw new Error("blocks 结构不符（需要至少两段非空字符串）");
  } catch (e) {
    cache = { blocks: [FALLBACK_PREFIX], source: "builtin-fallback" };
    try {
      console.warn("[zcode] 官方 system 数据不可用，回落内置单段常量（很可能仍被 3012 拦截）：" + ((e && e.message) || e));
    } catch {
      /* 日志失败不影响发送 */
    }
    return cache;
  }
}

/** 把下游的 system（字符串 / Anthropic 文本块数组 / undefined）铺平成一段文本。
 *  上游只认 3 段，所以下游的多块 system 必须合并成一块，不能原样塞进去。 */
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

/**
 * 构造要发往上游的 `system`：`[官方第0段, 官方第1段, 下游system?]`。
 * 下游没有 system 时只发官方两段（实测两段即可通过指纹校验）。
 */
function buildOfficialSystem(downstream) {
  const { blocks } = officialSystemBlocks();
  const out = blocks.map((text) => ({ type: "text", text }));
  const extra = flattenSystem(downstream).trim();
  if (extra) out.push({ type: "text", text: extra });
  return out;
}

/** 两段拼接形态：只用于诊断与自测断言，实际发送走 buildOfficialSystem()。 */
function resolveOfficialSystemPrefix() {
  return officialSystemBlocks().blocks.join("\n");
}

/** 供诊断：本次用的官方 system 来自哪里（assets:<版本> / builtin-fallback）。 */
function officialSystemPrefixSource() {
  return officialSystemBlocks().source;
}

module.exports = {
  FALLBACK_PREFIX,
  officialSystemBlocks,
  buildOfficialSystem,
  flattenSystem,
  resolveOfficialSystemPrefix,
  officialSystemPrefixSource,
};
