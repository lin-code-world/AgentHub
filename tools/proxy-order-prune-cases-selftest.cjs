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
// 拉取模型时，三种「已失效」情形是否都会被清掉 —— 逐条实测。
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-order-prune-cases-selftest.cjs
//
// 三种情形：
//   A. 渠道开着，上游把模型下架了            → 拉取该渠道应清掉
//   B. 渠道开着，模型目录里手动关了该模型    → 拉取该渠道应清掉
//   C. 配置里渠道名字写错（拼错的不是真渠道）→ 拉取**任何**渠道都清不掉（它不是任何渠道）
//   D. 渠道被关闭                            → 拉取该渠道清不掉（保护）
"use strict";
process.env.AGENTHUB_DATA_DIR = process.argv[2] || require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "agenthub-sandbox-")); // [沙箱] 不传参数即用临时目录，绝不落真实用户数据
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
const { pruneOrderOfChannel } = require("../electron/backend/proxy/index.cjs");

store.open();
rules.init();

// 目录：qoder 有 keep-model，没有 gone-model
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
for (const ch of ["qoder", "zcode"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent("keep-model")];
}
cat.zcode.models = [...cat.zcode.models, ent("gone-model")]; // zcode 有，qoder 没有
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

function setCfg(p) {
  const cfg = config.loadConfig();
  Object.assign(cfg.proxy, p);
  config.saveConfig(cfg);
}
const readOrder = (m) => config.loadConfig().proxy.modelOverrides[m];

// ===== A. 渠道开着，上游下架 =====
console.log("A. 渠道开着，上游把模型下架");
{
  setCfg({ channelEnabled: {}, disabledModels: [], modelOverrides: { "gone-model": ["qoder", "zcode"] } });
  const n = pruneOrderOfChannel("qoder");
  ok("拉取 qoder 时清掉 qoder（1 条）", n === 1, `实际 ${n}`);
  ok("清理后只剩 zcode（zcode 确实有这个模型）", JSON.stringify(readOrder("gone-model")) === '["zcode"]', JSON.stringify(readOrder("gone-model")));
}

// ===== B. 渠道开着，模型目录里手动关了该模型 =====
// 语义：模型开关是临时决定，重开时排序必须还在 → **不清**。
// 判据只看目录里是否真有这个模型（keep-model 三渠道都有）。
console.log("B. 模型被手动关闭（disabledModels）");
{
  setCfg({ channelEnabled: {}, disabledModels: ["keep-model"], modelOverrides: { "keep-model": ["qoder", "zcode"] } });
  const n = pruneOrderOfChannel("qoder");
  ok("模型被禁用但目录里仍有 → 不清（保住重开后的排序）", n === 0, `实际 ${n}`);
  ok("顺序原样保留", JSON.stringify(readOrder("keep-model")) === '["qoder","zcode"]', JSON.stringify(readOrder("keep-model")));
}

// ===== C. 渠道名字写错（拼错的不是真渠道）=====
console.log("C. 配置里渠道名字写错");
{
  setCfg({ channelEnabled: {}, disabledModels: [], modelOverrides: { "keep-model": ["qoderr", "zcode"] } });
  const nq = pruneOrderOfChannel("qoder");
  const nz = pruneOrderOfChannel("zcode");
  ok("拉取 qoder 清不掉写错的 qoderr", nq === 0, `实际 ${nq}`);
  ok("拉取 zcode 也清不掉写错的 qoderr", nz === 0, `实际 ${nz}`);
  ok("写错的项仍留在配置里", JSON.stringify(readOrder("keep-model")) === '["qoderr","zcode"]', JSON.stringify(readOrder("keep-model")));
}

// ===== D. 渠道被关闭（保护）=====
console.log("D. 渠道被关闭");
{
  setCfg({ channelEnabled: { qoder: false }, disabledModels: [], modelOverrides: { "gone-model": ["qoder", "zcode"] } });
  const n = pruneOrderOfChannel("qoder");
  ok("关闭的渠道拉取时不清（0 条）", n === 0, `实际 ${n}`);
  ok("配置原样保留", JSON.stringify(readOrder("gone-model")) === '["qoder","zcode"]', JSON.stringify(readOrder("gone-model")));
}

console.log(`PRUNE CASES SELFTEST OK（${pass} 项）`);
process.exit(0);
