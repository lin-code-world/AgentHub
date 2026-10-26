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
// Electron 主进程入口：窗口 / 托盘 / 单实例 / 主题同步 / 全局大小自适应 / 软件自更新
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, nativeTheme, Notification, globalShortcut } = require("electron");

// ===== 闪退取证（本地补丁 __agenthubCrashTrace）=====
// 1.42.0 出现静默退出：Windows 无 Application Error 事件、无 minidump、应用自身零日志，
// 只能靠重启时间戳反推。这里把 JS 异常 / 子进程死亡 / 退出原因全部落到 userData/logs/crash.log，
// 并启用本地 crashpad（只落盘不上传）——原生崩溃会留下 minidump，debug.log 的 "not connected" 噪音随之消失。
const { crashReporter } = require("electron");
// 行写入与截断逻辑抽到 backend/crashlog.cjs：backend 模块（如会话流水 worker 的父进程侧）
// 也要写同一份取证日志——child-process-gone 不覆盖 node 子进程，那边必须自行落痕
const __crashlog = require("./backend/crashlog.cjs");
let __crashCount = 0;
// 顶层 require 链完成前，任何未捕获异常都意味着模块图不完整：后续 whenReady/建窗不会执行，
// 继续活着只会变成「无窗口僵尸」。启动阶段用它区分「真崩溃」与「可降级的运行时异常」。
let bootPhase = "requires";
const MB = 1024 * 1024;
function memUsage() {
  const m = process.memoryUsage();
  return `rss=${Math.round(m.rss / MB)}MB heap=${Math.round(m.heapUsed / MB)}MB ext=${Math.round(m.external / MB)}MB`;
}
function crashLogFile() {
  return path.join(process.env.APPDATA || app.getPath("appData"), "AgentHub", "logs", "crash.log");
}
function __crashLog(kind, detail) {
  if (__crashCount > 50) return;
  __crashCount++;
  __crashlog.write(kind, detail);
}
function __describe(e) {
  if (e instanceof Error) return `${e.name}: ${e.message} :: ${String(e.stack || "").replace(/\s+/g, " ").slice(0, 1200)}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}
try { crashReporter.start({ uploadToServer: false, submitURL: "" }); } catch { /* 无 crashReporter 则仅失去 dump 能力 */ }
// 启动留痕：放在 whenReady 里，确保 app.setName 之后再取 userData（否则会落到错误目录）
app.whenReady().then(() => {
  try { __crashLog("boot", `v${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} ${memUsage()}`); } catch { /* 忽略 */ }
  // 休眠唤醒守卫：注册 powerMonitor 的 suspend/resume，供各周期任务判断「是否刚唤醒」
  // （避免唤醒瞬间签到 + 额度刷新集中爆发，见 backend/wakeGuard.cjs）。
  // 事件同时写入 crash.log——Windows Modern Standby 是否派发 resume 尚无定论，
  // 留痕后下次实际睡眠即可在日志里核实该守卫是否真的生效。
  try {
    const wk = require("./backend/wakeGuard.cjs");
    wk.start({ powerMonitor: require("electron").powerMonitor, log: __crashLog });
  } catch (e) { __crashLog("wake-guard-failed", __describe(e)); }
});
// 捕获而非退出：托盘常驻的反代网关被别的工具依赖，宁可降级活着也要把根因留痕（每次运行最多记 50 条）
process.on("uncaughtException", (e) => {
  __crashLog("uncaughtException", __describe(e));
  // 启动阶段（顶层 require）失败时后续 whenReady/建窗都不会执行：明确弹窗并退出，
  // 避免用户看到「双击没反应/一闪而过」却拿不到任何信息。
  if (bootPhase === "requires") {
    try {
      require("electron").dialog.showErrorBox("AgentHub 启动失败", `原生组件加载失败：${(e && e.message) || e}\n日志：${crashLogFile()}`);
    } catch { /* 无 GUI 时只退出 */ }
    app.exit(1);
  }
});
process.on("unhandledRejection", (r) => __crashLog("unhandledRejection", __describe(r)));
process.on("exit", (code) => {
  let sync = "n/a";
  try { sync = require("./backend/webdav.cjs").syncBusyTag() || "idle"; } catch { /* 模块未加载 */ }
  __crashLog("exit", `code=${code} uptime=${Math.round(process.uptime())}s ${memUsage()} sync=${sync}`);
});
app.on("child-process-gone", (_e, d) => __crashLog("child-process-gone", __describe(d)));
app.on("render-process-gone", (_e, _wc, d) => __crashLog("render-process-gone", __describe(d)));
app.on("gpu-process-gone", (_e, d) => __crashLog("gpu-process-gone", __describe(d)));
app.on("quit", (_e, code) => __crashLog("quit", `exitCode=${code}`));
// 渲染进程无响应取证：界面「卡死/未响应」不崩溃、不退出，此前零痕迹（2026-10-05 卡死排查实证——
// crashpad 25 个 dump 全来自 node 子进程，渲染进程冻结无一字留痕）。unresponsive/responsive 成对
// 落盘，与同期的 worker/同步日志对齐即可定位因果；Chromium 的挂起检测有去重，不会刷屏。
app.on("browser-window-created", (_e, win) => {
  const wc = win && win.webContents;
  if (!wc) return;
  wc.on("unresponsive", () => { let u = ""; try { u = String(wc.getURL()).slice(0, 200); } catch { /* 已销毁 */ } __crashLog("render-unresponsive", `url=${u}`); });
  wc.on("responsive", () => __crashLog("render-responsive", ""));
});
// 内存高水位留痕（issue #146 猜想 3）：只在 RSS 超过 1.5GB 且继续增长 512MB 时记一条，
// 避免占满 __crashCount 配额；正常 ASCII 路径零开销。
let memWarnAt = 0;
const memTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss < 1536 * MB || rss - memWarnAt < 512 * MB) return;
  memWarnAt = rss;
  __crashLog("memory-high", memUsage());
}, 5 * 60 * 1000);
memTimer.unref?.();
// 同步卡死留痕（issue #146 猜想 2）：正常一次远端同步最长约 90s（30s×重试），
// 持锁超过 10 分钟即疑似卡死；同一标签每 15 分钟最多记一条。
let stallTag = "";
let stallAt = 0;
const stallTimer = setInterval(() => {
  let wd;
  try { wd = require("./backend/webdav.cjs"); } catch { return; }
  const tag = wd.syncBusyTag();
  const held = wd.syncHeldMs();
  if (!tag || held < 10 * 60 * 1000) { stallTag = ""; stallAt = 0; return; }
  if (tag === stallTag && Date.now() - stallAt < 15 * 60 * 1000) return;
  stallTag = tag;
  stallAt = Date.now();
  __crashLog("sync-stall", `tag=${tag} held=${Math.round(held / 1000)}s`);
}, 60 * 1000);
stallTimer.unref?.();
// ===== 闪退取证结束 =====

const config = require("./backend/config.cjs");
const ipc = require("./backend/ipc.cjs");
// 反代网关模块：本地 OpenAI 兼容服务（默认 127.0.0.1:9527），托盘常驻期间持续提供 API
const proxy = require("./backend/proxy/index.cjs");
// 全局快捷键：唤起/释放界面。冲突时弹气泡并持续重试（见 backend/shortcut.cjs）
const shortcut = require("./backend/shortcut.cjs");
// 轻量模式：关窗决策（纯逻辑，可自测）+ 窗口几何持久化（销毁窗口后重建要回到原位）
const windowMode = require("./backend/window-mode.cjs");
const windowState = require("./backend/window-state.cjs");
// 顶层 require 链完成：此后的未捕获异常可以降级记录，不再按「启动失败」弹窗退出
bootPhase = "ready";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:1420";

// 目录名用 productName 大小写（userData = %APPDATA%\AgentHub），与安装名/任务栏一致
app.setName("AgentHub");

let mainWindow = null;
let tray = null;
let quitting = false;

/** 资源目录：打包后为 process.resourcesPath 的相邻 build，开发时为项目 build/ */
function buildDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "build") : path.join(__dirname, "..", "build");
}

function iconPath(name) {
  try {
    return nativeImage.createFromPath(path.join(buildDir(), name));
  } catch {
    return nativeImage.createEmpty();
  }
}

/** 应用主题同步到原生窗口框架（标题栏/边框）：否则外框颜色只跟系统主题走，不跟应用主题走。
 *
 *  同时同步**窗口画布底色**：BrowserWindow 的 backgroundColor 是窗口在页面首帧渲染出来
 *  之前铺的底色。此前写死为深色 #0a0c0f ✗ —— 浅色主题下每次窗口重建都会先铺黑底、
 *  再被首帧覆盖 → **闪黑** ✗。而本 PR 的轻量模式恰恰会**销毁窗口**，
 *  用户下次唤回必然走 createWindow() 重建 → 该闪烁会被明显放大 ✓ 故一并修掉。
 *  与 src/styles/global.css 的 --bg 取值一致：dark #0a0c0f / light #f4f6f9。
 *  setBackgroundColor 对已存在窗口即时生效；窗口不存在（已释放）时由 createWindow
 *  在下次创建时按当前主题取色，故这里静默跳过即可。 */
const WINDOW_BG = { dark: "#0a0c0f", light: "#f4f6f9" };

function applyNativeTheme(theme) {
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
  const bg = WINDOW_BG[theme === "light" ? "light" : "dark"];
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(bg);
  } catch { /* 窗口正在销毁等竞态：下次 createWindow 会用当前主题取色 */ }
}

// ===== 全局大小自适应 =====
// 以 1280 为设计基准宽，整页等比缩放（钳制 0.7~1.25）：窗口更小整体缩小、更大适度放大。
// zoomFactor 缩放的是 CSS 像素（含媒体查询），常态下有效布局宽度恒为 1280，
// 布局本身只在大窗口侧自然拉伸；浏览器预览（dev:web）不走此逻辑，由 CSS 断点兜底
const DESIGN_WIDTH = 1280;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.25;

// ===== 轻量模式：窗口几何的读写 =====
// 销毁窗口会丢掉窗口摆放，重建时若不还原，用户每次点托盘「显示主界面」都会
// 得到一个居中大窗 —— 所以位置/尺寸/最大化必须落盘（见 backend/window-state.cjs）。
// 越界收敛交给 clampBounds：显示器被拔掉后旧坐标会落在不存在的屏上（窗口"打开但看不见"）。

/** 读取上次的窗口几何，并收敛到当前实际存在的屏幕上 */
function restoreWindowBounds() {
  const saved = windowState.load(config.dataDir());
  const clamped = windowState.clampBounds(saved.bounds, safeDisplays(), { width: 1280, height: 820 });
  return { clamped, maximized: saved.maximized === true };
}

/** screen.getAllDisplays() 的容错包装：拿不到就当没有屏幕信息（clampBounds 会退回默认尺寸） */
function safeDisplays() {
  try {
    return require("electron").screen.getAllDisplays();
  } catch {
    return [];
  }
}

/** 落盘当前窗口几何：仅在有窗口且未最小化时记录（最小化时 getBounds 会给出异常值） */
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    // Windows 最小化时 getBounds 给 -32000 系异常值，写进盘会把用户原位置顶掉；
    // getNormalBounds 对最大化/最小化都返回「恢复为普通窗口时」的 bounds，两种非常态都兜住
    const bounds = maximized || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    windowState.save(config.dataDir(), windowState.pickState({ bounds, maximized }));
  } catch {
    /* 记不住位置不该影响任何主流程 */
  }
}

/** 几何变化的落盘节流：拖动窗口时 resize/move 会高频触发，别每次都写盘 */
let boundsSaveTimer = null;
function schedulePersistBounds() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    persistWindowBounds();
  }, 400);
}

function applyViewportZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w] = mainWindow.getSize();
  const factor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w / DESIGN_WIDTH));
  try {
    mainWindow.webContents.setZoomFactor(factor);
  } catch {
    /* 页面未就绪时调用可能失败，下个 resize / 加载事件会重试 */
  }
}

function createWindow() {
  const { clamped, maximized } = restoreWindowBounds();
  mainWindow = new BrowserWindow({
    width: clamped.width,
    height: clamped.height,
    // x/y 可能为 undefined（无历史状态/无可用屏幕）→ 交给 Electron 居中
    x: clamped.x,
    y: clamped.y,
    minWidth: 920,
    minHeight: 640,
    title: "AgentHub",
    icon: iconPath("icon.png"),
    autoHideMenuBar: true,
    // 窗口画布底色随当前主题：写死深色时，浅色主题下窗口重建会先铺黑底再被首帧覆盖 → 闪黑 ✗
    // （轻量模式会销毁窗口，唤回即重建，故这里必须按主题取色）
    // 取值与 src/styles/global.css 的 --bg 对齐：dark #0a0c0f / light #f4f6f9。
    backgroundColor: WINDOW_BG[config.loadConfig().theme === "light" ? "light" : "dark"],
    // 先隐藏，等页面渲染出首帧再显示：窗口出现时内容已就绪，避免空壳闪烁
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_URL);
  }

  // 首帧就绪后显示窗口（did-finish-load 兜底：HMR 重载等场景 ready-to-show 可能不触发）
  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", reveal);
  mainWindow.webContents.once("did-finish-load", reveal);

  // 最大化状态要在窗口存在后设置；恢复越界过就记一笔，便于排查「窗口位置自己变了」
  if (maximized) {
    try { mainWindow.maximize(); } catch { /* 某些平台/时序下可能失败，不拦启动 */ }
  }
  if (clamped.adjusted && clamped.reason !== "no-position") {
    __crashLog("window-bounds-adjusted", `${clamped.reason} → ${clamped.width}x${clamped.height}+${clamped.x},${clamped.y}`);
  }

  // 窗口尺寸变化 / 页面（重）载入后按当前宽度重算缩放
  applyViewportZoom();
  mainWindow.on("resize", () => { applyViewportZoom(); schedulePersistBounds(); });
  mainWindow.webContents.on("did-finish-load", applyViewportZoom);
  // 拖动/最大化切换都要记账（move 只在非最大化时有意义，maximize/unmaximize 各记一次）
  mainWindow.on("move", schedulePersistBounds);
  mainWindow.on("maximize", schedulePersistBounds);
  mainWindow.on("unmaximize", schedulePersistBounds);

  // 关闭 → 按三态决策：真退出 / 缩到托盘（保留渲染进程）/ 轻量模式（销毁窗口释放渲染进程）
  mainWindow.on("close", (e) => {
    const cfg = config.loadConfig();
    const action = windowMode.decideCloseAction({
      quitting,
      minimizeToTray: !!(cfg.schedule && cfg.schedule.minimizeToTray),
      lightweightMode: !!(cfg.schedule && cfg.schedule.lightweightMode),
    });
    if (action === "quit") return; // 放行：走正常退出流程
    e.preventDefault();
    // 无论藏还是销毁，都先把窗口位置记下来（销毁后再也读不到）
    persistWindowBounds();
    if (windowMode.releasesRenderer(action)) {
      // 轻量模式：销毁窗口 → 渲染进程整只消失（实测省 ~298 MB）。
      // 主进程/托盘/反代网关都不受影响（它们本就不依赖窗口）。
      // 用 setImmediate 延到本次 close 事件派发结束之后再 destroy：
      // 在 close 回调里同步销毁自己属于重入，交给下一轮事件循环更稳。
      // （destroy() 不会再触发 close，故不会二次进入本分支）
      __crashLog("lightweight-enter", `渲染进程释放（mode=${cfg.schedule.lightweightMode ? "lightweight" : "no-tray"}）`);
      const w = mainWindow;
      mainWindow = null;
      setImmediate(() => {
        try { w.destroy(); } catch { /* 已销毁 */ }
      });
      refreshTrayMenu();
    } else {
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    // 从托盘唤回时窗口可能是隐藏态（hide 模式），先显示再聚焦
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
}

// ===== 全局快捷键：唤起 / 释放界面 =====
// 全局生效（应用在后台/托盘时也能唤起）。按下时是「开关」语义：
//   窗口可见   → 隐藏（hide）
//   窗口不可见 → 显示并聚焦（没有窗口时重建）
//
// 收起动作按「轻量模式」开关分派（见 collapseMainWindow）：开启走释放，关闭仅 hide。
let shortcutRegistrar = null;

/** 按当前配置注册快捷键；配置变更后由 ipc 的 onConfigSaved 钩子再次调用 */
function setupShortcut() {
  const cfg = config.loadConfig();
  const acc = (cfg.schedule && cfg.schedule.shortcutToggle) || "";

  if (!shortcutRegistrar) {
    shortcutRegistrar = shortcut.createRegistrar({
      globalShortcut,
      onTrigger: onShortcutToggle,
      notify: (title, body) => notify(title, body),
      log: (kind, detail) => __crashLog(kind, detail),
    });
  }
  const st = shortcutRegistrar.set(acc);
  if (st.error) __crashLog("shortcut-invalid", String(st.error));
  return st;
}

/** 收起主界面：按「轻量模式」开关决定是隐藏还是释放渲染进程。
 *  恒为 hide → 用户开了轻量模式却省不到内存；恒为 destroy → 没开轻量也每次唤回闪黑重建。 */
function collapseMainWindow(reason) {
  const cfg = config.loadConfig();
  const lightOn = !!(cfg.schedule && cfg.schedule.lightweightMode);
  if (lightOn) {
    releaseWindowNow(reason);
    return;
  }
  try { mainWindow.hide(); } catch { /* 已销毁：下次唤回会重建 */ }
  refreshTrayMenu();
}

/** 快捷键按下：可见则收起界面，不可见则唤回 */
function onShortcutToggle() {
  try {
    const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    if (visible) {
      collapseMainWindow("shortcut");
    } else {
      showWindow();
    }
  } catch (e) {
    __crashLog("shortcut-toggle-failed", String((e && e.message) || e));
  }
}

// ===== 托盘 =====

/** 托盘菜单（动态构建） */
function buildTrayMenu() {
  const items = [];
  // 轻量模式：关窗缩到托盘的用户，托盘是唯一入口，所以开关必须放这里
  // （设置 · 通用里也有同一个开关，两处写的是同一份配置）
  const lightOn = !!(cfg.schedule && cfg.schedule.lightweightMode);
  const trayOn = !!(cfg.schedule && cfg.schedule.minimizeToTray);
  const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
  items.push(
    { label: "显示主界面", click: showWindow },
    {
      // 未开托盘常驻时该开关无意义（关窗本来就释放界面）→ 置灰并说明，而不是点了没反应
      label: lightOn ? "轻量模式：已开启（关窗释放界面）" : "轻量模式：关窗释放界面",
      type: "checkbox",
      checked: lightOn,
      enabled: trayOn,
      click: () => { toggleLightweightMode(!lightOn); },
    },
    {
      // 手动立即释放：不必真的去关窗（窗口当前可见时也能用）
      label: hasWindow ? "立即释放界面内存" : "界面已释放（点上方可唤回）",
      enabled: hasWindow,
      click: () => { releaseWindowNow("tray-manual"); },
    },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (tray) {
    try {
      const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
      tray.setToolTip(hasWindow ? "AgentHub · Agent中控台" : "AgentHub · 界面已释放（点此唤回）");
    } catch { /* 托盘不可用时忽略 */ }
  }
}

/** 立即销毁窗口释放渲染进程（托盘「立即释放界面内存」与自动触发共用）。
 *  与关窗路径的区别：不经过 close 事件，供「窗口还开着也想省内存」的场景使用。 */
function releaseWindowNow(reason) {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return false;
  persistWindowBounds();
  __crashLog("lightweight-enter", `渲染进程释放（reason=${reason}）`);
  const w = mainWindow;
  mainWindow = null;
  setImmediate(() => {
    try { w.destroy(); } catch { /* 已销毁 */ }
  });
  refreshTrayMenu();
  return true;
}

/** 托盘里切换轻量模式：写同一份配置（与设置 · 通用页共用），即时生效 */
function toggleLightweightMode(next) {
  try {
    const cfg = config.loadConfig();
    cfg.schedule = cfg.schedule || {};
    cfg.schedule.lightweightMode = !!next;
    config.saveConfig(cfg);
    // 托盘直写不经 save_config：ipc 的内存快照与渲染层快照都不会自己更新。
    // 只作废后端缓存还不够，渲染层旧快照在下次设置页整份保存时会把这里的改动冲掉
    // （saveConfigFromUI 不保护 schedule 字段），故广播一次让渲染层重拉。
    ipc.refreshConfigCache();
    try {
      const w = mainWindow;
      if (w && !w.isDestroyed()) w.webContents.send("app:event", { event: "config-changed" });
    } catch { /* 渲染层不在（界面已释放）时忽略：下次唤回 load() 会读到新值 */ }
    __crashLog("lightweight-toggle", `lightweightMode=${cfg.schedule.lightweightMode}（来自托盘）`);
  } catch (e) {
    __crashLog("lightweight-toggle-failed", String((e && e.message) || e));
    notify("AgentHub", "轻量模式开关写入失败，请到「设置 · 通用」重试");
  }
  refreshTrayMenu();
}

function createTray() {
  const icon = iconPath("tray.png");
  tray = new Tray(icon.isEmpty() ? iconPath("icon.png") : icon);
  tray.setToolTip("AgentHub · Agent中控台");
  refreshTrayMenu();
  tray.on("double-click", showWindow);
}

// ===== 桌面通知 =====

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath("icon.png") });
  n.show();
}

// ===== 单实例锁 =====
// 开发旁路：AGENTHUB_ALLOW_MULTI=1 时跳过单实例锁，并隔离 userData，
// 使 `npm run dev` 能在安装版 AgentHub 仍在运行时并存（否则新实例拿不到锁会干净退出，
// concurrently -k 随即把 vite 一起关掉——表现为"npm run dev 一闪而过"）。
// 仅用于本地开发调试，生产不设该变量，行为与原来完全一致。
const ALLOW_MULTI = process.env.AGENTHUB_ALLOW_MULTI === "1";
if (ALLOW_MULTI) {
  // userData 隔离：避免与安装版争抢同一个库/日志/缓存
  app.setPath("userData", path.join(app.getPath("appData"), "AgentHub-dev"));
}
const gotLock = ALLOW_MULTI ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  __crashLog("single-instance-lock-lost", "已有实例持有单实例锁，本次启动即退出（第二次启动的正常行为，不是崩溃）");
  app.quit();
} else {
  if (!ALLOW_MULTI) app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    // 建窗前先应用主题，避免深色配置下标题栏先白后黑闪烁
    const bootCfg = config.loadConfig();
    // 同步配置留痕：崩溃日志里一眼能看出崩时有没有配 WebDAV、
    // 各模块是否在跑远端同步；只记有无，不落任何账号密码。
    try {
      // 与引擎 configured() 同口径：pool 要求账号密码。
      const hasAuth = (w) => !!(w && w.endpoint && w.username && w.password);
      __crashLog(
        "sync-config",
        `pool=${hasAuth(config.moduleWebdav("proxy")) ? "yes" : "no"}`,
      );
    } catch (e) {
      __crashLog("sync-config-failed", __describe(e));
    }
    applyNativeTheme(bootCfg.theme);

    ipc.register({ ipcMain, app, shell, nativeTheme });
    // 反代网关：规则热加载 + 额度定时刷新 + 按配置自启网关服务（服务独立于窗口存续）
    // boot() 是 async：rules.init() / store.open() / credits.startScheduler() / startCheckinAuto()
    // 都是裸调用，抛错会变成 rejected promise。原先这里没有任何 catch，
    // 未处理的 rejection 会让主进程直接退出——症状是「窗口凭空消失、无崩溃事件、无 dump、无日志」。
    proxy.boot().catch((e) => __crashLog("proxy-boot-failed", __describe(e)));
    createWindow();
    createTray();
    // 全局快捷键（默认 Alt+`，两键）：冲突则弹气泡并持续重试，解除后自动恢复。
    // 设置页改键后经 ipc.onConfigSaved 钩子重新注册，无需重启。
    ipc.onConfigSaved(() => {
      try { setupShortcut(); } catch (e) { __crashLog("shortcut-reload-failed", __describe(e)); }
    });
    try { setupShortcut(); } catch (e) { __crashLog("shortcut-setup-failed", __describe(e)); }

    // 依据配置启用开机自启（便携版不支持：注册的会是临时解压副本路径，退出即失效）。
    // 开关唯一来源是框架配置（设置 · 通用 · 应用行为），用量模块旧配置字段不再参与
    config.applyAutoStart(config.loadConfig());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  }).catch((e) => {
    // 初始化链（建库 / 注册 IPC / 建窗建托盘 / 起各调度器）任何一步抛错都记下来；
    // 原先这里没有 catch，抛错 = unhandledRejection = 主进程静默退出
    __crashLog("whenReady-failed", __describe(e));
    // 没有窗口时继续活着就是「无窗口僵尸」；明确告知原因并退出。已有窗口则弹窗提示后保留。
    try {
      require("electron").dialog.showErrorBox("AgentHub 启动异常", `初始化失败：${(e && e.message) || e}\n日志：${crashLogFile()}`);
    } catch { /* 无 GUI */ }
    if (!mainWindow) app.exit(1);
  });

  app.on("before-quit", () => {
    // 统一收尾：原先两条分支各自重复一遍 stop 调用，新增模块时极易漏改一处
    const cleanup = () => {
      // 全局快捷键必须显式注销：不注销会让旧键在重启窗口期内处于悬空占用状态
      try { if (shortcutRegistrar) shortcutRegistrar.stop(); else shortcut.unregisterAll(globalShortcut); } catch { /* 忽略 */ }
      proxy.shutdown();
    };
    quitting = true;
    cleanup();
  });

  app.on("window-all-closed", () => {
    // Windows 下常驻托盘，不随窗口关闭退出（定时同步要后台跑）
  });
}
