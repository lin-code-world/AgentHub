/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 关窗决策的**纯逻辑**：不 require electron，便于自测直接覆盖。
//
// 背景（为什么关窗要销毁窗口而不是 hide）：
//   应用是托盘常驻形态（反代网关在主进程跑），窗口只是「看板」。
//   实测：hide() 只是把窗口藏起来，渲染进程照旧常驻（本机实测 390.1 → 390.3 MB，
//   渲染进程 151.2 → 148.0 MB，等于没省）；只有 destroy() 才会让渲染进程整只消失。
//   真实实例里渲染进程单独占 298 MB，而空闲 CPU 实测 ≈0% —— 所以这是个**内存**问题。
//
// 语义边界（务必与 main.cjs 的 close 分支一致）：
//   · quitting              —— 托盘「退出」/更新重启：放行，真正退出
//   · packaged=false        —— 开发运行（npm run dev）：关窗即退出，不驻留托盘
//   · minimizeToTray=true   —— 关窗销毁界面进程，托盘与后台服务照常运行（唤回时重建）
//   · minimizeToTray=false  —— 关窗即退出应用（托盘不保留）
"use strict";

/** 关窗动作：quit=放行真退出 / destroy=销毁窗口（释放渲染进程，应用继续驻留托盘） */
const ACTIONS = Object.freeze(["quit", "destroy"]);

/**
 * 决定「用户点了关闭按钮」时该做什么。
 *
 * @param {{quitting?: boolean, minimizeToTray?: boolean, packaged?: boolean}} input
 *   packaged=false 表示开发运行（npm run dev）：关窗一律退出，改完代码不该被托盘留着跑旧进程
 * @returns {"quit"|"destroy"}
 */
function decideCloseAction(input) {
  const it = input || {};
  if (it.quitting === true) return "quit";
  // 开发运行不驻留托盘：省得每次改完代码还要去托盘右键退出（且旧进程会占着 9527 端口）。
  // packaged 缺省按 true 处理——保守方向是「不改变已装用户的关窗行为」
  if (it.packaged === false) return "quit";
  return it.minimizeToTray === true ? "destroy" : "quit";
}

/** 该动作是否真的销毁窗口（用于日志与托盘文案，避免各处再写一遍字符串比较） */
function releasesRenderer(action) {
  return action === "destroy";
}

module.exports = { ACTIONS, decideCloseAction, releasesRenderer };
