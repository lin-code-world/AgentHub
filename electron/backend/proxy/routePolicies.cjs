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
// 反代网关 · 渠道路由插件注册表（约定见 AGENTS.md「渠道路由特殊判断走插件」）
//
// 这里是「某个渠道的路由偏好」的唯一入口：主干（pool.cjs / server.cjs）不认识任何具体渠道，
// 只通过本表问两个问题——
//   ① 这个账号该排多后？          accountRankOf(channel, acc)
//   ② 这个渠道登记过插件吗？      hasPolicy(channel)
// 「整渠道让到队尾」由主干按「该渠道所有可用账号档位都 >0」这个通用语义推导，
// 插件本身不需要知道候选队列、故障转移、冷却这些概念。
//
// 新增：新建 <渠道>/routePolicy.cjs 并加进下面的数组。
// 移除：删掉插件文件并删掉数组里那一行；主干零改动，行为自动回到默认。
"use strict";

const policies = [require("./loomy/routePolicy.cjs")];

/** 该渠道是否登记了路由插件（无插件 → 主干走原路径，不产生额外判断） */
function hasPolicy(channel) {
  const ch = String(channel || "");
  return policies.some((p) => p && p.channel === ch);
}

/** 账号排序档位：同渠道多个插件取最大；插件抛错按 0 兜底——插件异常绝不能影响请求 */
function accountRankOf(channel, acc) {
  const ch = String(channel || "");
  let rank = 0;
  for (const p of policies) {
    if (!p || p.channel !== ch) continue;
    try {
      const r = Number(p.accountRank(acc));
      if (Number.isFinite(r) && r > rank) rank = r;
    } catch {
      /* 插件异常 = 这次不插话 */
    }
  }
  return rank;
}

module.exports = { hasPolicy, accountRankOf };
