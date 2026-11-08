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
// 模型渠道自定义顺序自测：位次比较器 / 旧配置兼容 / 主渠道与备选队列 / 软边界
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-model-order-selftest.cjs
//
// 断言面：
//   ① normalizeModelOrder 覆盖磁盘全部历史形态（数组 / 旧版单字符串 / 脏值）
//   ②cmpByOrder 位次语义：用户顺序优先、未排到的软兜底垫底、位次相同回落 score/cost-first
//   ③ 可用性压过用户顺序（issue #86：排第一但打空的渠道不得抢占主渠道位）
//   ④ resolveChannel 主渠道选择 + 旧版单值 + fixed 策略不被无效覆盖项挡掉
//   ⑤ isExplicitRoute 的软边界口径（渠道覆盖不再算显式边界）
"use strict";
process.env.AGENTHUB_DATA_DIR = process.argv[2] || require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "agenthub-sandbox-")); // [沙箱] 不传参数即用临时目录，绝不落真实用户数据
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

let pass = 0;
function ok(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  pass++;
  console.log(`  ok ${name}`);
}

const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const server = require("../electron/backend/proxy/server.cjs");

store.open();
rules.init();

// ===== 目录播种：代码不内置任何渠道模型，沙箱里必须自己种一个三渠道共有的模型 =====
const MODEL = "order-model";
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
for (const ch of ["modelscope", "zcode", "lobster"]) {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent(MODEL)];
}
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

const owners = require("../electron/backend/proxy/adapters.cjs").modelOwners(MODEL);
ok("目录播种后三渠道都拥有该模型", owners.length === 3);

// ===== 造号：余额让 score 档默认顺序与用户顺序不同，才能证明 override 真生效 =====
function mkAcc(channel, credits) {
  const id = store.addAccount({ channel, name: `${channel}-${credits}`, token: "x" });
  store.updateAccount(id, { credits, creditsAt: Date.now(), status: "online" });
  return id;
}
const [msId, zcId, lbId] = [mkAcc("modelscope", 5), mkAcc("zcode", 9999), mkAcc("lobster", 100)];

try {
  const { cmpByOrder, pickByOrder, normalizeModelOrder } = server;

  // ===== 1. 归一化 =====
  console.log("1. 归一化");
  ok("数组原样", JSON.stringify(normalizeModelOrder(["b", "a"])) === '["b","a"]');
  ok("旧版单字符串 → 长度 1 数组", JSON.stringify(normalizeModelOrder("b")) === '["b"]');
  ok("空串 / null → 空数组", normalizeModelOrder(null).length === 0 && normalizeModelOrder("").length === 0);
  ok("数字 / 对象 / 布尔 → 空数组", normalizeModelOrder(42).length === 0 && normalizeModelOrder({ a: 1 }).length === 0 && normalizeModelOrder(true).length === 0);
  ok("数组里的空值被过滤", JSON.stringify(normalizeModelOrder(["b", "", null, "a"])) === '["b","a"]');
  ok("重复项去重且保留首次位次", JSON.stringify(normalizeModelOrder(["b", "a", "b"])) === '["b","a"]');

  // ===== 2. 位次语义 =====
  console.log("2. 位次语义");
  const groups = server.tierGroups();
  const cands = ["zcode", "modelscope", "lobster"];
  const ordered = [...cands].sort(cmpByOrder("score", groups, undefined, ["modelscope", "lobster"]));
  ok("用户顺序第一", ordered[0] === "modelscope");
  ok("用户顺序第二", ordered[1] === "lobster");
  ok("未排到的渠道排最后且仍在队列里", ordered[2] === "zcode" && ordered.length === 3);
  ok("都没排到时按现有 score 降序（zcode 余额高在前）", ["zcode", "modelscope"].sort(cmpByOrder("score", groups, undefined, ["lobster"]))[0] === "zcode");
  ok("无 override 时 score 档行为不变", ["modelscope", "zcode"].sort(cmpByOrder("score", groups))[0] === "zcode");
  ok("无 override 时 cost-first 档行为不变", ["lobster", "modelscope"].sort(cmpByOrder("cost-first", groups))[0] === "modelscope");
  ok("pickByOrder 按用户顺序取首", pickByOrder("score", ["zcode", "modelscope"], groups, ["modelscope"]) === "modelscope");

  // ===== 3. 可用性压过用户顺序（issue #86）=====
  console.log("3. 可用性优先");
  const usableOnly = (ch) => ch !== "lobster";
  const availability = ["lobster", "modelscope"].sort(cmpByOrder("score", groups, undefined, ["lobster", "modelscope"], usableOnly));
  ok("排第一但不可用的渠道仍垫底", availability[0] === "modelscope");
  // 无 usableOf 时顺序表独揽第一键（调用方契约：生产两个调用点都必须传）
  ok("不传 usableOf 时按顺序表排（调用方契约）", ["lobster", "modelscope"].sort(cmpByOrder("score", groups, undefined, ["lobster", "modelscope"]))[0] === "lobster");

  // ===== 4. resolveChannel 主渠道 =====
  console.log("4. 主渠道选择");
  const settings = { routeStrategy: "auto", modelOverrides: { [MODEL]: ["lobster", "zcode", "modelscope"] } };
  ok("用户顺序第一成为主渠道", server.resolveChannel({ route: "auto" }, MODEL, settings).channel === "lobster");
  ok("无顺序时按现有 score 选主渠道（zcode 余额最高）", server.resolveChannel({ route: "auto" }, MODEL, { routeStrategy: "auto", modelOverrides: {} }).channel === "zcode");
  ok("旧版单字符串覆盖仍能把渠道排到第一", server.resolveChannel({ route: "auto" }, MODEL, { routeStrategy: "auto", modelOverrides: { [MODEL]: "lobster" } }).channel === "lobster");

  // 排第一但该渠道不可用 → 落到下一个可用渠道
  store.updateAccount(lbId, { status: "exhausted" });
  ok("排第一但不可用时不抢占主渠道（issue #86）", server.resolveChannel({ route: "auto" }, MODEL, settings).channel === "zcode");
  store.updateAccount(lbId, { status: "online" });

  // 无效覆盖项不得挡掉 fixed 策略（覆盖项指向不属于本模型的渠道）
  const stray = server.resolveChannel({ route: "auto" }, MODEL, { routeStrategy: "fixed", fixedChannel: "zcode", modelOverrides: { [MODEL]: ["trae"] } });
  ok("无效覆盖项不挡掉 fixed 策略", stray.channel === "zcode");
  // fixed + 有效顺序：顺序更具体，优先于全局默认
  const fixedWithOrder = server.resolveChannel({ route: "auto" }, MODEL, { routeStrategy: "fixed", fixedChannel: "zcode", modelOverrides: { [MODEL]: ["lobster"] } });
  ok("有效顺序优先于 fixed 全局默认", fixedWithOrder.channel === "lobster");

  // ===== 5. 软边界口径 =====
  console.log("5. 软边界");
  ok("渠道覆盖命中不算显式路由（允许插件让位）", server.isExplicitRoute({ route: "auto" }, { modelOverrides: { [MODEL]: ["lobster"] } }, MODEL, "lobster") === false);
  ok("Key 绑定仍算显式路由", server.isExplicitRoute({ route: "lobster" }, {}, MODEL, "lobster") === true);
  ok("固定策略命中仍算显式路由", server.isExplicitRoute({ route: "auto" }, { routeStrategy: "fixed", fixedChannel: "zcode" }, MODEL, "zcode") === true);
  ok("固定渠道没命中仍可让位", server.isExplicitRoute({ route: "auto" }, { routeStrategy: "fixed", fixedChannel: "trae" }, MODEL, "zcode") === false);
} finally {
  for (const id of [msId, zcId, lbId]) store.removeAccount(id);
}

console.log(`MODEL-ORDER SELFTEST OK（${pass} 项）`);
// rules.init() 起了文件监听（chokidar / fs.watch），不显式退出会让进程挂住
process.exit(0);
