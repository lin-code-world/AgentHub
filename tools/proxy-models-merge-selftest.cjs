/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 合并模型目录「按精确写法分行 + 来源渠道明细」自测
// 用法：node tools/proxy-models-merge-selftest.cjs
//
// 合并键必须与路由（modelOwners / nativeModel）同口径，逐字精确：
// WorkBuddy 的 deepseek-v4.1-flash 与 Loomy 的 DeepSeek-V4.1-Flash 是两个不同模型，
// 合成一条会让 /v1/models 与路由口径分裂，前端也拿不到各渠道自己的倍率。
// 行级字段（rate / capabilities / contextLength / maxOutputTokens）的合并口径不变。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-models-merge-"));
process.env.AGENTHUB_DATA_DIR = tmp;

// TS 源文件直载（esbuild 编译成 CJS 后经 require.extensions 挂载），测真实现而不是副本
function installTsLoader() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  Module._extensions[".ts"] = (mod, file) => {
    const src = fs.readFileSync(file, "utf8");
    const out = esbuild.transformSync(src, { loader: "ts", format: "cjs", sourcefile: file }).code;
    mod._compile(out, file);
  };
}

installTsLoader();
const { hiddenByRate } = require(path.join(ROOT, "src", "views", "proxy", "rateGate.ts"));
const { mergeAliasRows } = require(path.join(ROOT, "src", "views", "proxy", "channelRows.ts"));

/** 沙箱目录用完即删：sqlite / watcher 句柄可能仍占用目录，删不掉不影响退出码 */
function cleanup() {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 句柄未释放时留给系统临时目录清理 */
  }
}

let pass = 0,
  fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
    return;
  }
  fail++;
  fails.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
}
const eq = (actual, expected, label) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);

function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  const proxyDir = path.resolve(store.proxyDir()).toLowerCase();
  if (!proxyDir.startsWith(path.resolve(tmp).toLowerCase())) {
    console.error("拒绝运行：数据目录不在沙箱内（" + proxyDir + "）");
    cleanup();
    process.exit(2);
  }
  store.open();
  rules.init();

  // ===== 沙箱目录：小写写法两个渠道（各自倍率/上限不同）+ 大写写法一个渠道 =====
  const ent = (id, extra) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0, ...extra });
  const catFile = path.join(rules.rulesDir(), "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  cat.workbuddy = { syncedAt: 0, models: [ent("deepseek-v4.1-flash", { rate: 0.5, capabilities: { tools: true }, contextLength: 100000, maxOutputTokens: 8000 })] };
  cat.workbuddy_ai = { syncedAt: 0, models: [ent("deepseek-v4.1-flash", { rate: 0.8, capabilities: { images: true }, contextLength: 200000, maxOutputTokens: 16000 })] };
  cat.loomy = { syncedAt: 0, models: [ent("DeepSeek-V4.1-Flash", { rate: 1.2, capabilities: { reasoning: true }, contextLength: 300000, maxOutputTokens: 32000 })] };
  cat.zcode = { syncedAt: 0, models: [] };
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
  rules.reload("catalog.json");

  // 替换 ADAPTERS 为假适配器（只留 models()），复原时用拷贝，避免删键后自己拷自己
  const orig = { ...adapters.ADAPTERS };
  let list;
  let listable;
  try {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, {
      workbuddy: { models: () => ["deepseek-v4.1-flash"] },
      workbuddy_ai: { models: () => ["deepseek-v4.1-flash"] },
      loomy: { models: () => ["DeepSeek-V4.1-Flash"] },
      // 该渠道在目录里没有任何条目：不产生来源明细
      zcode: { models: () => ["no-catalog-model"] },
    });
    list = adapters.mergedModels({});
    // 禁用集合逐字比对：只抹掉被禁的那条写法，不能把仅大小写不同的另一条一起抹掉
    listable = adapters.listableModels({ disabledModels: ["deepseek-v4.1-flash"], channelEnabled: {} });
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, orig);
  }

  console.log("\n[1] 合并键按精确写法分行");
  eq(list.filter((m) => m.id === "deepseek-v4.1-flash").length, 1, "小写写法自占一行");
  eq(list.filter((m) => m.id === "DeepSeek-V4.1-Flash").length, 1, "大写写法自占一行");
  eq(list.filter((m) => m.id.toLowerCase() === "deepseek-v4.1-flash").length, 2, "两种写法共两行（不再并成一条）");

  console.log("\n[2] 来源渠道明细");
  const row = list.find((m) => m.id === "deepseek-v4.1-flash");
  check("同一写法多来源时附明细", Array.isArray(row.sourceDetails) && row.sourceDetails.length === 2, JSON.stringify(row.sourceDetails));
  check(
    "明细里带各渠道自己的倍率",
    row.sourceDetails.every((d) => typeof d.rate === "number" || d.rate === null),
    JSON.stringify(row.sourceDetails)
  );
  eq(
    row.sourceDetails.map((d) => d.channel),
    ["workbuddy", "workbuddy_ai"],
    "明细按来源顺序列渠道"
  );
  eq(
    row.sourceDetails.map((d) => d.id),
    ["deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    "明细带该渠道自己的模型 id"
  );
  eq(
    row.sourceDetails.map((d) => d.rate),
    [0.5, 0.8],
    "各来源倍率互不覆盖"
  );
  eq(
    row.sourceDetails.map((d) => d.contextLength),
    [100000, 200000],
    "明细上下文按渠道各自取值"
  );
  eq(
    row.sourceDetails.map((d) => d.maxOutputTokens),
    [8000, 16000],
    "明细最大输出按渠道各自取值"
  );
  eq(
    row.sourceDetails.map((d) => [d.capabilities.tools === true, d.capabilities.images === true]),
    [
      [true, false],
      [false, true],
    ],
    "明细能力按渠道各自取值"
  );

  const upper = list.find((m) => m.id === "DeepSeek-V4.1-Flash");
  eq(upper.sources, ["loomy"], "大写写法只归属大写渠道");
  eq(
    upper.sourceDetails.map((d) => [d.channel, d.id, d.rate]),
    [["loomy", "DeepSeek-V4.1-Flash", 1.2]],
    "单来源也带明细"
  );

  console.log("\n[3] 行级合并口径不变（供全部视图与 /v1/models）");
  eq(row.sources, ["workbuddy", "workbuddy_ai"], "同行仍是多来源");
  eq(row.rate, 0.5, "行级倍率取第一个有值来源");
  eq([row.capabilities.tools === true, row.capabilities.images === true, row.capabilities.reasoning], [true, true, undefined], "行级能力沿用既有合并（images 取 OR、其余后者覆盖）");
  eq(row.contextLength, 200000, "行级上下文取各来源最大声明");
  eq(row.maxOutputTokens, 16000, "行级最大输出取各来源最大声明");

  console.log("\n[4] 没有目录条目的渠道不产生明细");
  const bare = list.find((m) => m.id === "no-catalog-model");
  check("模型仍列出", !!bare, JSON.stringify(list.map((m) => m.id)));
  check("无目录条目不写 sourceDetails", bare.sourceDetails === undefined, JSON.stringify(bare.sourceDetails));

  console.log("\n[5] 无倍率模型的隐藏规则（按来源渠道判断）");
  eq(hiddenByRate([{ channel: "loomy", rate: null }], "loomy", { loomy: true }), true, "渠道有价而该模型无价 → 隐藏");
  eq(hiddenByRate([{ channel: "trae", rate: null }], "trae", { trae: false }), false, "渠道本身不标价 → 不隐藏");
  const mixed = [
    { channel: "workbuddy", rate: null },
    { channel: "trae", rate: null },
  ];
  eq(hiddenByRate(mixed, "", { workbuddy: true, trae: false }), true, "全部视图：任一来源有价而该模型无价即隐藏");
  eq(hiddenByRate([{ channel: "workbuddy", rate: 0 }], "", { workbuddy: true }), false, "倍率为 0 是有效值，不隐藏");
  eq(hiddenByRate([], "loomy", { loomy: true }), false, "没有来源明细的行保留（不因渠道有价而隐藏）");
  eq(hiddenByRate([{ channel: "loomy", rate: 6.5 }], "loomy", { loomy: true }), false, "有价且有倍率 → 不隐藏");
  eq(hiddenByRate([{ channel: "workbuddy", rate: null }], "loomy", { loomy: true }), false, "当前渠道不在来源里 → 不隐藏");

  console.log("\n[6] 禁用集合逐字比对（listableModels）");
  const listed = listable.map((m) => m.id);
  check("被禁的写法不再对外列出", !listed.includes("deepseek-v4.1-flash"), JSON.stringify(listed));
  eq(listable.filter((m) => m.id === "DeepSeek-V4.1-Flash").length, 1, "仅大小写不同的另一条仍在列");

  console.log("\n[7] 自定义参数与反向映射逐字（大小写不同的写法互不继承）");
  const orig2 = { ...adapters.ADAPTERS };
  try {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, {
      workbuddy: { models: () => ["deepseek-v4.1-flash"] },
      workbuddy_ai: { models: () => ["deepseek-v4.1-flash"] },
      loomy: { models: () => ["DeepSeek-V4.1-Flash"] },
    });
    const custCfg = { modelCustom: { "deepseek-v4.1-flash": { contextLength: 123456, maxOutputTokens: 4321, reasoningEffort: "off" } }, channelEnabled: {} };
    const customList = adapters.mergedModels(custCfg);
    const lowRow = customList.find((m) => m.id === "deepseek-v4.1-flash");
    const upRow = customList.find((m) => m.id === "DeepSeek-V4.1-Flash");
    eq([lowRow.contextLength, lowRow.maxOutputTokens, lowRow.capabilities.reasoning], [123456, 4321, false], "小写写法应用自己的自定义值");
    eq([upRow.contextLength, upRow.maxOutputTokens], [300000, 32000], "大写写法不继承小写写法的自定义值");
    check("大写写法的 reasoning 能力不被小写写法的自定义值污染", upRow.capabilities.reasoning === true, JSON.stringify(upRow.capabilities));
    const revCfg = { modelReverseAliases: { "deepseek-v4.1-flash": { workbuddy: "mapped-real-model" } }, channelEnabled: {} };
    eq(adapters.modelOwners("DEEPSEEK-V4.1-FLASH", revCfg), [], "大写写法不继承小写写法的反向映射归属");
    eq(adapters.resolveModelTarget("DEEPSEEK-V4.1-FLASH", "workbuddy", revCfg), null, "大写写法不解析到小写写法的映射目标");
    check("小写写法自身仍按映射归属", adapters.modelOwners("deepseek-v4.1-flash", revCfg).includes("workbuddy"));
    const perChanCfg = {
      channelEnabled: {},
      modelCustomByChannel: { "DeepSeek-V4.1-Flash": { loomy: { contextLength: 300000, reasoningEffort: "high" } } },
    };
    const perRows = adapters.mergedModels(perChanCfg);
    const perUpper = perRows.find((m) => m.id === "DeepSeek-V4.1-Flash");
    const loomyMeta = (perUpper.sourceDetails || []).find((d) => d.channel === "loomy");
    eq(loomyMeta && loomyMeta.custom, { contextLength: 300000, reasoningEffort: "high" }, "来源明细带该渠道的自定义参数");
    const traeMeta = (perRows.find((m) => m.id === "deepseek-v4.1-flash").sourceDetails || [])[0];
    eq(traeMeta.custom, null, "没有渠道级配置时为 null");
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, orig2);
  }

  console.log("\n[8] 映射目标被禁用时剔除渠道");
  const orig3 = { ...adapters.ADAPTERS };
  try {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, {
      workbuddy: { models: () => ["deepseek-v4.1-flash"] },
      loomy: { models: () => ["DeepSeek-V4.1-Flash"] },
    });
    const revCfg = {
      channelEnabled: {},
      disabledModels: ["DeepSeek-V4.1-Flash"],
      modelReverseAliases: { "deepseek-v4.1-flash": { loomy: "DeepSeek-V4.1-Flash" } },
    };
    const owners = adapters.modelOwners("deepseek-v4.1-flash", revCfg);
    check("映射目标被禁用：loomy 不进归属", !owners.includes("loomy"), JSON.stringify(owners));
    check("其他渠道仍保留", owners.includes("workbuddy"), JSON.stringify(owners));
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, orig3);
  }

  console.log("\n[9] 渠道页别名合并");
  const aliasModels = [
    { id: "deepseek-v4.1-flash", sources: ["trae", "workbuddy", "loomy"] },
    { id: "DeepSeek-V4.1-Flash", sources: ["loomy"] },
  ];
  const revAlias = { "deepseek-v4.1-flash": { loomy: "DeepSeek-V4.1-Flash" } };
  eq(mergeAliasRows(aliasModels, "loomy", revAlias), { visibleIds: ["DeepSeek-V4.1-Flash"], aliasOf: { "DeepSeek-V4.1-Flash": "deepseek-v4.1-flash" } }, "渠道页合并别名行");
  eq(mergeAliasRows(aliasModels, "", revAlias), { visibleIds: ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"], aliasOf: {} }, "全部视图不合并");
  eq(
    mergeAliasRows([aliasModels[0], { id: "DeepSeek-V4.1-Flash", sources: ["trae"] }], "loomy", revAlias),
    { visibleIds: ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"], aliasOf: {} },
    "目标行不属于当前渠道时不合并"
  );
  eq(mergeAliasRows([aliasModels[0]], "loomy", revAlias), { visibleIds: ["deepseek-v4.1-flash"], aliasOf: {} }, "目标行不存在时不合并");

  console.log("\n[10] 按渠道自定义参数配置");
  const config = require("../electron/backend/config.cjs");
  eq(config.defaultConfig().proxy.modelCustomByChannel, {}, "默认配置含空 modelCustomByChannel");

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) {
    for (const f of fails) console.log(`  - ${f}`);
    store.close();
    cleanup();
    process.exit(1);
  }
  store.close();
  cleanup();
  process.exit(0); // sqlite 连接与 watcher 会让事件循环常驻，跑完显式退出
}

try {
  main();
} catch (e) {
  console.error(e);
  cleanup();
  process.exit(1);
}
