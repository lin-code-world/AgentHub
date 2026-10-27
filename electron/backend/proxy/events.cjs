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
// 反代网关 · 事件广播：请求完成 / OAuth 结果等按运行形态分发——Electron 推渲染层 IPC，
// headless 走结构化日志（见 platform/index.cjs）
"use strict";

const platform = require("./platform/index.cjs");

function emit(payload) {
  platform.emit(payload);
}

// ===== 节流通知（notify）：日志 / 统计这类高频落库的「有新数据」信号 =====
// 窗口内多次 notify 合并为一条 {type:"oplog"} / {type:"stats"}（300ms / 500ms）：
// **合并的只是通知，不是数据**——每条日志 / 流水照旧逐条落库（oplog.log / store.insertUsage），
// 事件体刻意不带内容，前端收到通知后按自己的节奏拉增量（sinceId / 查询接口）。
const NOTIFY_WINDOW_MS = { oplog: 300, stats: 500 };
const pending = new Map(); // kind → timer：窗口内待发的合并通知

function notify(kind) {
  const windowMs = NOTIFY_WINDOW_MS[kind];
  if (!windowMs) {
    // 未登记窗口的类型没有可合并的语义，直接同步发（新事件类型不必先加表才生效）
    try {
      emit({ type: kind });
    } catch {
      /* 广播失败不影响业务 */
    }
    return;
  }
  if (pending.has(kind)) return; // 窗口内已排队：本次并进上一条
  const timer = setTimeout(() => {
    pending.delete(kind); // Map 清理：窗口结束即出队，下次 notify 开新窗口
    try {
      emit({ type: kind });
    } catch {
      /* 广播失败不影响业务 */
    }
  }, windowMs);
  if (typeof timer.unref === "function") timer.unref(); // 不为一条通知拖住进程退出
  pending.set(kind, timer);
}

module.exports = { emit, notify };
