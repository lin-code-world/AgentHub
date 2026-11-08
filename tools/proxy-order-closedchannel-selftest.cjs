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
// 关闭渠道的请求路由跳过自测：界面不显示的项，路由必须同样不选它。
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-order-closedchannel-selftest.cjs
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

const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
// 三渠道共享 m1；qoder 与 zcode 还独有各自模型
for (const ch of ["qoder", "zcode", "autoclaw"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent("m1")];
}
cat.qoder.models = [...cat.qoder.models, ent("qoder-only")];
cat.zcode.models = [...cat.zcode.models, ent("zcode-only")];
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

function setCfg(patch) {
  const cfg = config.loadConfig();
  Object.assign(cfg.proxy, patch);
  config.saveConfig(cfg);
  return config.loadConfig().proxy;
}

// ===== 1. 全开：排第一的 qoder 应该被选中 =====
console.log("1. 全开对照组");
{
  const c = setCfg({ channelEnabled: {}, disabledModels: [], modelOverrides: { m1: ["qoder", "zcode", "autoclaw"] } });
  ok("owners 含 qoder", adapters.modelOwners("m1", c).includes("qoder"));
  ok("主渠道是排第一的 qoder", server.resolveChannel({ route: "auto" }, "m1", c).channel === "qoder");
}

// ===== 2. 关闭 qoder：即便它排在第一位也必须跳过 =====
console.log("2. 关闭排第一的渠道");
{
  const c = setCfg({ channelEnabled: { qoder: false } });
  ok("owners 不含 qoder", !adapters.modelOwners("m1", c).includes("qoder"), JSON.stringify(adapters.modelOwners("m1", c)));
  const main = server.resolveChannel({ route: "auto" }, "m1", c).channel;
  ok("主渠道跳过 qoder，落到下一位 zcode", main === "zcode", `实际 ${main}`);
}

// ===== 3. 关闭渠道的独有模型：不该出现在可路由模型里 =====
console.log("3. 关闭渠道的独有模型");
{
  const c = setCfg({ channelEnabled: { qoder: false } });
  ok("qoder-only 无归属渠道", adapters.modelOwners("qoder-only", c).length === 0, JSON.stringify(adapters.modelOwners("qoder-only", c)));
  const r = server.resolveChannel({ route: "auto" }, "qoder-only", c);
  ok("请求该模型不会落到 qoder", r.channel !== "qoder", `实际 ${r.channel}`);
}

// ===== 4. 关闭渠道不在对外模型清单里 =====
console.log("4. 对外模型清单");
{
  const c = setCfg({ channelEnabled: { qoder: false } });
  const list = adapters.listableModels(c).map((m) => m.id);
  ok("qoder-only 不在 /v1/models 清单", !list.includes("qoder-only"), JSON.stringify(list));
  ok("共享模型 m1 仍在清单（还有别的渠道）", list.includes("m1"));
}

// ===== 5. 关闭的渠道不会被当成故障转移备选 =====
console.log("5. 故障转移备选");
{
  const c = setCfg({ channelEnabled: { qoder: false } });
  // 备选队列来自 modelOwners 去掉主渠道：关闭渠道本就不在 owners 里
  const owners = adapters.modelOwners("m1", c).filter((ch) => ch !== "zcode");
  ok("备选队列不含 qoder", !owners.includes("qoder"), JSON.stringify(owners));
}

// ===== 6. Key 绑定到关闭渠道：明确拒绝，不静默改道 =====
console.log("6. 显式绑定关闭渠道");
{
  const c = setCfg({ channelEnabled: { qoder: false } });
  const r = server.resolveChannel({ route: "qoder" }, "m1", c);
  ok("绑定关闭渠道 → 返回 disabledBoundChannel", r.disabledBoundChannel === "qoder", JSON.stringify(r));
  ok("不会静默改到别的渠道", r.channel === null || r.channel === undefined, `实际 ${r.channel}`);
}

// ===== 7. 重开渠道后恢复 =====
console.log("7. 重开恢复");
{
  const c = setCfg({ channelEnabled: {} });
  ok("重开后 owners 又含 qoder", adapters.modelOwners("m1", c).includes("qoder"));
  ok("重开后主渠道回到 qoder", server.resolveChannel({ route: "auto" }, "m1", c).channel === "qoder");
}

console.log(`CLOSED-CHANNEL ROUTE SELFTEST OK（${pass} 项）`);
process.exit(0);
