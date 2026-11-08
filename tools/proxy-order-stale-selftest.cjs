/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-08
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 模型目录「已失效」标注口径自测：只有「渠道仍启用但确实没有该模型」才标注失效；
// 渠道被关闭导致的失败项一律不下发（配置保留，重开恢复）。
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-order-stale-selftest.cjs
"use strict";
if (process.argv[2]) process.env.AGENTHUB_DATA_DIR = process.argv[2];
const path = require("node:path");
const fs = require("node:fs");

let pass = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? " — " + extra : ""}`);
  pass++;
  console.log(`  ok ${name}`);
}

const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const config = require("../electron/backend/config.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const server = require("../electron/backend/proxy/server.cjs");

store.open();
rules.init();

// ===== 目录播种 =====
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
for (const ch of ["qoder", "zcode"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent("shared-model")];
}
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

/** 与 index.cjs 的 proxy_models 里完全同构的口径（那是闭包内联逻辑，抽不出来）：
 *  这里断言的是它依赖的两个原语（modelOwners / channelOn）组合出的结果。 */
function classify(model, orderArr, cfg) {
  const raw = server.normalizeModelOrder(orderArr);
  const validSet = new Set(adapters.modelOwners(model, cfg));
  const stale = [];
  for (const ch of raw) {
    if (validSet.has(ch)) continue;
    if (!adapters.channelOn(ch, cfg.proxy) && adapters.get(ch)) continue;
    stale.push(ch);
  }
  return { override: raw.filter((ch) => validSet.has(ch)), stale };
}

function setCfg({ channelEnabled, modelOverrides, disabledModels }) {
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = channelEnabled || {};
  cfg.proxy.modelOverrides = modelOverrides || {};
  cfg.proxy.disabledModels = disabledModels || [];
  config.saveConfig(cfg);
  return config.loadConfig().proxy;
}

// ===== 1. 两渠道都启用：不应有失效项 =====
console.log("1. 两渠道都启用");
{
  const c = setCfg({ modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  const r = classify("shared-model", ["qoder", "zcode"], c);
  ok("override 保留两项", JSON.stringify(r.override) === '["qoder","zcode"]', JSON.stringify(r.override));
  ok("无失效项", r.stale.length === 0, JSON.stringify(r.stale));
}

// ===== 2. 关闭 qoder 渠道：不标失效、也不出现在 override 里 =====
console.log("2. 关闭 qoder 渠道");
{
  const c = setCfg({ channelEnabled: { qoder: false }, modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  const r = classify("shared-model", ["qoder", "zcode"], c);
  ok("override 只剩 zcode", JSON.stringify(r.override) === '["zcode"]', JSON.stringify(r.override));
  ok("关闭渠道不标「已失效」（界面干净）", r.stale.length === 0, JSON.stringify(r.stale));
}

// ===== 3. 渠道开着但模型已下架：标失效 =====
console.log("3. 渠道开着但模型下架");
{
  const c = setCfg({ channelEnabled: {}, modelOverrides: { "gone-model": ["qoder", "zcode"] } });
  // gone-model 不在任何目录里 → 两个渠道都失效；qoder/zcode 都启用 → 都标注
  const r = classify("gone-model", ["qoder", "zcode"], c);
  ok("两个渠道都标失效", JSON.stringify(r.stale) === '["qoder","zcode"]', JSON.stringify(r.stale));
  ok("override 为空（都不算数）", r.override.length === 0, JSON.stringify(r.override));
}

// ===== 4. 关闭 + 下架混合：只标下架的 =====
console.log("4. 混合场景");
{
  const c = setCfg({ channelEnabled: { qoder: false }, modelOverrides: { "gone-model": ["qoder", "zcode"] } });
  const r = classify("gone-model", ["qoder", "zcode"], c);
  ok("只标 zcode（仍启用但下架）", JSON.stringify(r.stale) === '["zcode"]', JSON.stringify(r.stale));
}

// ===== 5. 未知渠道名（配置写错）：标失效，提示用户 =====
console.log("5. 配置写错渠道名");
{
  const c = setCfg({ modelOverrides: { "shared-model": ["not-a-channel", "zcode"] } });
  const r = classify("shared-model", ["not-a-channel", "zcode"], c);
  ok("写错的渠道名被标失效", JSON.stringify(r.stale) === '["not-a-channel"]', JSON.stringify(r.stale));
  ok("有效项保留", JSON.stringify(r.override) === '["zcode"]', JSON.stringify(r.override));
}

// ===== 6. 重开渠道后，配置里的排序原样恢复 =====
console.log("6. 重开渠道恢复");
{
  setCfg({ channelEnabled: { qoder: false }, modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  // 配置未被修改
  const raw = config.loadConfig().proxy.modelOverrides["shared-model"];
  ok("关闭期间配置原样保留", JSON.stringify(raw) === '["qoder","zcode"]', JSON.stringify(raw));
  // 重开
  const c = setCfg({ channelEnabled: {}, modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  const r = classify("shared-model", raw, c);
  ok("重开后 qoder 回到 override", JSON.stringify(r.override) === '["qoder","zcode"]', JSON.stringify(r.override));
}

console.log(`ORDER STALE SELFTEST OK（${pass} 项）`);
process.exit(0);
