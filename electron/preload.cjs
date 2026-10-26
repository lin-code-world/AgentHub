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
// 预加载脚本：通过 contextBridge 暴露安全的 IPC 调用桥给渲染进程
// 白名单机制：只放行后端 ipc.cjs 已注册的命令，防止渲染进程被注入后调用任意通道（纵深防御）
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_COMMANDS = new Set([
  // ===== 框架 =====
  "load_config",
  "save_config",
  "get_app_version",
  "get_data_dir",
  "open_data_dir",
  "browse_dir",
  // ===== 软件更新 =====
  "get_is_portable",
  "get_update_status",
  "check_update",
  "download_update",
  "install_update",
  "open_release_page",
  "open_repo_page",
  // 设置 · 反馈与需求：系统浏览器打开本仓库的 issue 表单
  "open_external_url",
  // ===== 反代网关 =====
  "proxy_status",
  "proxy_start",
  "proxy_stop",
  "proxy_restart",
  "proxy_keys_list",
  "proxy_key_create",
  "proxy_key_update",
  "proxy_key_delete",
  "proxy_keys_delete",
  "proxy_pool",
  "proxy_channel_list",
  "proxy_channel_toggle",
  "proxy_pool_strategy",
  "proxy_pool_tier",
  "proxy_account_add",
  "proxy_account_remove",
  "proxy_account_remove_batch",
  "proxy_account_export_plain",
  "proxy_account_toggle",
  "proxy_account_rename",
  "proxy_account_note",
  "proxy_account_cool_off",
  "proxy_account_refresh",
  "proxy_credits_refresh",
  "proxy_credits_refresh_channel",
  "proxy_checkin_status",
  "proxy_checkin_run",
  "proxy_checkin_auto_set",
  "proxy_scan",
  "proxy_scan_import",
  "proxy_oauth_begin",
  "proxy_oauth_cancel",
  "proxy_oauth_submit_callback",
  "proxy_autoclaw_sms_send",
  "proxy_autoclaw_sms_login",
  "proxy_autoclaw_captcha_config",
  "proxy_loomy_sms_send",
  "proxy_loomy_sms_login",
  "proxy_codearts_welfare_preview",
  "proxy_account_import_json",
  "proxy_account_import_file",
  "proxy_models",
  "proxy_models_sync",
  // 自定义提供商（中转站 / 自建 OpenAI 兼容端点）：命令名必须与 backend/proxy/index.cjs 的
  // handle() 注册面一一对应，漏登记的表现是渲染层收到「未授权的 IPC 命令」并卡在假死态
  "proxy_provider_list",
  "proxy_provider_create",
  "proxy_provider_update",
  "proxy_provider_delete",
  "proxy_provider_add_key",
  "proxy_provider_remove_key",
  "proxy_provider_test",
  "proxy_provider_fetch_models",
  "proxy_ide_switch",
  "proxy_ide_status",
  "proxy_zcode_switch_rollback",
  "proxy_zcode_solve_captcha",
  "proxy_zcode_device_status",
  "proxy_zcode_device_repair",
  "proxy_zcode_claim_mode",
  "proxy_zcode_restore_mid",
  "proxy_stats_overview",
  "proxy_stats_top",
  "proxy_stats_detail",
  "proxy_stats_cleanup",
  "proxy_recent",
  "proxy_oplog_list",
  "proxy_oplog_ops",
  "proxy_oplog_export",
  // ===== 反代网关：网络代理（出口池） =====
  "proxy_netproxy_list",
  "proxy_netproxy_save",
  "proxy_netproxy_remove",
  "proxy_netproxy_toggle",
  "proxy_netproxy_test",
  "proxy_netproxy_settings",
  "proxy_rules_list",
  "proxy_open_rules_dir",
  "proxy_open_data_dir",
  "proxy_vault_status",
  // ===== 反代网关：号池 WebDAV 同步 =====
  "proxy_poolsync_status",
  "proxy_poolsync_run",
  "proxy_poolsync_cancel",
  // ===== 反代网关：生态接入（CC Switch） =====
  "proxy_ccswitch_status",
  "proxy_ccswitch_register",
  // ===== 统一 WebDAV（设置 · 数据存储：共享服务器 + 三模块根目录） =====
  "webdav_shared_get",
  "webdav_shared_save",
  "webdav_shared_test",
  "webdav_shared_clear",
  // ===== 四大板块启用开关（issue #91） =====
  "module_toggle",
  // ===== 远程网关（桌面连远程 Docker 版）=====
  "remote_targets_list",
  "remote_targets_save",
  "remote_targets_delete",
  "remote_targets_activate",
  "remote_test",
  "remote_invoke",
]);

contextBridge.exposeInMainWorld("agenthub", {
  invoke: (cmd, args) => {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      return Promise.reject(new Error(`未授权的 IPC 命令：${cmd}`));
    }
    return ipcRenderer.invoke(cmd, args);
  },
  // 主进程广播（更新状态 / WebDAV 进度 / focus-update 跳转信号），返回退订函数
  onUpdateEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
});
