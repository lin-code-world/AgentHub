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

/** 只读命令（无副作用）：监视面板与只读令牌都依赖这份判定。
 *  proxy_config_get 入列（Ruling 24）：只是界面分类口径，本任务不改任何鉴权判定 */
const READ = new Set(["proxy_status", "proxy_config_get", "proxy_keys_list", "proxy_pool", "proxy_channel_list", "proxy_models", "proxy_rules_list", "proxy_oplog_list", "proxy_oplog_ops", "proxy_recent", "proxy_stats_overview", "proxy_stats_detail", "proxy_stats_top", "proxy_vault_status", "proxy_provider_list", "proxy_checkin_status", "proxy_scan", "proxy_autoclaw_captcha_config"]);

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

/** browser 形态的独立 deny 文案（Ruling 11）：按浏览器视角逐条改写，不复用容器文案，
 *  禁止出现容器 / 编排 / docker / 宿主机 / gateway-data 等容器形态措辞与本骨架没有的接口名。
 *  除与 DENY 同键的条目外，还含 browser 独有的桌面专用命令（Ruling 16）：令牌查看 / 修改、
 *  目录选择与打开、整份配置读写都只在桌面窗口可用——admin_access_info 会吐出明文令牌，绝不能漏 */
const DENY_BROWSER = {
  proxy_start: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_stop: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_restart: "浏览器访问时不可用：网关启停请在桌面窗口或托盘操作",
  proxy_open_data_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
  proxy_open_rules_dir: "浏览器访问时不可用：打开本机目录请在桌面窗口操作",
  // Ruling 22：browser 文案不得自指「选择文件」（那正是被本命令禁用的按钮），只提粘贴 JSON；
  // 任务 10 加浏览器上传入口后，再回来同步更新这条文案
  proxy_account_import_file: "浏览器访问时不可用：请改用「粘贴 JSON」导入",
  proxy_scan_import: "浏览器访问时不可用：扫描本机登录态请在桌面窗口操作",
  proxy_oauth_begin: "浏览器访问时不可用：OAuth 登录请在桌面窗口操作",
  // 补漏（任务 8）：粘贴回调是 OAuth 登录的收尾命令，begin 被 deny 后它同样不该放行。
  // 刻意只进 browser 表：容器表（DENY）保持 17 条不动，容器形态口径不在本任务调整
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

// 两表同键（DENY → DENY_BROWSER 方向）：deny 命令只写一边就在某个形态静默缺文案，加载期 fail-fast。
// 反方向刻意不要求：DENY_BROWSER 允许有 browser 独有的桌面专用命令（Ruling 16），那些命令容器形态照旧可用
for (const cmd of Object.keys(DENY)) {
  if (!DENY_BROWSER[cmd]) throw new Error(`deny 文案缺失：${cmd} 没有 browser 形态文案`);
}

/** 形态参数 form："container"（容器 headless，默认）/ "browser"（浏览器管理页）。
 *  共有 deny 集合见 DENY（Ruling 11：两形态同集、只差文案）；browser 另含桌面专用命令
 *  （Ruling 16：DENY_BROWSER 独有键，令牌 / 目录 / 整份配置读写只在桌面窗口可用）；
 *  桌面 IPC 直接注册 handler，不套 deny */
function modeOf(cmd, form = "container") {
  if (DENY[cmd] || (form === "browser" && DENY_BROWSER[cmd])) return "deny";
  return READ.has(cmd) ? "read" : "write";
}

/** deny 命令的面向用户原因；非 deny 命令返回 null。
 *  container 用容器文案，browser 用独立改写的浏览器文案（各自成句，前端提示与 403 共用） */
function denyReason(cmd, form = "container") {
  return (form === "browser" ? DENY_BROWSER[cmd] : DENY[cmd]) || null;
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

module.exports = { collect, modeOf, denyReason, READ, DENY, DENY_BROWSER };
