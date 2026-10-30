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
// 日志页增量合并决策自测（任务 11 评审修复）：ProxyLogView 的增量应用逻辑抽成纯函数
// src/utils/oplogIncrement.ts，这里逐条守评审点：
//   ① 增量行与现有行重复（mock 忽略 sinceId 的老行为）按 id 去重，列表不叠加、lastId 不倒退
//   ② 筛选/分页切换后，旧筛选的增量响应整份丢弃（不改行、不改基线）
//   ③ 期间已有更新请求（序号过期）的增量响应同样丢弃
//   ④ 正常增量：新行倒序拼表头、截断一页、lastId 前进
//   ⑤ 增量条数触顶 limit → 提示回退全量（高日志速率下追不上的兜底）
//   ⑥ lastId 只增不减（乱序/重复增量不得让基线倒退）
// 纯 Node 跑（require .ts 走 Node 内置类型擦除）。用法：node tools/oplog-increment-selftest.cjs
"use strict";
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const inc = require(path.join(ROOT, "src", "utils", "oplogIncrement.ts"));

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

const rows = (...ids) => ids.map((id) => ({ id, message: "m" + id }));
const KEY_A = inc.snapshotKey({ from: 1, to: 2, level: "", op: "", channel: "", page: 0 });
const KEY_B = inc.snapshotKey({ from: 1, to: 2, level: "warn", op: "", channel: "", page: 0 });
const KEY_P2 = inc.snapshotKey({ from: 1, to: 2, level: "", op: "", channel: "", page: 2 });
const KEY_CH = inc.snapshotKey({ from: 1, to: 2, level: "", op: "", channel: "zcode", page: 0 });

// ===== ① 重复增量去重（mock 忽略 sinceId 时 15s 轮询重复拼接的病灶） =====
{
  const base = rows(3, 2, 1);
  const r1 = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: rows(1, 2, 3), lastId: 3, pageSize: 20, limit: 200 });
  ok("重复增量按 id 去重（列表不叠加）", r1.applied && r1.rows.map((r) => r.id).join(",") === "3,2,1", `rows=${JSON.stringify(r1.rows)}`);
  const r2 = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: r1.rows, added: rows(1, 2, 3), lastId: r1.lastId, pageSize: 20, limit: 200 });
  ok("连续重复增量不增长（15s 轮询重复拼接回归）", r2.rows.map((r) => r.id).join(",") === "3,2,1" && r2.rows.length === 3, `rows=${JSON.stringify(r2.rows)}`);
  ok("重复增量不让 lastId 倒退", r1.lastId === 3 && r2.lastId === 3, `lastId=${r1.lastId}/${r2.lastId}`);
}

// ===== ② 筛选切换后旧增量被丢弃 =====
{
  const base = rows(3, 2, 1);
  const r = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_B }, rows: base, added: rows(4, 5), lastId: 3, pageSize: 20, limit: 200 });
  ok("筛选切换后旧筛选增量整份丢弃", r.applied === false && r.rows === base && r.lastId === 3 && r.needFullReload === false, JSON.stringify({ applied: r.applied, lastId: r.lastId }));
  const p = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_P2 }, rows: base, added: rows(4, 5), lastId: 3, pageSize: 20, limit: 200 });
  ok("翻页后旧增量丢弃（快照含分页）", p.applied === false && p.rows === base && p.lastId === 3);
}

// ===== ③ 序号过期（期间已有更新请求）丢弃 =====
{
  const base = rows(3, 2, 1);
  const r = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 2, key: KEY_A }, rows: base, added: rows(4, 5), lastId: 3, pageSize: 20, limit: 200 });
  ok("期间已发起新请求（seq 过期）时旧增量丢弃", r.applied === false && r.rows === base && r.lastId === 3);
  ok("isSnapshotCurrent 判定快照一致/过期", inc.isSnapshotCurrent({ seq: 1, key: KEY_A }, { seq: 1, key: KEY_A }) === true && inc.isSnapshotCurrent({ seq: 1, key: KEY_A }, { seq: 2, key: KEY_A }) === false && inc.isSnapshotCurrent({ seq: 1, key: KEY_A }, { seq: 1, key: KEY_B }) === false);
}

// ===== ④ 正常增量：拼表头 + lastId 前进 + 截断一页 =====
{
  const base = rows(3, 2, 1);
  const r = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: rows(4, 5), lastId: 3, pageSize: 20, limit: 200 });
  ok("正常增量新行倒序拼表头、lastId 前进", r.applied && r.rows.map((x) => x.id).join(",") === "5,4,3,2,1" && r.lastId === 5, `rows=${JSON.stringify(r.rows.map((x) => x.id))} lastId=${r.lastId}`);
  const big = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: rows(4, 5, 6, 7, 8), lastId: 3, pageSize: 3, limit: 200 });
  ok("合并后截断到一页（最新在前）", big.rows.map((x) => x.id).join(",") === "8,7,6" && big.lastId === 8, `rows=${JSON.stringify(big.rows.map((x) => x.id))}`);
}

// ===== ⑤ 增量触顶 limit → 回退全量 =====
{
  const base = rows(3, 2, 1);
  const full = rows(4, 5, 6);
  const r = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: full, lastId: 3, pageSize: 20, limit: 3 });
  ok("增量条数触顶 limit 提示回退全量", r.applied && r.needFullReload === true, JSON.stringify({ needFullReload: r.needFullReload }));
  const under = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: rows(4), lastId: 3, pageSize: 20, limit: 3 });
  ok("增量未触顶不回退全量", under.needFullReload === false);
}

// ===== ⑥ lastId 只增不减 =====
{
  const base = rows(3, 2, 1);
  const r = inc.applyIncrement({ issued: { seq: 1, key: KEY_A }, current: { seq: 1, key: KEY_A }, rows: base, added: rows(0, 1), lastId: 3, pageSize: 20, limit: 200 });
  ok("乱序/回退 id 不拉低 lastId", r.lastId === 3, `lastId=${r.lastId}`);
  ok("snapshotKey 按筛选/分页区分", KEY_A !== KEY_B && KEY_A !== KEY_P2 && KEY_A === inc.snapshotKey({ from: 1, to: 2, level: "", op: "", channel: "", page: 0 }));
  ok("snapshotKey 含渠道指纹（切渠道后增量必须回退全量）", KEY_CH !== KEY_A && inc.snapshotKey({ from: 1, to: 2, level: "", op: "", channel: "__none__", page: 0 }) !== KEY_A);
}

// ===== ⑦ Ruling 35：全量在飞时增量让路 + rowsKey 不匹配回退全量（评审新破坏的回归） =====
{
  const st = { seq: 3, rows: rows(3, 2, 1), lastId: 3, rowsKey: KEY_A, fullLoading: true };
  const before = JSON.stringify(st);
  const plan = inc.planIncrement({ fullLoading: st.fullLoading, rowsKey: st.rowsKey, currentKey: KEY_B, lastId: st.lastId, page: 0 });
  ok("全量在飞时增量被跳过（不递增序号、不改 rows）", plan === "skip" && JSON.stringify(st) === before, `plan=${plan}`);
  ok("全量在飞时的跳过优先于其它条件（有无基线都让路）", inc.planIncrement({ fullLoading: true, rowsKey: KEY_A, currentKey: KEY_A, lastId: 3, page: 0 }) === "skip" && inc.planIncrement({ fullLoading: true, rowsKey: KEY_A, currentKey: KEY_A, lastId: 0, page: 0 }) === "skip");
}

// ===== ⑧ rowsKey 不是当前视图基底 → 回退全量（旧行不再被增量污染） =====
{
  ok("rowsKey 与当前筛选不匹配时回退全量", inc.planIncrement({ fullLoading: false, rowsKey: KEY_A, currentKey: KEY_B, lastId: 3, page: 0 }) === "full");
  ok("rowsKey 与分页不匹配时同样回退全量", inc.planIncrement({ fullLoading: false, rowsKey: KEY_A, currentKey: KEY_P2, lastId: 3, page: 2 }) === "full");
  ok("无基线（lastId=0）或非第 0 页回退全量", inc.planIncrement({ fullLoading: false, rowsKey: KEY_A, currentKey: KEY_A, lastId: 0, page: 0 }) === "full" && inc.planIncrement({ fullLoading: false, rowsKey: KEY_P2, currentKey: KEY_P2, lastId: 3, page: 2 }) === "full");
}

// ===== ⑨ 正常增量仍工作（防修过头）+ 时序回归 =====
{
  const plan = inc.planIncrement({ fullLoading: false, rowsKey: KEY_A, currentKey: KEY_A, lastId: 3, page: 0 });
  const r = inc.applyIncrement({ issued: { seq: 4, key: KEY_A }, current: { seq: 4, key: KEY_A }, rows: rows(3, 2, 1), added: rows(4, 5), lastId: 3, pageSize: 20, limit: 200 });
  ok("正常增量仍走增量分支并正常合并", plan === "increment" && r.applied && r.rows.map((x) => x.id).join(",") === "5,4,3,2,1" && r.lastId === 5, `plan=${plan} rows=${JSON.stringify(r.rows.map((x) => x.id))}`);
  // 时序回归（评审给的病灶时序）：全量在飞 → 增量 skip 且序号不前进 → 全量完成写 rowsKey → 增量恢复
  let seq = 1;
  const plan1 = inc.planIncrement({ fullLoading: true, rowsKey: KEY_A, currentKey: KEY_B, lastId: 3, page: 0 });
  if (plan1 !== "skip") seq++; // 页面约定：skip 分支在 beginFetch 之前 return，不递增序号、不改 rows
  ok("时序 1：全量在飞时事件触发的增量被跳过且序号不前进", plan1 === "skip" && seq === 1, `plan=${plan1} seq=${seq}`);
  const plan2 = inc.planIncrement({ fullLoading: false, rowsKey: KEY_B, currentKey: KEY_B, lastId: 3, page: 0 });
  ok("时序 2：全量完成写 rowsKey 后增量恢复", plan2 === "increment", `plan=${plan2}`);
}

console.log("");
console.log(`RESULT: ${pass} passed / ${fail} failed`);
if (bad.length) {
  console.log("失败项：");
  for (const b of bad) console.log("  - " + b);
}
process.exit(fail ? 1 : 0);
