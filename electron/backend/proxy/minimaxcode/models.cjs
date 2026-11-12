/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MiniMax Code 模型目录：GET /mavis/api/v1/models（Bearer）+ 落盘 catalog.json
//
// 上游形态（实测）：{ providers: [{ providerId, config: { models: { "<模型名>": {...} } } }] }，
// 每个模型带 limit.context / limit.output / modalities.input / variants / tool_call / reasoning。
// 关键口径：
//   1. 模型名**大小写敏感**（上游对未知模型回 400 unknown model），目录里是逐字真名，不做归一；
//   2. 拉不到或清单为空时**不能覆盖已有清单**，更不能编模型名（失败只报错，保留上一份）；
//   3. 落 catalog.json 的 minimaxcode 段（与 loomy / 其它渠道同口径），这样模型页、别名、
//      智能路由都能看到这批模型；不另建独立文件。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TTL_MS = 6 * 60 * 60 * 1000; // 自动路径缓存 TTL（手动拉取不受限）

let cache = { at: 0, models: [], loaded: false, mtime: -1, size: -1 };

/** 目录文件的签名：进程内缓存之外的写者（index.cjs 的 proxy_models_sync、手工改文件）也要能生效 */
function fileSig(file) {
  try {
    const st = fs.statSync(file);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return { mtime: -1, size: -1 };
  }
}

function pickNum(obj, key) {
  const v = Number(obj && obj[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 单个上游条目 → 仓库归一形态（{id,name,rate,capabilities,contextLength,maxOutputTokens}） */
function mapEntry(id, row) {
  const model = String(id || "").trim();
  if (!model) return null;
  const src = row && typeof row === "object" ? row : {};
  const limit = src.limit && typeof src.limit === "object" ? src.limit : {};
  const modalities = src.modalities && typeof src.modalities === "object" ? src.modalities : {};
  const inputs = Array.isArray(modalities.input) ? modalities.input.map((x) => String(x).toLowerCase()) : [];
  const variants = src.variants && typeof src.variants === "object" ? Object.keys(src.variants) : [];
  return {
    id: model,
    name: String(src.name || "").trim() || model,
    rate: null,
    capabilities: {
      images: inputs.includes("image"),
      // 视频输入网关当前不接（入站协议没有视频块），如实不声明
      reasoning: src.reasoning === true || variants.includes("thinking"),
      tools: src.tool_call === true,
    },
    contextLength: pickNum(limit, "context"),
    maxOutputTokens: pickNum(limit, "output"),
  };
}

function parseModels(payload) {
  const providers = payload && Array.isArray(payload.providers) ? payload.providers : [];
  const out = [];
  const seen = new Set();
  for (const p of providers) {
    const cfg = (p && p.config) || {};
    const models = cfg.models && typeof cfg.models === "object" ? cfg.models : {};
    for (const [id, row] of Object.entries(models)) {
      const entry = mapEntry(id, row);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

function list(rulesDir, channel) {
  const ch = channel || "minimaxcode";
  const file = path.join(rulesDir, "catalog.json");
  const sig = fileSig(file);
  // 缓存按文件签名（mtime + size）失效：`index.cjs` 的 proxy_models_sync 会独立写同一份文件，
  // 只认「本进程写过」会让缓存永远停在旧目录（表现为拉取成功后路由仍说模型不存在）。
  if (cache.loaded && cache.mtime === sig.mtime && cache.size === sig.size) return cache.models.map((m) => m.id);
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = all && all[ch];
    if (entry && Array.isArray(entry.models) && entry.models.length) {
      cache = { at: Number(entry.syncedAt) || 0, models: entry.models, loaded: true, ...sig };
      return cache.models.map((m) => m.id);
    }
  } catch { /* 还没拉过 */ }
  // 文件里没有该渠道段：不能继续返回上一份（可能已被删除/换渠道），如实为空
  cache = { at: 0, models: [], loaded: false, ...sig };
  return [];
}

function entries(rulesDir, channel) {
  list(rulesDir, channel);
  return cache.models;
}

/**
 * 拉一次目录并落盘。force=false 时 TTL 内早退。
 * 失败语义：上游不可用 / 非 2xx / 清单为空 → `{ ok:false }`，**不写文件、不动内存缓存**。
 */
async function refresh({ token, cfg, httpJson }, rulesDir, channel, force) {
  const ch = channel || "minimaxcode";
  const c = cfg || {};
  if (!force && cache.at > 0 && Date.now() - cache.at < TTL_MS) return { ok: true, unchanged: true };
  const agentBase = String(c.agentBase || "https://agent.minimax.cn").replace(/\/+$/, "");
  const url = `${agentBase}${c.modelsPath || "/mavis/api/v1/models?region=cn&buildEnv=prod"}`;
  let r;
  try {
    r = await httpJson(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": c.userAgent || "MiniMaxAgent" } });
  } catch (e) {
    return { ok: false, message: `模型目录拉取失败：${String((e && e.message) || e)}` };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "模型目录拉取被拒（401），请重新登录" };
  if (r.status >= 400) return { ok: false, message: `模型目录拉取失败（HTTP ${r.status}）：${(r.text || "").slice(0, 160)}` };
  const models = parseModels(r.data);
  if (!models.length) return { ok: false, message: "上游模型目录为空或格式不认识（保留现有清单）" };
  cache = { at: Date.now(), models, loaded: true, ...fileSig(path.join(rulesDir, "catalog.json")) };
  try {
    const file = path.join(rulesDir, "catalog.json");
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 新建 */ }
    all[ch] = { syncedAt: cache.at, models };
    fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
    // 写盘后重取签名：否则缓存签名对不上，下一次 list 还要白读一次盘
    cache = { ...cache, ...fileSig(file) };
  } catch { /* 落盘失败不阻断，内存态已生效 */ }
  return { ok: true, count: models.length };
}

/** 按目录逐字校验模型名（大小写敏感、不 trim）：返回命中的原名或 null */
function resolveId(rulesDir, channel, requested) {
  const want = String(requested || "");
  if (!want) return null;
  for (const id of list(rulesDir, channel || "minimaxcode")) if (String(id) === want) return String(id);
  return null;
}

/** 只清内存缓存（自测/换目录时用） */
function resetCache() {
  cache = { at: 0, models: [], loaded: false, mtime: -1, size: -1 };
}

module.exports = { parseModels, list, entries, refresh, resolveId, resetCache, TTL_MS };
