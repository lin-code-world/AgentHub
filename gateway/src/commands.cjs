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
// 容器形态的命令清单与门控。
//
// 收集与门控的事实源是 electron/backend/commandTable.cjs（桌面 IPC 与管理服务共用）：
// 本文件只做容器视角的适配——容器只暴露反代网关命令（proxy_*），框架命令
// （load_config/get_app_version 等）依赖 electron 运行时与桌面配置语义，不进容器命令表。
// read 只读监视 / write 有副作用 / deny 容器不可用的判定原样透传。
"use strict";

const path = require("node:path");

const commandTable = require(path.join(__dirname, "..", "..", "electron", "backend", "commandTable.cjs"));

/** 只读命令（无副作用）：监视面板与只读令牌都依赖这份判定 */
const READ = commandTable.READ;
/** 容器形态不可用：值面向用户（原因 + 替代路径），前端提示与服务端 403 共用同一份文案 */
const DENY = commandTable.DENY;

function modeOf(cmd) {
  return commandTable.modeOf(cmd);
}

/** 容器命令表：proxy_* 全量。register 首行会执行 setUsageRetention(settings())
 *  （幂等，需要配置已可读），调用时机放在 boot() 之后 */
function collectCommands() {
  const all = commandTable.collect();
  return new Map([...all].filter(([cmd]) => cmd.startsWith("proxy_")));
}

module.exports = { collectCommands, modeOf, denyReason: commandTable.denyReason, READ, DENY };
