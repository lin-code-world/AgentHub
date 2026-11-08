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
// 线上配置复现：按远程实例的实际目录与渠道顺序设置，断言 resolveChannel 的落点。
// 用法：AGENTHUB_DATA_DIR=<临时目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-order-live-check.cjs
//
// 复现对象（2026-11-08 远程 192.168.2.129）：
//   · glm-5.3-flash 顺序 = [zcode, autoclaw]
//   · qwen3.8-flash 在 qoder 上被关闭（模型下架），但顺序里仍残留 qoder
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
const server = require("../electron/backend/proxy/server.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");

store.open();
rules.init();

// ===== 目录播种：按远程实际情况造两个共享模型 =====
const catFile = path.join(rules.rulesDir(), "catalog.json");
const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
const seed = (ch, id) => {
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = [...(cat[ch].models || []), ent(id)];
};
// glm-5.3-flash：zcode + autoclaw 都有
for (const ch of ["zcode", "autoclaw"]) seed(ch, "glm-5.3-flash");
// qwen3.8-flash：qoder 已下架；zcode + autoclaw 仍有
for (const ch of ["zcode", "autoclaw"]) seed(ch, "qwen3.8-flash");
fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
rules.reload("catalog.json");

function mkAcc(channel, credits) {
  const id = store.addAccount({ channel, name: `${channel}-${credits}`, token: "x" });
  store.updateAccount(id, { credits, creditsAt: Date.now(), status: "online" });
  return id;
}
// 余额故意让 zcode 低于 autoclaw：若不按用户顺序，score 档会选 autoclaw
const ids = [mkAcc("zcode", 100), mkAcc("autoclaw", 999999)];

try {
  console.log("1. glm-5.3-flash 顺序 [zcode, autoclaw]");
  const owners = adapters.modelOwners("glm-5.3-flash");
  ok("归属渠道恰为 zcode + autoclaw", owners.length === 2 && owners.includes("zcode") && owners.includes("autoclaw"));
  // 先证明不设顺序时按余额选 autoclaw（说明顺序确实在起作用）
  const noOrder = server.resolveChannel({ route: "auto" }, "glm-5.3-flash", { routeStrategy: "auto", modelOverrides: {} });
  ok("不设顺序时按打分选余额高的 autoclaw", noOrder.channel === "autoclaw", `实际 ${noOrder.channel}`);
  // 设顺序后应选 zcode
  const withOrder = server.resolveChannel({ route: "auto" }, "glm-5.3-flash", {
    routeStrategy: "auto",
    modelOverrides: { "glm-5.3-flash": ["zcode", "autoclaw"] },
  });
  ok("设置顺序后主渠道变为 zcode（顺序生效）", withOrder.channel === "zcode", `实际 ${withOrder.channel}`);

  console.log("2. qwen3.8-flash 顺序残留已下架的 qoder");
  const qOwners = adapters.modelOwners("qwen3.8-flash");
  ok("qoder 已下架，不在归属渠道里", !qOwners.includes("qoder"), `归属 ${qOwners.join(",")}`);
  const staleResolved = server.resolveChannel({ route: "auto" }, "qwen3.8-flash", {
    routeStrategy: "auto",
    modelOverrides: { "qwen3.8-flash": ["qoder", "autoclaw", "zcode"] },
  });
  ok("残留的 qoder 被剔除，主渠道按有效顺序的 autoclaw", staleResolved.channel === "autoclaw", `实际 ${staleResolved.channel}`);

  // 前端过滤口径：与 resolveChannel 一致
  const raw = server.normalizeModelOrder(["qoder", "autoclaw", "zcode"]);
  const validSet = new Set(qOwners);
  const shown = raw.filter((ch) => validSet.has(ch));
  const stale = raw.filter((ch) => !validSet.has(ch));
  ok("界面应显示的有效顺序为 [autoclaw, zcode]", JSON.stringify(shown) === '["autoclaw","zcode"]', JSON.stringify(shown));
  ok("界面应标注的失效项为 [qoder]", JSON.stringify(stale) === '["qoder"]', JSON.stringify(stale));
} finally {
  for (const id of ids) store.removeAccount(id);
}

console.log(`ORDER LIVE CHECK OK（${pass} 项）`);
process.exit(0);
