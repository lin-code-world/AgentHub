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
process.env.AGENTHUB_DATA_DIR =
  process.argv[2] || require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "agenthub-sandbox-")); // [沙箱] 不传参数即用临时目录，绝不落真实用户数据
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

console.log(`MODEL EXCLUDE SELFTEST OK（${pass} 项）`);
process.exit(0);
