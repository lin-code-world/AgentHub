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
// 关窗决策自测：两态决策 + 窗口状态持久化/越界收敛
//
// 覆盖两个纯逻辑模块（不 require electron，故可在裸 node 下跑）：
//   electron/backend/window-mode.cjs   —— decideCloseAction / releasesRenderer
//   electron/backend/window-state.cjs  —— clampBounds / pickState / save+load 往返
//
// 这两个模块的价值恰恰在于「决策表容易写错、越界逻辑容易漏」，
// 所以本自测把真值表逐行钉死：改坏任何一格都会红。
//
// 用法：node tools/window-mode-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const mode = require(path.join(ROOT, "electron", "backend", "window-mode.cjs"));
const wstate = require(path.join(ROOT, "electron", "backend", "window-state.cjs"));

let pass = 0, fail = 0;
function T(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok    " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL  " + name + "\n        " + (e && e.message));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((label || "值") + " 期望 " + b + "，实际 " + a);
}

console.log("\n  关窗决策自测");

// ─────────────── 一、关窗决策真值表 ───────────────
console.log("\n  [1] decideCloseAction 真值表");

T("S1 quitting=true 一律放行真退出（托盘「退出」/更新重启）", () => {
  eq(mode.decideCloseAction({ quitting: true, minimizeToTray: true }), "quit");
  eq(mode.decideCloseAction({ quitting: true, minimizeToTray: false }), "quit");
});

T("S2 未开托盘常驻 → quit（关窗即退出应用）", () => {
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: false }), "quit");
});

T("S3 托盘常驻 → destroy（销毁界面进程，托盘与后台服务照常运行）", () => {
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: true }), "destroy");
});

T("S4 缺字段/畸形输入不炸，且按最保守语义回落（非 true 即退出）", () => {
  eq(mode.decideCloseAction({}), "quit");
  eq(mode.decideCloseAction(), "quit");
  eq(mode.decideCloseAction(null), "quit");
  // 只有字符串 "true" 不算 true（配置来自 JSON，必须严格判等）
  eq(mode.decideCloseAction({ minimizeToTray: "true" }), "quit");
});

T("S5 releasesRenderer 只对 destroy 为真", () => {
  eq(mode.releasesRenderer("destroy"), true);
  eq(mode.releasesRenderer("quit"), false);
  eq(mode.releasesRenderer("hide"), false);
});

T("S5b 开发运行（未打包）关窗一律 quit：改代码后不该被托盘留着跑旧进程", () => {
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: true, packaged: false }), "quit");
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: false, packaged: false }), "quit");
});

T("S5c 打包产物仍按最小化设置：开托盘常驻 → destroy，关 → quit", () => {
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: true, packaged: true }), "destroy");
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: false, packaged: true }), "quit");
});

T("S5d packaged 缺省按打包产物处理（保守：不改变现有安装版的关窗行为）", () => {
  eq(mode.decideCloseAction({ quitting: false, minimizeToTray: true }), "destroy");
});

T("S6 ACTIONS 常量与决策返回值闭合（防新增动作忘了登记）", () => {
  const all = [];
  for (const q of [true, false]) for (const m of [true, false]) {
    all.push(mode.decideCloseAction({ quitting: q, minimizeToTray: m }));
  }
  for (const a of all) if (!mode.ACTIONS.includes(a)) throw new Error("决策返回了未登记的动作：" + a);
  // hide 已随轻量模式移除：确认常量表里没有它，避免 main.cjs 与自测对不上
  if (mode.ACTIONS.includes("hide")) throw new Error("ACTIONS 仍含已移除的 hide 动作");
});

// ─────────────── 二、窗口状态持久化 ───────────────
console.log("\n  [2] window-state 往返与清洗");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-wstate-"));

T("S9 save/load 往返：尺寸+位置+最大化原样回来", () => {
  const st = { bounds: { x: 100, y: 60, width: 1500, height: 900 }, maximized: true };
  if (!wstate.save(TMP, st)) throw new Error("save 应返回 true");
  eq(wstate.load(TMP), st);
});

T("S10 状态文件损坏/不存在 → 返回空对象，绝不抛错（否则启动即崩）", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ah-wstate-bad-"));
  eq(wstate.load(d), {});                                   // 不存在
  fs.writeFileSync(wstate.statePath(d), "{ 这不是 JSON", "utf8");
  eq(wstate.load(d), {});                                   // 截断的 JSON
  fs.writeFileSync(wstate.statePath(d), "[1,2,3]", "utf8");
  eq(wstate.load(d), {});                                   // 是数组不是对象
  fs.writeFileSync(wstate.statePath(d), "null", "utf8");
  eq(wstate.load(d), {});
});

T("S11 pickState 只收白名单字段，挡住外部塞进来的任意键", () => {
  const got = wstate.pickState({
    bounds: { x: 10, y: 20, width: 1200.6, height: 800.2, extra: "丢弃" },
    maximized: true,
    evil: { rm: "-rf" },
  });
  eq(got, { bounds: { width: 1201, height: 800, x: 10, y: 20 }, maximized: true });
});

T("S12 pickState 遇到畸形 bounds 时逐项丢弃（不写半个坏状态进盘）", () => {
  eq(wstate.pickState({ bounds: { width: "宽", height: null } }), {});
  eq(wstate.pickState({ bounds: null }), {});
  eq(wstate.pickState({ maximized: "true" }), {});                   // 字符串不算
  eq(wstate.pickState({ bounds: { width: 1280, height: 820 } }), { bounds: { width: 1280, height: 820 } }); // 无 x/y 合法
});

// ─────────────── 三、越界收敛（显示器拔掉/换分辨率） ───────────────
console.log("\n  [3] clampBounds 越界收敛");

const D1 = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const D2 = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },   // 第二块屏
];

T("S13 正常坐标原样保留，不误调整", () => {
  const r = wstate.clampBounds({ x: 100, y: 50, width: 1280, height: 820 }, D1, { width: 1280, height: 820 });
  eq([r.x, r.y, r.width, r.height, r.adjusted, r.reason], [100, 50, 1280, 820, false, "ok"]);
});

T("S14 落在第二块屏上 → 保留（不能把多屏用户拽回主屏）", () => {
  const r = wstate.clampBounds({ x: 2100, y: 100, width: 1280, height: 820 }, D2, { width: 1280, height: 820 });
  eq([r.x, r.y, r.adjusted, r.reason], [2100, 100, false, "ok"]);
});

T("S15 显示器被拔掉（坐标落在已不存在的屏）→ 拉回主屏且整窗可见", () => {
  const r = wstate.clampBounds({ x: 2100, y: 100, width: 1280, height: 820 }, D1, { width: 1280, height: 820 });
  eq(r.adjusted, true);
  eq(r.reason, "offscreen");
  // 整窗必须落在主屏工作区内
  if (r.x < 0 || r.y < 0 || r.x + r.width > 1920 || r.y + r.height > 1040) {
    throw new Error("拉回后仍越界：" + JSON.stringify(r));
  }
});

T("S16 负坐标（屏幕在左/上）→ 同样收敛回主屏", () => {
  const r = wstate.clampBounds({ x: -3000, y: -2000, width: 1280, height: 820 }, D1, { width: 1280, height: 820 });
  eq(r.adjusted, true);
  if (r.x < 0 || r.y < 0) throw new Error("负坐标未收敛：" + JSON.stringify(r));
});

T("S17 窗口比屏幕还大 → 夹到屏幕尺寸，且如实标记已调整", () => {
  const r = wstate.clampBounds({ x: 0, y: 0, width: 5000, height: 4000 }, D1, { width: 1280, height: 820 });
  eq([r.width, r.height], [1920, 1040]);
  eq([r.adjusted, r.reason], [true, "size-clamped"]);
});

T("S17b 尺寸被夹但位置本来合法 → 仍如实标记已调整（不得谎报 ok）", () => {
  const r = wstate.clampBounds({ x: 100, y: 50, width: 5000, height: 820 }, D1, { width: 1280, height: 820 });
  eq([r.width, r.adjusted, r.reason], [1920, true, "size-clamped"]);
});

T("S18 尺寸小于窗口下限 → 抬到 minWidth/minHeight（与 BrowserWindow 约束一致）", () => {
  const r = wstate.clampBounds({ x: 10, y: 10, width: 200, height: 100 }, D1, { width: 1280, height: 820 });
  eq([r.width, r.height], [wstate.MIN_W, wstate.MIN_H]);
});

T("S19 无 x/y → 交给 Electron 居中（返回不带坐标）", () => {
  const r = wstate.clampBounds({ width: 1280, height: 820 }, D1, { width: 1280, height: 820 });
  eq(r.x, undefined);
  eq(r.reason, "no-position");
});

T("S20 完全没有屏幕信息（displays 为空/畸形）→ 退回默认尺寸，不抛错", () => {
  for (const bad of [[], null, undefined, [{ workArea: null }], [{ workArea: { width: 0, height: 0 } }]]) {
    const r = wstate.clampBounds({ x: 10, y: 10, width: 1280, height: 820 }, bad, { width: 1280, height: 820 });
    eq([r.width, r.height, r.reason], [1280, 820, "no-display"]);
  }
});

T("S21 畸形输入（NaN/字符串/缺省）一律不抛错，且结果始终是合法矩形", () => {
  const cases = [
    {}, null, undefined,
    { x: NaN, y: NaN, width: NaN, height: NaN },
    { x: "10", y: "20", width: "1280", height: "820" },
    { x: Infinity, y: -Infinity, width: 1280, height: 820 },
  ];
  for (const c of cases) {
    const r = wstate.clampBounds(c, D1, { width: 1280, height: 820 });
    for (const k of ["width", "height"]) {
      if (!Number.isFinite(r[k]) || r[k] < 1) throw new Error("非法尺寸 " + k + "=" + r[k] + " (输入 " + JSON.stringify(c) + ")");
    }
    if (r.x !== undefined && !Number.isFinite(r.x)) throw new Error("非法 x");
    if (r.y !== undefined && !Number.isFinite(r.y)) throw new Error("非法 y");
  }
});

fs.rmSync(TMP, { recursive: true, force: true });

// ─────────────── 三、main.cjs 接线守卫（源码级）───────────────
// 为什么需要：关窗会**销毁窗口**，用户下次唤回必然走 createWindow() 重建。
// 若窗口画布底色写死深色，浅色主题下重建就会先铺黑底再被首帧覆盖 → **闪黑** ✗。
// 决策逻辑再对，接线被改回去也白修，故把这一点钉死。
console.log("\n  [3] main.cjs 接线守卫");
const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");

T("S22 窗口画布底色随主题（不得写死深色，否则浅色主题重建时闪黑）", () => {
  if (!/const WINDOW_BG = \{\s*dark:/.test(mainSrc)) throw new Error("缺少 WINDOW_BG 主题底色表 ✗");
  if (/backgroundColor:\s*"#0a0c0f"/.test(mainSrc)) throw new Error("createWindow 仍把 backgroundColor 写死为深色 ✗（浅色主题重建会闪黑）");
  if (!/setBackgroundColor\(/.test(mainSrc)) throw new Error("applyNativeTheme 未同步窗口底色 ✗（切换主题后重建仍会用旧底色）");
});

T("S23 WINDOW_BG 取值与前端 global.css 的 --bg 一致（防两处色值漂移）", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "styles", "global.css"), "utf8");
  for (const [theme, hex] of [["dark", "#0a0c0f"], ["light", "#f4f6f9"]]) {
    if (!new RegExp(theme + ":\\s*\"" + hex + "\"").test(mainSrc)) throw new Error(`WINDOW_BG.${theme} 期望 ${hex}，main.cjs 里没找到`);
    if (!css.includes("--bg: " + hex)) throw new Error(`global.css 里 --bg 不含 ${hex}（${theme}）→ 两处色值漂移了`);
  }
});

T("S24 关窗即退出时显式 app.quit()（window-all-closed 是空实现，只放行 close 会留下无窗口主进程）", () => {
  if (!/if \(action === "quit"\)[\s\S]{0,320}app\.quit\(\)/.test(mainSrc)) {
    throw new Error("close 分支的 quit 路径没有显式 app.quit()：minimizeToTray 关闭时关窗会留下无窗口僵尸");
  }
});

console.log("\n  关窗决策自测: 通过 " + pass + "  失败 " + fail);
process.exit(fail ? 1 : 0);
