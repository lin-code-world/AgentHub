/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 事件节流通知与日志增量查询自测（任务 11：日志/统计准实时更新）。
// 覆盖：
//   ① notify("oplog") 300ms 窗口内 20 次只 emit 1 条 {type:"oplog"}，跨窗口后再调用再发 1 条
//   ② notify("stats") 500ms 窗口内多次只发 1 条 {type:"stats"}（store.insertUsage 落库后触发）
//   ③ 合并的只是通知不是数据：oplog.log 逐条落库，通知只发一条
//   ④ 事件体不带内容：emit 的载荷只有 type，日志 message/target/detail 不得进事件
//   ⑤ notify 抛错不影响 oplog 落库 / usage 落库（通知失败绝不能反噬业务数据）
//   ⑥ store.listOpLogs({ sinceId }) 只返回更大的 id 且按 id 升序（前端增量拉取的数据源）
// 纯 Node 跑（node:sqlite，不加载 electron）。用法：node tools/event-throttle-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-evtnotify-"));
process.env.AGENTHUB_DATA_DIR = path.join(SANDBOX, "data"); // 沙箱：绝不触碰真实用户数据

const platform = require(path.join(ROOT, "electron", "backend", "proxy", "platform", "index.cjs"));
const events = require(path.join(ROOT, "electron", "backend", "proxy", "events.cjs"));
const oplog = require(path.join(ROOT, "electron", "backend", "proxy", "oplog.cjs"));
const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));

let pass = 0,
  fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 用例分段执行：某段抛错（如 notify 未实现）记 FAIL 后继续跑完其余用例，不整体崩掉 */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(name, false, String((e && e.message) || e));
  }
}

(async () => {
  // 事件收口：platform.onEmit 是 events.emit 的下游（桌面 IPC / SSE 桥都订阅它），拿它当观测点不绕过真实链路
  const seen = [];
  const off = platform.onEmit((p) => seen.push(p));

  // ===== ① oplog 通知 300ms 节流 + 跨窗口再发 =====
  await step("oplog 300ms 节流", async () => {
    for (let i = 0; i < 20; i++) events.notify("oplog");
    await sleep(450);
    ok('300ms 内 notify("oplog") 20 次只 emit 1 条', seen.length === 1 && seen[0] && seen[0].type === "oplog", `条数=${seen.length} 载荷=${JSON.stringify(seen)}`);
    events.notify("oplog");
    await sleep(450);
    ok("跨窗口后再 notify 再发 1 条（累计 2 条）", seen.length === 2 && seen[1].type === "oplog", `条数=${seen.length}`);
  });

  // ===== ③ 合并的只是通知不是数据：逐条落库、通知只发一条 =====
  await step("合并的只是通知", async () => {
    seen.length = 0;
    for (let i = 0; i < 5; i++) oplog.log("info", "自测节流", `第 ${i} 条日志`);
    await sleep(450);
    const logged = store.listOpLogs({ op: "自测节流", limit: 50 }).rows;
    ok("5 次 oplog.log 逐条落库（合并的只是通知）", logged.length === 5, `落库=${logged.length}`);
    ok("5 次落库只发 1 条 oplog 通知", seen.length === 1 && seen[0].type === "oplog", `条数=${seen.length} 载荷=${JSON.stringify(seen)}`);
  });

  // ===== ④ 事件体不含日志内容 =====
  await step("事件体不含内容", async () => {
    seen.length = 0;
    oplog.log("warn", "自测脱敏", "TOPSECRET-CONTENT", { target: "TOPSECRET-TARGET", detail: "TOPSECRET-DETAIL" });
    await sleep(450);
    const dump = JSON.stringify(seen);
    ok("事件体不含日志内容（message/target/detail 不进事件）", seen.length === 1 && seen[0].type === "oplog" && !dump.includes("TOPSECRET") && !("message" in seen[0]) && !("detail" in seen[0]) && !("target" in seen[0]), `载荷=${dump}`);
  });

  // ===== ② stats 通知 500ms 节流（store.insertUsage 落库后触发） =====
  await step("stats 500ms 节流", async () => {
    seen.length = 0;
    for (let i = 0; i < 10; i++) store.insertUsage({ ts: Date.now(), reqId: `r${i}`, keyId: "", keyName: "", channel: "trae", accountId: "", accountName: "", model: "m", promptTokens: 1, completionTokens: 1, status: 200 });
    await sleep(700);
    ok('500ms 内 insertUsage 10 次只发 1 条 {type:"stats"}', seen.length === 1 && seen[0].type === "stats", `条数=${seen.length} 载荷=${JSON.stringify(seen)}`);
    ok("10 条 usage 逐条落库", (store.recentRequests(10) || []).length === 10, `落库=${(store.recentRequests(10) || []).length}`);
  });

  // ===== ⑤ notify 抛错不影响落库 =====
  await step("notify 容错", async () => {
    const realNotify = events.notify;
    events.notify = () => {
      throw new Error("notify boom");
    };
    let logThrew = false;
    try {
      oplog.log("error", "自测容错", "notify 抛错也要落库");
    } catch {
      logThrew = true;
    }
    let usageThrew = false;
    try {
      store.insertUsage({ ts: Date.now(), reqId: "boom", keyId: "", keyName: "", channel: "trae", accountId: "", accountName: "", model: "m", promptTokens: 1, completionTokens: 1, status: 200 });
    } catch {
      usageThrew = true;
    }
    events.notify = realNotify;
    const okLog = store.listOpLogs({ op: "自测容错", limit: 10 }).rows.some((r) => r.message.includes("notify 抛错也要落库"));
    const okUsage = (store.recentRequests(5) || []).some((r) => r.reqId === "boom");
    ok("notify 抛错不影响 oplog 落库", !logThrew && okLog, `threw=${logThrew} 落库=${okLog}`);
    ok("notify 抛错不影响 usage 落库", !usageThrew && okUsage, `threw=${usageThrew} 落库=${okUsage}`);
  });

  // ===== ⑥ listOpLogs({ sinceId }) 增量查询 =====
  await step("sinceId 增量", async () => {
    const latest = store.listOpLogs({ limit: 1 }).rows[0];
    const sinceId = latest ? latest.id : 0;
    oplog.log("info", "自测增量", "A");
    oplog.log("info", "自测增量", "B");
    oplog.log("info", "自测增量", "C");
    const inc = store.listOpLogs({ op: "自测增量", sinceId, limit: 50 });
    const asc = inc.rows.every((r, i) => r.id > sinceId && (i === 0 || r.id > inc.rows[i - 1].id));
    ok("listOpLogs({ sinceId }) 只返回更大的 id 且按 id 升序", inc.rows.length === 3 && asc, `rows=${JSON.stringify(inc.rows.map((r) => [r.id, r.message]))} sinceId=${sinceId}`);
    const empty = store.listOpLogs({ op: "自测增量", sinceId: inc.rows[inc.rows.length - 1].id });
    ok("sinceId 取到最新 id 时增量为空", empty.rows.length === 0, `rows=${JSON.stringify(empty.rows)}`);
    ok("sinceId 模式 total 仍是筛选总数（分页标题用）", inc.total === 3, `total=${inc.total}`);
  });

  // ===== ⑥b channel 筛选：非哨兵精确匹配；__none__ 哨兵 = 空渠道精确匹配；缺省不过滤 =====
  await step("channel 筛选", async () => {
    oplog.log("info", "自测渠道", "A", { channel: "zcode" });
    oplog.log("info", "自测渠道", "B", { channel: "raccoon" });
    oplog.log("info", "自测渠道", "C");
    const onlyZ = store.listOpLogs({ op: "自测渠道", channel: "zcode", limit: 50 });
    ok("channel 非空值精确匹配", onlyZ.rows.length === 1 && onlyZ.rows[0].channel === "zcode" && onlyZ.total === 1, `rows=${JSON.stringify(onlyZ.rows.map((r) => r.channel))}`);
    const none = store.listOpLogs({ op: "自测渠道", channel: "__none__", limit: 50 });
    ok("__none__ 哨兵命中空渠道", none.rows.length === 1 && none.rows[0].channel === "" && none.total === 1, `rows=${JSON.stringify(none.rows.map((r) => r.channel))}`);
    const all = store.listOpLogs({ op: "自测渠道", limit: 50 });
    ok("channel 缺省不过滤", all.total === 3, `total=${all.total}`);
  });

  // ===== ⑦ 号池结构事件（I5）：账号增删改 / 导入 / 渠道启闭广播 {type:"pool"} =====
  await step("pool 结构事件", async () => {
    const commandTable = require(path.join(ROOT, "electron", "backend", "commandTable.cjs"));
    const credits = require(path.join(ROOT, "electron", "backend", "proxy", "credits.cjs"));
    // 入池即刷额度会真发网络请求：替换成空实现（额度语义在 proxy-import-text-selftest 里另测）
    credits.refreshAccount = async () => ({});
    const commands = commandTable.collect({});
    const poolSeen = () => seen.filter((p) => p && p.type === "pool").length;

    seen.length = 0;
    const added = await commands.get("proxy_account_add")(null, { channel: "trae", token: "selftest-token", name: "自测账号" });
    ok("自测账号入池", !!(added && added.ok !== false && added.id), JSON.stringify(added));
    ok("账号新增广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);

    seen.length = 0;
    await commands.get("proxy_account_rename")(null, { id: added.id, name: "自测改名" });
    ok("账号重命名广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);

    seen.length = 0;
    await commands.get("proxy_account_toggle")(null, { id: added.id, enabled: false });
    ok("账号启停广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);

    seen.length = 0;
    await commands.get("proxy_account_remove")(null, { id: added.id });
    ok("账号删除广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);

    seen.length = 0;
    const imported = await commands.get("proxy_account_import_json")(null, { channel: "trae", json: JSON.stringify([{ channel: "trae", uid: "selftest-uid", token: "selftest-token" }]) });
    ok("粘贴 JSON 导入成功", !!(imported && imported.ok !== false && imported.added === 1), JSON.stringify(imported));
    ok("导入落库广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);

    seen.length = 0;
    await commands.get("proxy_pool_strategy")(null, { channel: "trae", strategy: "credit_first" });
    ok("调度策略变更广播 {type:'pool'}", poolSeen() === 1, `事件=${JSON.stringify(seen)}`);
  });

  off();
  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) {
    console.log("失败项：");
    for (const b of bad) console.log("  - " + b);
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
  process.exit(fail ? 1 : 0);
})();
