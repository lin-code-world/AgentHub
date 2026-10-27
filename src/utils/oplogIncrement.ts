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
/**
 * 「日志」页增量拉取的决策纯函数（任务 11 评审修复）。
 * 病灶（评审 Important 1/2）：增量响应与整页加载互不加锁，且合并不去重——
 * mock 忽略 sinceId 时 15s 轮询会把同一份行反复拼进表头、lastId 倒退；
 * 增量在飞时用户改筛选/翻页，旧筛选的响应又会污染新结果。
 * 这里把「该不该应用 / 怎么合并 / 基线怎么走」收敛成纯函数，由 tools/oplog-increment-selftest.cjs 逐条守。
 *
 * 口径：
 *   · 快照 = 请求发起时刻的序号 + 筛选/分页指纹（from/to/level/op/page）；
 *     响应回来与「此刻」比对，任何不一致（期间有更新请求、筛选或分页已变）→ 整份丢弃。
 *   · 合并按 id 去重（增量是 id 升序旧→新，倒排后拼表头），截断到一页。
 *   · lastId 只增不减：倒退会让后续增量重复拉旧行。
 *   · 增量条数触顶 limit = 一次没追完，提示调用方回退全量 load()。
 */

/** 请求快照：发起时刻的序号 + 筛选/分页指纹 */
export interface IncrementSnapshot {
  seq: number;
  key: string;
}

/** 生成指纹的筛选/分页状态（与日志页的 filter + page 同源） */
export interface IncrementFilterKey {
  from: number | null;
  to: number | null;
  level: string;
  op: string;
  page: number;
}

/** 筛选/分页指纹：字段全等才算同一份视图 */
export function snapshotKey(f: IncrementFilterKey): string {
  return [f.from ?? "", f.to ?? "", f.level, f.op, f.page].join("|");
}

/** 响应是否仍可应用：序号最新（期间没发起过更新的请求）且筛选/分页未变 */
export function isSnapshotCurrent(issued: IncrementSnapshot, current: IncrementSnapshot): boolean {
  return issued.seq === current.seq && issued.key === current.key;
}

export interface IncrementApply<T> {
  /** false = 过期响应，已整份丢弃（rows/lastId 原样返回，不许调用方改状态） */
  applied: boolean;
  rows: T[];
  lastId: number;
  /** 增量条数触顶 limit：一次没追完，调用方应回退全量 load() */
  needFullReload: boolean;
}

/** 增量应用决策（纯函数）：过期丢弃；可应用则去重合并 + 基线单调 + 触顶回退判定 */
export function applyIncrement<T extends { id: number }>(args: { issued: IncrementSnapshot; current: IncrementSnapshot; rows: T[]; added: T[]; lastId: number; pageSize: number; limit: number }): IncrementApply<T> {
  if (!isSnapshotCurrent(args.issued, args.current)) {
    return { applied: false, rows: args.rows, lastId: args.lastId, needFullReload: false };
  }
  const seen = new Set(args.rows.map((r) => r.id));
  const fresh = args.added.filter((r) => !seen.has(r.id)).reverse();
  const rows = [...fresh, ...args.rows].slice(0, args.pageSize);
  const lastId = args.added.reduce((m, r) => (r.id > m ? r.id : m), args.lastId);
  return { applied: true, rows, lastId, needFullReload: args.added.length >= args.limit };
}

/** 增量入口动作：skip = 全量在飞，让路不动状态；full = 回退整页加载；increment = 走增量拉取 */
export type IncrementPlan = "skip" | "full" | "increment";

/**
 * 增量入口决策（纯函数，Ruling 35）：
 *   · fullLoading（全量在飞）→ skip 让路：调用方不得递增序号、不得改 rows——
 *     否则增量会抢先递增序号，把新筛选的全量挤成过期响应，旧行残留且永不自愈；
 *   · rowsKey ≠ 当前 key：现有行不是当前筛选/分页的基底 → full 回退全量（不许拿旧行当合并基底）；
 *   · 非第 0 页 / 无基线（lastId ≤ 0）→ full。
 */
export function planIncrement(args: { fullLoading: boolean; rowsKey: string; currentKey: string; lastId: number; page: number }): IncrementPlan {
  if (args.fullLoading) return "skip";
  if (args.rowsKey !== args.currentKey) return "full";
  if (args.page !== 0 || args.lastId <= 0) return "full";
  return "increment";
}
