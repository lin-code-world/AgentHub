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
  const list = ((((json.config || {}).modelConfigRules) || {}).modelRules);
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

/** 从多来源解析模型规则：deps = { storedFile, clientDirs, builtinFile }。
 *  本任务只暴露签名占位——IO（读 stored / builtin / client 目录）与联网 fetch 留给后续任务填充。
 *  占位实现恒返回 Promise<null>，不做任何副作用。后续任务替换实现时签名必须保持不变。 */
function resolveModelRules(/* deps */) {
  return Promise.resolve(null);
}

// ===== cachedModelRules =====

// 进程内缓存：resolveModelRules 后续任务成功解析后调 setCached 写入，
// 供同步的 resolveModelMeta() 消费。本模块纯函数层只暴露读写器。
let _cachedRules = [];
function cachedModelRules() { return _cachedRules; }
function setCachedModelRules(rules) {
  _cachedRules = Array.isArray(rules) ? rules : [];
}

module.exports = {
  mapModelRules,
  validateRelease,
  pickLatestRelease,
  buildClientConfigsUrl,
  resolveModelRules,
  cachedModelRules,
  setCachedModelRules,
};
