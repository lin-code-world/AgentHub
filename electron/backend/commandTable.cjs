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
// modeOf / denyReason 是"网页端能不能用"的判定：read 只读监视 / write 有副作用 / deny 不可用
//（文案面向用户，前端提示与 403 共用）。
"use strict";

const ipc = require("./ipc.cjs");
const proxyIndex = require("./proxy/index.cjs");

/** 只读命令（无副作用）：监视面板与只读令牌都依赖这份判定。
 *  proxy_config_get 入列（Ruling 24）：只是界面分类口径，本任务不改任何鉴权判定 */
const READ = new Set(["proxy_status", "proxy_config_get", "proxy_keys_list", "proxy_pool", "proxy_channel_list", "proxy_models", "proxy_rules_list", "proxy_oplog_list", "proxy_oplog_ops", "proxy_recent", "proxy_stats_overview", "proxy_stats_detail", "proxy_stats_top", "proxy_vault_status", "proxy_provider_list", "proxy_checkin_status", "proxy_scan", "proxy_autoclaw_captcha_config", "get_is_portable"]);

/** 网页端不可用命令：值面向用户（原因 + 替代路径），前端提示与服务端 403 共用同一份文案。
 *  含浏览器不可用命令与桌面专用命令：令牌查看 / 修改、目录选择与打开、整份配置读写都只在桌面窗口可用
 *  ——admin_access_info 会吐出明文令牌，绝不能漏。
 *  注意 proxy_scan 同时在 READ 集合里（界面分类为只读），网页端仍必须拒：它读回本机登录态候选。 */
const DENY_BROWSER = {
  proxy_start: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_stop: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_restart: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_open_data_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
  proxy_open_rules_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
  // Ruling 22/29：browser 文案不得自指「选择文件」（那正是被本命令禁用的按钮）；任务 10 已加浏览器
  // 上传入口（input[type=file] → proxy_account_import_text），文案随之改指「选择 JSON 文件上传，或粘贴 JSON」，
  // 不提 ZIP——浏览器端只支持单个 JSON，不提前承诺
  proxy_account_import_file: "浏览器访问时不可用：请改用「选择 JSON 文件上传，或粘贴 JSON」导入",
  proxy_scan_import: "浏览器访问时不可用：扫描本机登录态请在桌面窗口操作",
  // I1：proxy_scan 在 READ 集合里（界面分类），但浏览器拿到令牌就能直接 RPC 调它，
  // 读回本机登录态候选（文件路径 / UID / 昵称）。前端置灰之外服务端也要拒
  proxy_scan: "浏览器访问时不可用：扫描本机登录态请在桌面窗口操作",
  proxy_oauth_begin: "浏览器访问时不可用：OAuth 登录请在桌面窗口操作",
  // 粘贴回调是 OAuth 登录的收尾命令，begin 被 deny 后它同样不该放行
  proxy_oauth_submit_callback: "浏览器访问时不可用：OAuth 登录请在桌面窗口操作",
  proxy_ide_status: "浏览器访问时不可用：IDE 切号请在桌面窗口操作",
  proxy_ide_switch: "浏览器访问时不可用：IDE 切号请在桌面窗口操作",
  proxy_oplog_export: "浏览器访问时不可用：导出日志请在桌面窗口操作",
  proxy_zcode_claim_mode: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
  proxy_zcode_device_repair: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
  proxy_zcode_device_status: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
  proxy_zcode_restore_mid: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
  proxy_zcode_switch_rollback: "浏览器访问时不可用：ZCode 设备相关操作请在桌面窗口操作",
  proxy_zcode_solve_captcha: "浏览器访问时不可用：人机校验请在桌面号池页领取",
  // —— browser 独有（Ruling 16）：桌面专用的框架命令，浏览器拿到就是越权（令牌明文 / 本机目录 / 整份配置）——
  admin_access_info: "浏览器访问时不可用：请在桌面窗口查看令牌",
  admin_set_token: "浏览器访问时不可用：请在桌面窗口修改令牌",
  browse_dir: "浏览器访问时不可用：选择目录请在桌面窗口操作",
  open_data_dir: "浏览器访问时不可用：请在桌面窗口打开目录",
  get_data_dir: "浏览器访问时不可用：数据目录请在桌面窗口查看",
  get_app_version: "浏览器访问时不可用：版本信息请在桌面窗口查看",
  load_config: "浏览器访问时不可用：浏览器不支持整份配置读写，请用反代配置页",
  save_config: "浏览器访问时不可用：浏览器不支持整份配置读写，请用反代配置页",
};

/** 网页端命令模式：deny 优先（proxy_scan 虽属只读分类，网页端仍不可用），其余按只读 / 写入分。
 *  桌面 IPC 直接注册 handler，不套 deny */
function modeOf(cmd) {
  if (DENY_BROWSER[cmd]) return "deny";
  return READ.has(cmd) ? "read" : "write";
}

/** deny 命令的面向用户原因；非 deny 命令返回 null（前端提示与 403 共用同一份文案） */
function denyReason(cmd) {
  return DENY_BROWSER[cmd] || null;
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

module.exports = { collect, modeOf, denyReason, READ, DENY_BROWSER };
