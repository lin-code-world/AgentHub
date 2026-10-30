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
// 反代网关 · Loomy 路由插件：每日赠送积分明确为 0、永久积分仍有时，把这个账号在号池里排到后面。
//
// 为什么需要：Loomy 有两个钱包（永久积分 / 每日赠送积分），上游先扣每日赠送、再扣永久积分。
// 网关不参与扣费，只能在余额刷新后按快照调整优先级——让跨渠道故障转移把请求交给其他能跑
// 同一模型的渠道，避免继续消耗永久积分。等次日签到把赠送额度刷回来，档位自然回到 0。
//
// 约定见 AGENTS.md「渠道路由特殊判断走插件」：纯函数、不查库、不发请求；判断不了一律返回 0。
"use strict";

const DAILY = "daily_points";
const PERMANENT = "permanent_points";

function walletOf(list, type) {
  for (const w of list) {
    if (w && w.type === type) return w;
  }
  return null;
}

module.exports = {
  id: "loomy-wallet-tier",
  channel: "loomy",
  /** 0 = 正常；1 = 每日赠送已用完、永久积分还有（该账号排后面）。 */
  accountRank(acc) {
    const list = acc && acc.creditsDetail;
    if (!Array.isArray(list) || !list.length) return 0;
    const daily = walletOf(list, DAILY);
    const permanent = walletOf(list, PERMANENT);
    // 两个钱包都必须明确读到：旧数据没有 known、上游这次漏字段 → 情况不明，不要误切
    if (!daily || !permanent || daily.known !== true || permanent.known !== true) return 0;
    const d = Number(daily.balance);
    const p = Number(permanent.balance);
    if (!Number.isFinite(d) || !Number.isFinite(p)) return 0;
    return d <= 0 && p > 0 ? 1 : 0;
  },
};
