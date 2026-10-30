/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 渠道路由插件让位自测（离线可跑，不打真上游）
// 覆盖：候选队列重排/截断（让位渠道保留末位）、显式边界门控、账号级分层与渠道级让位判定。
// 约定见 AGENTS.md「渠道路由特殊判断走插件」。
//
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-channel-defer-selftest.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-channel-defer-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%；CI 另用 AGENTHUB_DATA_DIR 沙箱
if (!process.env.AGENTHUB_DATA_DIR) process.env.AGENTHUB_DATA_DIR = tmp;

let pass = 0,
  fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`);
  }
}
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

(async () => {
  const store = require("../electron/backend/proxy/store.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const server = require("../electron/backend/proxy/server.cjs");
  store.open();

  // ===== 1. 候选队列：让位 + 截断 =====
  eq(server.orderCandidateQueue(["a", "b", "c"], 3, false), { queue: ["a", "b", "c"], deferred: false }, "不让位：保持原序");
  eq(server.orderCandidateQueue(["a", "b", "c"], 3, true), { queue: ["b", "c", "a"], deferred: true }, "让位：首选挪到队尾");
  eq(server.orderCandidateQueue(["a", "b", "c", "d"], 3, true), { queue: ["b", "c", "a"], deferred: true }, "让位 + 超限：挤掉原末位，让位渠道保留在末位");
  eq(server.orderCandidateQueue(["a", "b", "c", "d"], 3, false), { queue: ["a", "b", "c"], deferred: false }, "不让位 + 超限：按原序截断");
  eq(server.orderCandidateQueue(["a"], 3, true), { queue: ["a"], deferred: false }, "单渠道：没有让位对象");
  eq(server.orderCandidateQueue(["a", "b"], 1, true), { queue: ["a"], deferred: false }, "故障转移关闭（limit=1）：不让位");
  eq(server.orderCandidateQueue([], 3, true), { queue: [], deferred: false }, "空队列不炸");

  // ===== 2. 显式边界门控 =====
  const autoKey = { route: "auto" };
  eq(server.isExplicitRoute(autoKey, {}, "m", "loomy"), false, "智能路由：不是显式边界");
  eq(server.isExplicitRoute({ route: "loomy" }, {}, "m", "loomy"), true, "Key 绑定渠道：显式边界");
  eq(server.isExplicitRoute(autoKey, { routeStrategy: "fixed", fixedChannel: "loomy" }, "m", "loomy"), true, "固定策略命中：显式边界");
  eq(server.isExplicitRoute(autoKey, { routeStrategy: "fixed", fixedChannel: "workbuddy" }, "m", "loomy"), false, "固定渠道没命中（未生效）：仍可按智能路由让位");
  eq(server.isExplicitRoute(autoKey, { modelOverrides: { m: "loomy" } }, "m", "loomy"), true, "单模型指定命中：显式边界");
  eq(server.isExplicitRoute(autoKey, { modelOverrides: { m: "other" } }, "m", "loomy"), false, "单模型指定没命中：仍可让位");

  // ===== 3. 账号分层 + 渠道让位（沙箱 store）=====
  const mk = (uid, daily, permanent, detail = true) => {
    const id = store.addAccount({ channel: "loomy", uid, name: uid, token: `tok-${uid}`, source: "paste" });
    if (detail) {
      store.setCreditsDetail(id, [
        { type: "permanent_points", displayName: "永久积分", balance: permanent, known: true },
        { type: "daily_points", displayName: "每日赠送积分", balance: daily, known: true },
      ]);
    }
    return id;
  };
  const onlyPermanent = mk("defer-a", 0, 30000);
  const hasDaily = mk("defer-b", 5000, 30000);

  eq(
    pool.accountRank(
      "loomy",
      store.listAccounts("loomy").find((a) => a.id === onlyPermanent)
    ),
    1,
    "A：每日赠送 0、永久还有 → 靠后"
  );
  eq(
    pool.accountRank(
      "loomy",
      store.listAccounts("loomy").find((a) => a.id === hasDaily)
    ),
    0,
    "B：每日赠送还有 → 正常"
  );
  eq(pool.channelDeferred("loomy"), false, "渠道里还有 B → 整渠道不让位");
  eq(pool.channelDeferred("workbuddy"), false, "无插件渠道 → 不让位");

  const picked = pool.pickAccount("loomy", "expire_first", [], 0);
  eq(picked && picked.id, hasDaily, "选号：每日赠送还有的 B 优先（A 排到后面）");

  store.updateAccount(hasDaily, { status: "disabled" });
  eq(pool.channelDeferred("loomy"), true, "只剩 A（每日赠送 0）→ 整渠道让位");
  const picked2 = pool.pickAccount("loomy", "expire_first", [], 0);
  eq(picked2 && picked2.id, onlyPermanent, "让位不等于禁用：唯一可用账号仍能被选中");

  const unknown = mk("defer-c", 0, 0, false); // 从未刷新过余额明细的在线号
  eq(pool.channelDeferred("loomy"), false, "存在明细未知的在线账号 → 保守不让位");

  store.updateAccount(unknown, { status: "disabled" });
  eq(pool.channelDeferred("loomy"), true, "未知账号停用后恢复判定");

  // 余额已耗尽的号（会被 pickAccount 标 exhausted）不算「正常账号」，不能挡住整渠道让位
  const empty = mk("defer-d", 0, 0);
  store.updateAccount(empty, { credits: 0, creditsAt: Date.now() });
  eq(pool.channelDeferred("loomy"), true, "余额已耗尽的号不阻止让位");

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
