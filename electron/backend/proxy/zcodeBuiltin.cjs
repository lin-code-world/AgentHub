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
// 反代网关 · ZCode 模型能力数据的纯函数层（来源选择 + 校验 + 规则映射）
//
// 为什么要单独抽这一层：最终发布要给一台没装 ZCode 官方客户端的机器用。
// 现有 resolveModelMeta() 的规则读自本机 zcode-builtin.json，无客户端就退化成
// 写死默认值。本模块把"选哪份数据 + 校验结构 + 映射成统一形状"三个纯逻辑
// 独立出来，后续任务再在它里面加文件 IO 与联网更新，供 zcodeLocal.resolveModelMeta()
// 消费——测试也就能在纯函数层完成，不依赖真客户端。
"use strict";

// ===== mapModelRules =====

/** 把上游 modelRules 数组映射成统一 ModelRule[] 形状：
 *  输入（上游 JSON）：[{ modelMatch, config: { properties: { contextWindow?, inputFormat? }, optionSpecs: { maxOutputTokens: { max }? } } }]
 *  输出：[{ re, fmt, contextWindow, maxOutputTokens }] —— 只保留有 re 的规则，过滤无效条目。
 *  这份函数是 zcodeBuiltin（校验）与 zcodeLocal（读客户端文件）两处对同一份上游数据的唯一映射口径。
 *  语义逐字等价于 zcodeLocal 既有实现，不改 "contextWindow 为 0 被 Number()||undefined 吞掉" 的既有行为。 */
function mapModelRules(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const cfg = (r || {}).config || {};
      const props = cfg.properties || {};
      const opts = cfg.optionSpecs || {};
      const maxOut = (opts.maxOutputTokens || {}).max;
      return {
        re: (r && r.modelMatch) || "",
        fmt: props.inputFormat || null,
        contextWindow: Number(props.contextWindow) || undefined,
        maxOutputTokens: Number(maxOut) || undefined,
      };
    })
    .filter((r) => r.re);
}

// ===== validateRelease =====

/** 校验 release JSON 并映射为统一 ModelRule[] 形状。
 *  规则映射口径通过 mapModelRules() 复用——与 zcodeLocal.readClientModelRules() 唯一映射源。 */
function validateRelease(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "release 不是对象" };
  }
  if (json.schemaVersion !== 1) {
    return { ok: false, reason: `schemaVersion 非 1（实际 ${json.schemaVersion}）` };
  }
  if (!Number.isInteger(json.revision) || json.revision <= 0) {
    return { ok: false, reason: `revision 非正整数（实际 ${json.revision}）` };
  }
  const list = ((json.config || {}).modelConfigRules || {}).modelRules;
  if (!Array.isArray(list)) {
    return { ok: false, reason: "modelRules 非数组" };
  }
  return {
    ok: true,
    release: { revision: json.revision, schemaVersion: 1, modelRules: mapModelRules(list) },
  };
}

// ===== pickLatestRelease =====

/** 按 revision 降序取最大；同 revision 按 stored(0) < client(1) < builtin(2) 升序取胜出者。
 *  空数组返回 null。origin 非三值之一按 builtin 兜底（来源未知时宁取权威最低者）。 */
const ORIGIN_RANK = { stored: 0, client: 1, builtin: 2 };
function pickLatestRelease(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  let best = null;
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const rev = Number(s.revision) || 0;
    const rank = ORIGIN_RANK[s.origin] !== undefined ? ORIGIN_RANK[s.origin] : 2;
    if (!best || rev > best.rev || (rev === best.rev && rank < best.rank)) {
      best = { rev, rank, origin: s.origin, revision: rev, raw: s.raw };
    }
  }
  if (!best) return null;
  return { origin: best.origin, revision: best.revision, raw: best.raw };
}

// ===== buildClientConfigsUrl =====

/** 拼 client configs 请求 URL：末尾 query 带上 app_version 与 platform。 */
function buildClientConfigsUrl(baseUrl, appVersion, platform) {
  const sep = String(baseUrl || "").includes("?") ? "&" : "?";
  return `${baseUrl}${sep}app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`;
}

// ===== resolveModelRules =====

/** 从多来源同步解析模型规则：deps = { storedFile, clientDirs: string[], builtinFile }。
 *  同步设计理由：zcodeLocal.resolveModelMeta() 是同步调用链（每次模型目录解析都会调），
 *  若此处返回 Promise，首次同步调用只能拿到空缓存，模型能力退化成默认值正是本任务要修的病。
 *  读三个来源本来就是 fs.readFileSync，异步只对远端请求有必要（Task 4 才引入联网 fetch）。
 *
 *  返回 { rules: ModelRule[], origin, revision } | null。全部来源不可用返回 null。
 *  任何一份读不出来或 JSON 损坏，只跳过该来源，不抛错。
 *
 *  缓存：key 由三个来源文件的存在性 + mtime 组成；任一变化即失效，下一次调用重新读。
 *  显式失效入口只有一个，见 invalidateModelRules()。 */
function resolveModelRules(deps) {
  const fs = require("node:fs");
  const path = require("node:path");
  const d = deps || {};
  const storedFile = d.storedFile || "";
  const builtinFile = d.builtinFile || "";
  const clientDirs = Array.isArray(d.clientDirs) ? d.clientDirs.filter(Boolean) : [];

  // 收集客户端目录下所有 zcode-builtin.json（深度 4，复用 zcodeLocal.findClientBuiltin 的搜索规则）
  const clientFiles = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "zcode-builtin.json") {
        try {
          clientFiles.push(p);
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  for (const root of clientDirs) {
    if (!root) continue;
    walk(root, 0);
  }

  // 读一个来源：返回 { origin, revision, raw: ModelRule[] } 或 null（不可用）
  const readOne = (origin, file) => {
    if (!file) return null;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const v = validateRelease(json);
    if (!v.ok) return null;
    return { origin, revision: v.release.revision, raw: v.release.modelRules, _mtime: stat.mtimeMs };
  };

  // 构建缓存 key（任一来源存在性或 mtime 变化即失效）
  const cacheKeyParts = [];
  const pushStat = (label, file) => {
    if (!file) {
      cacheKeyParts.push(`${label}:missing`);
      return;
    }
    try {
      const s = fs.statSync(file);
      cacheKeyParts.push(`${label}:1:${s.mtimeMs}`);
    } catch {
      cacheKeyParts.push(`${label}:0`);
    }
  };
  pushStat("stored", storedFile);
  // clientDirs 可能多个，把每个目录的 stat 都计入
  clientDirs.forEach((root, i) => pushStat(`clientDir[${i}]`, root));
  // 客户端找到的文件（按路径排序稳定化）也计入 key——因为 findClientBuiltin 是按目录递归，文件可能随客户端更新
  clientFiles.sort().forEach((p, i) => pushStat(`clientFile[${i}]`, p));
  pushStat("builtin", builtinFile);
  const cacheKey = cacheKeyParts.join("|");

  if (_resolveCache.key === cacheKey && _resolveCache.value) {
    return _resolveCache.value;
  }

  // 读各来源
  const sources = [];
  const stored = readOne("stored", storedFile);
  if (stored) sources.push(stored);

  // 客户端可能有多份（runtime/provider 下不同版本目录），按 mtime 最新者作为 client 来源
  let latestClient = null;
  for (const p of clientFiles) {
    const r = readOne("client", p);
    if (r && (!latestClient || r._mtime > latestClient._mtime)) latestClient = r;
  }
  if (latestClient) sources.push(latestClient);

  const builtin = readOne("builtin", builtinFile);
  if (builtin) sources.push(builtin);

  const picked = pickLatestRelease(sources);
  const result = picked ? { origin: picked.origin, revision: picked.revision, rules: picked.raw } : null;

  _resolveCache.key = cacheKey;
  _resolveCache.value = result;
  return result;
}

// resolveModelRules 的按来源 mtime 缓存。value 同时承载"哪个来源胜出"与"规则内容"，
// 命中缓存提前 return 时读的也是同一对象——两层状态合一，不会出现"命中缓存却读到空规则"的分裂。
const _resolveCache = { key: "", value: null };

/** 唯一显式失效入口：清空缓存（含规则内容），下次 resolveModelRules 重新读三个来源。
 *  Task 4 更新落盘副本成功后调用它即可让新规则生效。 */
function invalidateModelRules() {
  _resolveCache.key = "";
  _resolveCache.value = null;
}

// ===== cachedModelRules =====

// 供同步的 resolveModelMeta() 消费：直接暴露缓存里胜出来源的规则；
// 缓存为空（从未解析过或已失效）返回空数组，调用方退回保守默认值。
function cachedModelRules() {
  return _resolveCache.value && Array.isArray(_resolveCache.value.rules) ? _resolveCache.value.rules : [];
}

module.exports = {
  mapModelRules,
  validateRelease,
  pickLatestRelease,
  buildClientConfigsUrl,
  resolveModelRules,
  cachedModelRules,
  invalidateModelRules,
};
