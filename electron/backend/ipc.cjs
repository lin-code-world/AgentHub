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
// IPC 命令注册：主进程 ipcMain.handle 处理器，对应前端 src/api/ipc.ts
// 框架命令（配置 / 版本 / 数据目录）+ 反代网关命令（proxy/index.cjs 注册）
// preload 白名单和这里要一一对应
//
// 命令实现只有一份：registerCommands(handle, deps) 里是全部框架命令 handler，
// handle 可注入 ipcMain.handle（桌面）或收集器（管理服务，见 commandTable.cjs）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");

// load_config 的内存快照：按 config.json 的 mtime+size 签名失效——proxy_config_save、渠道启闭、
// 按渠道签到等独立 IPC 各自写盘后，快照必须跟着重读；否则桌面拿旧值再整份保存（切主题等）
// 会把刚写下的改动回滚（Ruling 26）。签名比对不需要写盘方通知，天然没有 ipc.cjs ↔ proxy 的循环 require
let cfg = null;
let cfgSig = "";
function sigOf() {
  try {
    const st = fs.statSync(config.configPath());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing"; // 文件不存在（首份配置）：与任何已有签名都不同，下次强制重读
  }
}
function C() {
  const sig = sigOf();
  if (!cfg || sig !== cfgSig) {
    cfg = config.loadConfig();
    cfgSig = sig;
  }
  return cfg;
}
/** 本进程自己写盘后直接替换快照（省一次读盘），签名同步为落盘后的文件状态 */
function setC(next) {
  cfg = next;
  cfgSig = sigOf();
}

function ok(data) {
  return { ok: true, ...data };
}

function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}

// 异常统一收口，渲染层拿到 { ok:false } 而不是 rejected promise
function wrap(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

/** electron API：deps 由桌面 register() 注入（app/shell/dialog/BrowserWindow/nativeTheme）；
 *  命令表收集不注入——收集只注册闭包不执行，这里惰性 require electron，
 *  容器里没装 electron 包也能收集（handler 真被调用时才取，届时按 fail 收口） */
function api(deps, name) {
  return (deps && deps[name]) || require("electron")[name];
}

/** 应用主题同步到原生窗口框架（标题栏/边框）颜色；主题变化时调用 */
function applyNativeTheme(nativeTheme, cfgObj) {
  const theme = cfgObj && cfgObj.theme;
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
}

/** 注册全部框架命令实现（反代网关命令在 proxy/index.cjs 的 register 里，
 *  由 commandTable.collect 组装到同一张表）。handle(cmd, fn) 可注入 ipcMain.handle 或收集器；
 *  deps = { app, shell, dialog, BrowserWindow, nativeTheme }，可省（惰性取 electron） */
function registerCommands(handle, deps) {
  // ===== 框架：配置 =====
  handle("load_config", wrap(() => {
    const c = C();
    applyNativeTheme(api(deps, "nativeTheme"), c);
    return JSON.parse(JSON.stringify(c));
  }));
  // 保存时不做深合并（渲染层持完整配置快照）：仅对已知键做归一化，
  // 主题写回时同步原生标题栏，开机自启即时生效
  handle("save_config", wrap(({ config: next }) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return fail("配置格式不正确");
    const merged = JSON.parse(JSON.stringify(next));
    // 设置页整份提交：out-of-band 字段（channelEnabled/checkinAutoRules）以磁盘为准，
    // 否则渲染层的旧快照会把「上游启闭」「按渠道签到」的写入冲掉（issue #90）
    const r = config.saveConfigFromUI(merged);
    // 落盘成功才更新内存快照，写失败时别把脏数据留给 load_config
    setC(merged);
    applyNativeTheme(api(deps, "nativeTheme"), merged);
    config.applyAutoStart(merged);
    return r;
  }));

  // ===== 框架：其它 =====
  handle("get_app_version", wrap(() => api(deps, "app").getVersion()));
  handle("get_data_dir", () => config.dataDir());
  handle("open_data_dir", wrap(async () => {
    await api(deps, "shell").openPath(config.dataDir());
  }));
  // 便携版判断：开机自启提示用（便携副本是临时解压路径，注册自启无意义）
  handle("get_is_portable", () => config.isPortable());
  handle("browse_dir", wrap(async () => {
    const r = await api(deps, "dialog").showOpenDialog(api(deps, "BrowserWindow").getAllWindows()[0], { properties: ["openDirectory"] });
    return { ok: true, canceled: r.canceled, path: r.canceled ? null : r.filePaths[0] };
  }));

  // ===== 局域网管理访问（管理地址与令牌；管理 HTTP 服务另行提供） =====
  // 令牌明文只经这条桌面 IPC 交给设置页展示，不进日志
  handle("admin_access_info", wrap(() => config.adminAccessInfo()));
  handle("admin_set_token", wrap(({ token }) => {
    const r = config.setAdminToken(token);
    // 令牌变更后刷新内存快照，load_config 返回的 admin.token 才不会是旧密文
    if (r && r.ok) setC(config.loadConfig());
    return r;
  }));
}

/** 桌面注册入口：ctx = { ipcMain, app, shell, nativeTheme }；
 *  走 commandTable.collect 注入真实 ipcMain，注册路径与管理服务收集是同一份 handler */
function register(ctx) {
  require("./commandTable.cjs").collect({ handle: (cmd, fn) => ctx.ipcMain.handle(cmd, fn), deps: ctx });
}

module.exports = { register, registerCommands };
