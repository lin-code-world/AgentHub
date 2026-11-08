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
// 拉取模型时清理渠道排序失效项的自测（pruneOrderOfChannel）
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-order-prune-selftest.cjs
//
// 断言面：① 该渠道已不拥有的模型 → 摘掉该渠道
//         ② 该渠道仍拥有的模型 → 原样保留
//         ③ 清空后删键（配置不留空数组）
//         ④ 其它渠道的项一律不动（避免误删临时关闭渠道的排序）
//         ⑤ 顺序内相对位次在摘除后保持不变
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
const server = require("../electron/backend/proxy/server.cjs");

store.open();
rules.init();

// ===== 目录播种 =====
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
// qoder 有 keep-model；qoder 没有 drop-model（模拟已下架）
for (const ch of ["qoder", "zcode", "loomy"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent("keep-model")];
}
// drop-model：zcode + loomy 有，qoder 没有
for (const ch of ["zcode", "loomy"]) cat[ch].models = [...cat[ch].models, ent("drop-model")];
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

// ===== 写初始配置 =====
function writeCfg(modelOverrides) {
  const cfg = config.loadConfig();
  cfg.proxy.modelOverrides = modelOverrides;
  config.saveConfig(cfg);
}
const initial = {
  // qoder 在此模型里已失效 → 应被摘掉，剩下顺序不变
  "drop-model": ["qoder", "loomy", "zcode"],
  // qoder 仍拥有 → 原样保留
  "keep-model": ["qoder", "zcode"],
  // 只有 qoder → 摘完清空，应删掉该键
  "only-qoder-model": ["qoder"],
  // 不含 qoder 的模型完全不该被动
  "zcode-only": ["zcode", "loomy"],
};
writeCfg(initial);

// ===== 调被测的真实实现（index.cjs 导出的同一函数，不是复刻） =====
const { pruneOrderOfChannel: prune } = require("../electron/backend/proxy/index.cjs");

const n = prune("qoder");
ok("清理条数为 2（drop-model + only-qoder-model）", n === 2, `实际 ${n}`);

const after = config.loadConfig().proxy.modelOverrides;
ok("drop-model 摘掉 qoder，其余顺序保持不变", JSON.stringify(after["drop-model"]) === '["loomy","zcode"]', JSON.stringify(after["drop-model"]));
ok("keep-model 原样保留（qoder 仍有这个模型）", JSON.stringify(after["keep-model"]) === '["qoder","zcode"]', JSON.stringify(after["keep-model"]));
ok("only-qoder-model 清空后整键删除", !("only-qoder-model" in after));
ok("zcode-only 完全未被动", JSON.stringify(after["zcode-only"]) === '["zcode","loomy"]', JSON.stringify(after["zcode-only"]));

// 重复执行应无副作用（幂等）
ok("再次清理条数为 0（幂等）", prune("qoder") === 0);

// 清理别的渠道不影响已清理结果
prune("loomy");
const after2 = config.loadConfig().proxy.modelOverrides;
ok("清理 loomy 不影响 drop-model 中 loomy 的有效项", JSON.stringify(after2["drop-model"]) === '["loomy","zcode"]', JSON.stringify(after2["drop-model"]));

// ===== 关键边界：渠道被「上游启闭」关闭时，不得清理（否则用户重开就丢排序）=====
console.log("6. 关闭渠道时不清");
{
  const cfg = config.loadConfig();
  cfg.proxy.modelOverrides = { "drop-model": ["qoder", "zcode"] };
  cfg.proxy.channelEnabled = { qoder: false };
  config.saveConfig(cfg);
  const n2 = prune("qoder");
  const after3 = config.loadConfig().proxy.modelOverrides;
  ok("关闭的渠道清理条数为 0", n2 === 0, `实际 ${n2}`);
  ok("关闭渠道的排序项原样保留（重开即可恢复）", JSON.stringify(after3["drop-model"]) === '["qoder","zcode"]', JSON.stringify(after3["drop-model"]));
}

// ===== 关键边界：模型被禁用（disabledModels）时**不清理** =====
// 模型开关与渠道关闭同属用户的临时决定，重开时排序必须还在。
// 判据只看目录：该渠道目录里仍有这个模型 → 不算失效。
console.log("7. 模型被禁用时保留（不清）");
{
  const cfg = config.loadConfig();
  cfg.proxy.modelOverrides = { "drop-model": ["qoder", "loomy"] };
  cfg.proxy.channelEnabled = {};
  cfg.proxy.disabledModels = ["drop-model"];
  config.saveConfig(cfg);
  // drop-model 在 loomy 目录里有，qoder 目录里没有 → qoder 该被清（真下架），loomy 保留
  const n3 = prune("qoder");
  const after4 = config.loadConfig().proxy.modelOverrides;
  ok("模型被禁用不影响「真下架」的判定（qoder 仍被清）", n3 === 1, `实际 ${n3}`);
  ok("清理后只剩 loomy（顺序保持）", JSON.stringify(after4["drop-model"]) === '["loomy"]', JSON.stringify(after4["drop-model"]));
}
{
  // 模型在 qoder 目录里确实存在，只是被禁用 → 不得清理
  const cfg = config.loadConfig();
  cfg.proxy.modelOverrides = { "keep-model": ["qoder", "zcode"] };
  cfg.proxy.channelEnabled = {};
  cfg.proxy.disabledModels = ["keep-model"];
  config.saveConfig(cfg);
  const n4 = prune("qoder");
  const after5 = config.loadConfig().proxy.modelOverrides;
  ok("模型禁用但目录里仍有 → 不清理", n4 === 0, `实际 ${n4}`);
  ok("顺序原样保留（重开模型即恢复）", JSON.stringify(after5["keep-model"]) === '["qoder","zcode"]', JSON.stringify(after5["keep-model"]));
}

console.log(`ORDER PRUNE SELFTEST OK（${pass} 项）`);
process.exit(0);
