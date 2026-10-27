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
// 页面数据加载态（I6）：号池 / 日志 / 统计三页共用这一份判定，
// 把「还没加载完」「确实没数据」「加载失败（要能重试）」三态分开——
// 全写成「暂无数据」时，服务断开与空号池长得一模一样，用户只会以为「真的没有」。
export type LoadPhase = "loading" | "ready" | "empty" | "failed";

/** loading 优先：首屏未返回时即便带着上一次的旧错误，也更该显示「加载中」。 */
export function loadPhaseOf(input: { loading?: boolean; error?: string | null; count: number }): LoadPhase {
  if (input.loading && input.count <= 0) return "loading";
  if (input.error) return "failed";
  return input.count > 0 ? "ready" : "empty";
}
