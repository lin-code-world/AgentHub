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
// 模型级渠道排除自测：归属过滤 / 路由分支 / 对外清单 / 排序归类。
// 用法：AGENTHUB_DATA_DIR=<临时目录> node tools/proxy-model-exclude-selftest.cjs
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
/** 集合相等（不依赖渠道返回顺序） */
function setEq(arr, expect) {
  return JSON.stringify([...(arr || [])].sort()) === JSON.stringify([...expect].sort());
}

const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const config = require("../electron/backend/config.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const server = require("../electron/backend/proxy/server.cjs");

store.open();
rules.init();

// ===== 目录播种：qoder / zcode 都提供 shared-model；zcode 另提供 solo-model 与大小写字面模型 =====
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
for (const ch of ["qoder", "zcode"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent("shared-model")];
}
cat["zcode"].models = [...(cat["zcode"].models || []), ent("solo-model"), ent("GLM-5.3-Flash")];
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

function setCfg({ channelEnabled, modelOverrides, disabledModels, modelExcludedChannels, routeStrategy, fixedChannel, modelReverseAliases } = {}) {
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = channelEnabled || {};
  cfg.proxy.modelOverrides = modelOverrides || {};
  cfg.proxy.disabledModels = disabledModels || [];
  cfg.proxy.modelExcludedChannels = modelExcludedChannels || {};
  cfg.proxy.modelReverseAliases = modelReverseAliases || {};
  cfg.proxy.routeStrategy = routeStrategy || "smart";
  cfg.proxy.fixedChannel = fixedChannel || "qoder";
  config.saveConfig(cfg);
  return config.loadConfig().proxy;
}

/** 与 index.cjs 的 proxy_models 里 override 归类同构（那是闭包内联逻辑，抽不出来）：excluded > valid > muted > stale */
function classify(model, orderArr, cfg) {
  const raw = server.normalizeModelOrder(orderArr);
  const validSet = new Set(adapters.modelOwners(model, cfg));
  const excludedSet = new Set(adapters.modelExcludedChannelsOf(model, cfg));
  const override = [];
  const stale = [];
  const muted = [];
  const excluded = [];
  for (const ch of raw) {
    if (excludedSet.has(ch)) {
      excluded.push(ch);
      continue;
    }
    if (validSet.has(ch)) {
      override.push(ch);
      continue;
    }
    if (adapters.get(ch) && !adapters.channelOn(ch, cfg)) {
      muted.push(ch);
      continue;
    }
    stale.push(ch);
  }
  return { override, stale, muted, excluded };
}

// ===== 1. 归属过滤（modelOwners）=====
console.log("1. 归属过滤");
{
  let c = setCfg({});
  ok("无排除时两渠道都归属", setEq(adapters.modelOwners("shared-model", c), ["qoder", "zcode"]), JSON.stringify(adapters.modelOwners("shared-model", c)));

  c = setCfg({ modelExcludedChannels: { "shared-model": ["zcode"] } });
  ok("排除 zcode 后归属只剩 qoder", setEq(adapters.modelOwners("shared-model", c), ["qoder"]), JSON.stringify(adapters.modelOwners("shared-model", c)));
  ok("同渠道其它模型不受影响", adapters.modelOwners("solo-model", c).includes("zcode"));
  ok("大小写字面互不影响", adapters.modelOwners("GLM-5.3-Flash", c).includes("zcode"));
  ok("IgnoringExclusions 仍返回全部", setEq(adapters.modelOwnersIgnoringExclusions("shared-model", c), ["qoder", "zcode"]), JSON.stringify(adapters.modelOwnersIgnoringExclusions("shared-model", c)));

  c = setCfg({ modelExcludedChannels: { "shared-model": "zcode" } });
  ok("非法配置按不排除处理", adapters.modelOwners("shared-model", c).includes("zcode"));
}

// ===== 2. 请求路径（resolveChannel）=====
console.log("2. 请求路径");
{
  // 7) 被排除渠道不进主渠道候选（即便排序把它排第一）
  let c = setCfg({ modelExcludedChannels: { "shared-model": ["qoder"] }, modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  ok("被排除渠道不当主渠道", server.resolveChannel({ route: "auto" }, "shared-model", c).channel === "zcode", JSON.stringify(server.resolveChannel({ route: "auto" }, "shared-model", c)));
  // 对照：无排除时排序第一的 qoder 会被选中
  c = setCfg({ modelOverrides: { "shared-model": ["qoder", "zcode"] } });
  ok("对照：无排除时排第一的 qoder 成为主渠道", server.resolveChannel({ route: "auto" }, "shared-model", c).channel === "qoder", JSON.stringify(server.resolveChannel({ route: "auto" }, "shared-model", c)));

  // 8) 全排除 → excludedModel
  c = setCfg({ modelExcludedChannels: { "solo-model": ["zcode"] } });
  ok("全排除返回 excludedModel", server.resolveChannel({ route: "auto" }, "solo-model", c).excludedModel === "solo-model", JSON.stringify(server.resolveChannel({ route: "auto" }, "solo-model", c)));

  // 9) 全排除 + fixed 策略：不得透传打到固定渠道
  c = setCfg({ routeStrategy: "fixed", fixedChannel: "zcode", modelExcludedChannels: { "solo-model": ["zcode"] } });
  ok("全排除在 fixed 下仍拒绝", server.resolveChannel({ route: "auto" }, "solo-model", c).excludedModel === "solo-model", JSON.stringify(server.resolveChannel({ route: "auto" }, "solo-model", c)));

  // 10) Key 绑定被排除渠道 → excludedBoundChannel
  c = setCfg({ modelExcludedChannels: { "shared-model": ["zcode"] } });
  const bound = server.resolveChannel({ route: "zcode" }, "shared-model", c);
  ok("Key 绑定被排除渠道 → excludedBoundChannel", !!(bound.excludedBoundChannel && bound.excludedBoundChannel.channel === "zcode"), JSON.stringify(bound));
}

// ===== 3. 对外清单与排序归类 =====
console.log("3. 对外清单与排序归类");
{
  // 11) 全排除 → 不出现在对外清单
  let c = setCfg({ modelExcludedChannels: { "shared-model": ["qoder", "zcode"] } });
  ok("全排除模型不出现在对外清单", !adapters.listableModels(c).some((m) => m.id === "shared-model"));
  // 12) 部分排除 → 仍列出
  c = setCfg({ modelExcludedChannels: { "shared-model": ["zcode"] } });
  ok(
    "部分排除仍对外列出",
    adapters.listableModels(c).some((m) => m.id === "shared-model")
  );

  // 13) 排序归类：被排除渠道归入 overrideExcluded（与 index.cjs 同构）
  c = setCfg({ modelExcludedChannels: { "shared-model": ["zcode"] }, modelOverrides: { "shared-model": ["zcode", "qoder"] } });
  const r = classify("shared-model", ["zcode", "qoder"], c);
  ok("被排除渠道归入 overrideExcluded", JSON.stringify(r.excluded) === '["zcode"]', JSON.stringify(r.excluded));
  ok("有效项保留在 override", JSON.stringify(r.override) === '["qoder"]', JSON.stringify(r.override));
}

// ===== 4. 复查修复（非法形状崩溃 / 单源 Key 绑定返回码 / 备选队列）=====
console.log("4. 复查修复");
{
  // 14) 备选队列来源不含被排除渠道（备选队列 = 主渠道 + modelOwners 余项）
  let c = setCfg({ modelExcludedChannels: { "shared-model": ["zcode"] } });
  const res = server.resolveChannel({ route: "auto" }, "shared-model", c);
  const queue = [res.channel, ...adapters.modelOwners("shared-model", c).filter((x) => x !== res.channel)];
  ok("备选队列不含被排除渠道", !queue.includes("zcode"), JSON.stringify(queue));

  // 15) 非法配置形状：归类（真实实现）不崩溃、不排除
  c = setCfg({ modelExcludedChannels: { "shared-model": { zcode: true } } });
  const cls = adapters.classifyOverride("shared-model", ["zcode", "qoder"], c);
  ok("非法形状不崩溃且不排除", cls.excluded.length === 0 && cls.override.includes("zcode") && cls.override.includes("qoder"), JSON.stringify(cls));

  // 16) 单源 + Key 绑定被排除渠道 → excludedBoundChannel（不是 excludedModel）
  c = setCfg({ modelExcludedChannels: { "solo-model": ["zcode"] } });
  const b2 = server.resolveChannel({ route: "zcode" }, "solo-model", c);
  ok("单源 Key 绑定被排除渠道 → excludedBoundChannel", !!b2.excludedBoundChannel, JSON.stringify(b2));
}

console.log(`MODEL EXCLUDE SELFTEST OK（${pass} 项）`);
process.exit(0);
