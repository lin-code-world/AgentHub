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
// 框架命令（配置 / 版本 / 数据目录）+ 反代网关命令（proxy/index.cjs 注册）+ 统一 WebDAV
// preload 白名单和这里要一一对应
"use strict";
const path = require("node:path");
const { app, shell, dialog, BrowserWindow } = require("electron");
const config = require("./config.cjs");
const webdav = require("./webdav.cjs");
const proxy = require("./proxy/index.cjs");
const proxyRemote = require("./proxy/remote.cjs");

// 渲染层拿到的密码一律是掩码；保存/测试连接收到精确掩码时回填磁盘真值
const PASSWORD_MASK = "••••••••";

function maskConfig(c) {
  const out = JSON.parse(JSON.stringify(c));
  if (out.webdav && out.webdav.password) out.webdav.password = PASSWORD_MASK;
  if (out.webdavShared && out.webdavShared.password) out.webdavShared.password = PASSWORD_MASK;
  return out;
}

// 表单传回的密码是掩码时用磁盘真值替换，防止掩码被当密码存盘
function unmaskPassword(next) {
  const disk = config.loadConfig();
  if (next && next.webdav && next.webdav.password === PASSWORD_MASK) {
    next.webdav.password = disk.webdav.password || "";
  }
  if (next && next.webdavShared && next.webdavShared.password === PASSWORD_MASK) {
    next.webdavShared.password = (disk.webdavShared && disk.webdavShared.password) || "";
  }
  return next;
}

let cfg = null;
function C() {
  if (!cfg) cfg = config.loadConfig();
  return cfg;
}

function ok(data) {
  return { ok: true, ...data };
}

function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}

// 异常统一收口，渲染层拿到 { ok:false } 而不是 rejected promise
function handle(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

/** 托盘等 main 侧直写配置后调用：作废内存快照，下一次 load_config 重读磁盘。
 *  不作废的话 C() 会一直返回旧快照（含托盘刚改过的 schedule 字段）。 */
function refreshConfigCache() {
  cfg = null;
}

/** 应用主题同步到原生窗口框架（标题栏/边框）颜色；主题变化时调用 */
function applyNativeTheme(nativeTheme, cfgObj) {
  const theme = cfgObj && cfgObj.theme;
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
}

/** 注册所有 IPC handler。ctx = { ipcMain, app, shell, nativeTheme } */
function register(ctx) {
  const { ipcMain, nativeTheme } = ctx;

  // ===== 框架：配置 =====
  ipcMain.handle("load_config", handle(() => {
    const c = C();
    applyNativeTheme(nativeTheme, c);
    return maskConfig(c);
  }));
  // 保存时不做深合并（渲染层持完整配置快照）：仅对已知键做归一化，
  // 主题写回时同步原生标题栏，WebDAV 掩码密码回填真值，开机自启即时生效
  ipcMain.handle("save_config", handle(({ config: next }) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return fail("配置格式不正确");
    const merged = unmaskPassword(JSON.parse(JSON.stringify(next)));
    // 设置页整份提交：out-of-band 字段（channelEnabled/checkinAutoRules）以磁盘为准，
    // 否则渲染层的旧快照会把「上游启闭」「按渠道签到」的写入冲掉（issue #90）
    const r = config.saveConfigFromUI(merged);
    // 落盘成功才更新内存快照，写失败时别把脏数据留给 load_config
    cfg = merged;
    applyNativeTheme(nativeTheme, merged);
    config.applyAutoStart(merged);
    return r;
  }));

  // ===== 框架：其它 =====
  ipcMain.handle("get_app_version", () => app.getVersion());
  ipcMain.handle("get_data_dir", () => config.dataDir());
  ipcMain.handle("open_data_dir", async () => {
    await shell.openPath(config.dataDir());
  });
  // 便携版判断：开机自启提示用（便携副本是临时解压路径，注册自启无意义）
  ipcMain.handle("get_is_portable", () => config.isPortable());
  ipcMain.handle("browse_dir", handle(async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], { properties: ["openDirectory"] });
    return { ok: true, canceled: r.canceled, path: r.canceled ? null : r.filePaths[0] };
  }));

  // ===== 统一 WebDAV（设置 · 数据存储）：共享服务器 + 号池根目录 =====
  ipcMain.handle("webdav_shared_get", handle(() => config.maskedSharedWebdav()));
  ipcMain.handle("webdav_shared_save", handle(({ config: form }) => {
    const before = config.loadSharedWebdav().endpoint;
    const r = config.saveSharedWebdav(form || {});
    cfg = null; // 内存快照已过期：后续整份写盘的命令若拿旧快照会把刚存的服务器配置冲回去（issue #95）
    // WebDAV 密码同时是号池压缩包的加密口令：改动后令历史包标记 keyChange，下次同步重打包
    try { require("./proxy/poolsync.cjs").onSharedPasswordMaybeChanged(); } catch { /* 模块未装载不影响保存 */ }
    // 首次配置（之前没配服务器，这次配上）自动跑一次号池同步：API Keys 与模型映射随
    // 共享配置包落到本机，「换台电脑」配好服务器即得，不用去发现「立即同步号池」（issue #92）。
    // 已配置时改字段不触发；失败静默（号池面板看得到状态，定时同步下轮也会补）
    const after = config.loadSharedWebdav().endpoint;
    if (!before && after) {
      try { require("./proxy/poolsync.cjs").run({}).catch(() => {}); } catch { /* 同步互斥等静默，状态面板可见 */ }
    }
    return r;
  }));
  ipcMain.handle("webdav_shared_clear", handle(() => {
    const r = config.clearSharedWebdav();
    cfg = null;
    return r;
  }));
  ipcMain.handle("webdav_shared_test", handle(({ config: form }) => {
    const cur = config.loadSharedWebdav();
    const f = form && typeof form === "object" ? form : {};
    const fs3 = f.s3 && typeof f.s3 === "object" ? f.s3 : {};
    const cfg = {
      endpoint: String(f.endpoint ?? cur.endpoint),
      username: String(f.username ?? cur.username),
      password: f.password === config.PASSWORD_MASK || f.password == null ? cur.password : String(f.password),
      root: String(f.root ?? cur.roots.proxy),
    };
    // S3 模式（issue #89）：注入 __s3 标记与桶参数，webdav.test 分派到 S3 传输
    if ((f.type ?? cur.type) === "s3") {
      cfg.__s3 = true;
      cfg.bucket = String(fs3.bucket ?? cur.s3.bucket);
      cfg.region = String(fs3.region ?? cur.s3.region);
      cfg.pathStyle = fs3.pathStyle ?? cur.s3.pathStyle;
    }
    return webdav.test(cfg);
  }));

  // ===== 反代网关（命令实现见 backend/proxy/index.cjs） =====
  proxy.register(ipcMain);

  // ===== 远程网关（桌面连远程 Docker 版：目标管理与命令转发，实现见 backend/proxy/remote.cjs） =====
  // 转发在主进程做：管理令牌不进渲染进程；地址/协议校验（http 仅私网）内聚在 remote.cjs
  ipcMain.handle("remote_targets_list", handle(() => proxyRemote.listTargets()));
  ipcMain.handle("remote_targets_save", handle((p) => proxyRemote.saveTarget(p)));
  ipcMain.handle("remote_targets_delete", handle(({ id }) => proxyRemote.deleteTarget(id)));
  ipcMain.handle("remote_targets_activate", handle(({ id }) => proxyRemote.activateTarget(id)));
  ipcMain.handle("remote_test", handle((p) => proxyRemote.testTarget(p)));
  ipcMain.handle("remote_invoke", handle(({ cmd, args }) => proxyRemote.rpc(cmd, args)));
}

module.exports = { register, refreshConfigCache };
