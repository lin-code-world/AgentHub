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
// 可注入的命令表：桌面 IPC 注册与管理 HTTP 服务共用同一份 { 命令 → handler }。
//
// collect({ handle }) 里 handle(cmd, fn) 注入什么就是什么用途：
//   · 注入 ipcMain.handle → 桌面注册（ipc.cjs 的 register 走这条）；
//   · 注入收集器 → 只拿 Map，管理服务按 modeOf/denyReason 门控后转发到同一 handler。
// 事实源是注册逻辑本身（ipc.cjs 的 registerCommands + proxy/index.cjs 的 register），
// 不另抄一份 handler 列表，避免两处漂移。
//
// modeOf / denyReason 是"形态能不能用"的判定：read 只读监视 / write 有副作用 / deny 不可用，
// 语义与 gateway/src/commands.cjs 的历史实现一致（文案面向用户，前端提示与 403 共用）。
"use strict";

const ipc = require("./ipc.cjs");
const proxyIndex = require("./proxy/index.cjs");

/** 只读命令（无副作用）：监视面板与只读令牌都依赖这份判定 */
const READ = new Set(["proxy_status", "proxy_keys_list", "proxy_pool", "proxy_channel_list", "proxy_models", "proxy_rules_list", "proxy_oplog_list", "proxy_oplog_ops", "proxy_recent", "proxy_stats_overview", "proxy_stats_detail", "proxy_stats_top", "proxy_vault_status", "proxy_provider_list", "proxy_checkin_status", "proxy_scan", "proxy_autoclaw_captcha_config"]);

const SERVICE_CONTROL_REASON = "网关在容器里由编排管理，不能从界面启停——请用 docker restart 或 compose 命令";
const ZCODE_DEVICE_REASON = "ZCode 设备指纹相关操作需要本机客户端，容器里不可用";
const NO_GUI_REASON = "容器没有桌面环境，无法打开目录——数据在宿主机的 ./gateway-data";

/** 不可用命令：值面向用户（原因 + 替代路径），前端提示与服务端 403 共用同一份文案 */
const DENY = {
  proxy_start: SERVICE_CONTROL_REASON,
  proxy_stop: SERVICE_CONTROL_REASON,
  proxy_restart: SERVICE_CONTROL_REASON,
  proxy_open_data_dir: NO_GUI_REASON,
  proxy_open_rules_dir: NO_GUI_REASON,
  proxy_account_import_file: "容器无法弹出文件选择框——请用「粘贴 JSON 导入」或管理 API 的 /api/accounts/import",
  proxy_scan_import: "容器内没有可导入的本机登录态——请粘贴含 token 的凭据 JSON，或用管理 API 的 /api/accounts/import",
  proxy_oauth_begin: "容器内无法完成网页 OAuth（授权回调到不了容器）——请在桌面版登录后「导出选中账号」的明文凭据 JSON，再在容器里粘贴导入",
  proxy_ide_status: "IDE 切号需要本机客户端，容器里不可用",
  proxy_ide_switch: "IDE 切号需要本机客户端，容器里不可用",
  proxy_oplog_export: "容器里不能导出到本机目录——请到桌面版导出，或直接读宿主机数据目录",
  proxy_zcode_claim_mode: ZCODE_DEVICE_REASON,
  proxy_zcode_device_repair: ZCODE_DEVICE_REASON,
  proxy_zcode_device_status: ZCODE_DEVICE_REASON,
  proxy_zcode_restore_mid: ZCODE_DEVICE_REASON,
  proxy_zcode_switch_rollback: ZCODE_DEVICE_REASON,
  proxy_zcode_solve_captcha: "人机校验需要图形环境，容器里无法弹窗——请在桌面版号池页手动领取",
};

function modeOf(cmd) {
  if (DENY[cmd]) return "deny";
  return READ.has(cmd) ? "read" : "write";
}

/** deny 命令的面向用户原因；非 deny 命令返回 null */
function denyReason(cmd) {
  return DENY[cmd] || null;
}

/** 全量命令表（框架命令 + 反代网关命令）。注册副作用：proxy 的 register 首行会执行
 *  setUsageRetention(settings())（幂等，需要配置已可读），调用时机放在 boot() 之后 */
function collect({ handle, deps } = {}) {
  const commands = new Map();
  const put = (cmd, fn) => {
    commands.set(cmd, fn);
    if (handle) handle(cmd, fn);
  };
  ipc.registerCommands(put, deps);
  proxyIndex.register({ handle: put });
  return commands;
}

module.exports = { collect, modeOf, denyReason, READ, DENY };
