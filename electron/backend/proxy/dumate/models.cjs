/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-14
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · DuMate 模型目录：GET {云端网关}/gateway/apis/v1/models（OpenAI 形态）+ 持久化缓存
//
// 客户端 UI 没有模型选择器（「搭子」自动路由产品形态），这个目录是客户端主进程每 10 分钟
// 轮询的内部接口（2026-11-14 实测抓到 Main.log 的轮询记录，200，43 个条目）。
// 目录里大半是客户端内部功能专用模型（路由决策/追问推荐/会议纪要/OCR/测试假模型等），
// 对外反代没有意义，见 shouldExpose 的过滤规则。
//
// 参考项目 dumate2api 硬编码的 MODEL_MAP（deepseek-v4.1 → deepseek-v4-pro 等别名）与真实
// 目录出入不小，这里不做别名映射：模型 id 用云端原样，写错直接 400，不静默改写。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// TTL 内早退（与客户端轮询周期同档 10 分钟）；force=true 强拉
const TTL_MS = 10 * 60 * 1000;

// 进程内缓存 + 落盘（catalog.json 的 dumate 段，mtime 失效）——与 Loomy 同构
let cache = { at: 0, models: [], loaded: false };

// ===== 内部模型过滤 =====
// 云端目录（2026-11-14 实测 43 条）里对外反代**没有意义**的条目：
//   · llm-mock                    测试假模型
//   · model-routing / routing2 / coding-routing  自动路由决策（客户端内部每轮调用）
//   · model-followup / wiki / meeting-notes / gui-use / reason-summary /
//     ppt-validate / artifact-validate / aiassist / tm-*  客户端功能专用（追问、纪要、GUI 操作等）
//   · qwen3-embedding-4b / qwen3-reranker-4b      embedding / 重排，不是 chat
//   · dumate-image0.1                             图像生成（chat 接口是否受理未验证，保守不暴露）
//   · qianfan-ocr / model-mm-fallback             2026-11-14 全量实测后补录：OCR 识别专用与
//                                                   mm 内部兜底，能对话但没有对外暴露的意义
// 其余全保留：主力对话模型 + dm-auto-model/*（客户端自动路由档位，直接请求等效自动选模型）
// + model-text（客户端实测在用的主力条目）。
const DROP_EXACT = new Set(["llm-mock", "model-routing", "model-routing2", "model-coding-routing", "model-followup", "model-wiki", "model-meeting-notes", "model-gui-use", "model-reason-summary", "model-ppt-validate", "model-artifact-validate", "model-aiassist", "model-tm-deepseek", "model-tm-qwen-small", "qwen3-embedding-4b", "qwen3-reranker-4b", "dumate-image0.1", "qianfan-ocr", "model-mm-fallback"]);

function shouldExpose(id) {
  const s = String(id || "").trim();
  if (!s) return false;
  return !DROP_EXACT.has(s);
}

// 把一个 OpenAI 目录条目映射成归一形态（与 Loomy mapEntry 同构；云端条目只带 id/limit，
// 能力位按模型族保守推断：上下文 1M 档与 kimi/glm/deepseek/qwen 主力给 reasoning，
// mm 系与 ernie-vl/qwen2.5-vl 给图片输入——2026-11-14 图文实测只在 deepseek-v4-pro 验证过）
function mapEntry(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "").trim();
  if (!id) return null;
  const lim = row.limit && typeof row.limit === "object" ? row.limit : {};
  const pickNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const lower = id.toLowerCase();
  const capabilities = {
    reasoning: /kimi|glm|deepseek|qwen3\.\d/.test(lower) || lower.startsWith("dm-auto-model") || lower === "model-text",
    images: /mm|vl/.test(lower) || lower.includes("ernie-4.5-turbo-vl") || lower.startsWith("qwen2.5-vl"),
    tools: true,
  };
  return {
    id,
    name: id,
    rate: null, // 搭子是订阅形态，无按模型倍率口径
    capabilities,
    contextLength: pickNum(lim.input),
    maxOutputTokens: pickNum(lim.output),
  };
}

function parseModels(payload) {
  const rows = (payload && Array.isArray(payload.data) && payload.data) || (Array.isArray(payload) ? payload : []);
  return rows.map(mapEntry).filter(Boolean);
}

// 当前模型清单（内存 → catalog.json 落盘回读；目录为空 = 从未拉取过）
function list(rulesDir, channel) {
  if (cache.loaded) return cache.models.map((m) => m.id);
  const file = path.join(rulesDir, "catalog.json");
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = all && all[channel];
    if (entry && Array.isArray(entry.models) && entry.models.length) {
      cache = { at: Number(entry.syncedAt) || 0, models: entry.models, loaded: true };
      return cache.models.map((m) => m.id);
    }
  } catch {
    /* 无缓存 */
  }
  return [];
}

// 条目数组（含元数据），供模型管理与展示
function entries(rulesDir, channel) {
  list(rulesDir, channel);
  return cache.models;
}

/**
 * 拉一次模型目录并落地（catalog.json 的 dumate 段）。
 * headers = 组好的鉴权请求头（adapter 侧先换好通行证再调，见 adapter.fetchModels）；
 * cfg = 渠道 headers.json 段（modelsUrl 从这取）。
 * force=false 时 TTL 内早退（unchanged）。
 * 返回 { ok, added?, count?, unchanged?, message? }
 */
async function refresh(headers, cfg, rulesDir, channel, force, httpJson) {
  if (!force && cache.at > 0 && Date.now() - cache.at < TTL_MS) return { ok: true, unchanged: true };
  const url = String((cfg && cfg.modelsUrl) || "https://dumate-svc.baidu.com/gateway/apis/v1/models");
  let payload;
  try {
    const r = await httpJson(url, { method: "GET", headers });
    if (r.status !== 200) {
      return { ok: false, message: `DuMate 模型目录拉取失败（HTTP ${r.status}）` };
    }
    payload = r.data;
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  const models = parseModels(payload).filter((m) => shouldExpose(m.id));
  if (!models.length) {
    return { ok: false, message: "DuMate 模型目录为空或过滤后没有可用条目（保留现有清单）" };
  }
  const count = models.length;
  cache = { at: Date.now(), models, loaded: true };
  // 落盘 catalog.json（整段覆盖对应渠道，与别家同口径）
  try {
    const file = path.join(rulesDir, "catalog.json");
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* 新建 */
    }
    all[channel] = { syncedAt: cache.at, models };
    fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
  } catch {
    /* 落盘失败不阻断，内存态已生效 */
  }
  return { ok: true, added: count, count };
}

/**
 * 按目录逐字校验请求的模型名（与 Loomy resolveFrom 同口径：大小写敏感、不 trim）。
 * 返回 null 表示目录里没有（或目录为空，无从判断），由调用方决定如何处置。
 */
function resolveFrom(ids, requested) {
  const want = String(requested || "");
  if (!want) return null;
  for (const id of ids || []) if (String(id) === want) return String(id);
  return null;
}

/** 按渠道目录逐字校验（运行时用：读内存缓存 / catalog.json） */
function resolveId(rulesDir, channel, requested) {
  return resolveFrom(list(rulesDir, channel), requested);
}

module.exports = { list, entries, refresh, resolveFrom, resolveId, parseModels, mapEntry, shouldExpose, DROP_EXACT, TTL_MS };
