/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 网页控制台的状态与空态自测：纯静态断言 + 纯函数，不启动任何服务。
// 来源：原 tools/container-web-selftest.cjs 里与容器形态无关的覆盖，容器自测删除后迁到这里：
//   I4    main.ts 启动接线：浏览器形态启动即清旧明文令牌，登录判定看会话
//   I5    号池页事件接线：只认 {type:"pool"}，2 秒节流，resync 也触发全量
//   I6-b  空态三态纯函数 loadPhaseOf：loading / empty / failed / ready
//   I6-c  三页（号池 / 日志 / 统计）接线：消费 loadPhaseOf 并给出「重试」
// 用法：node tools/web-ui-state-selftest.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");

let pass = 0,
  fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// TS 源文件直载（esbuild 编译成 CJS 后经 require.extensions 挂载），测真实现而不是副本
function installTsLoader() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  Module._extensions[".ts"] = (mod, file) => {
    const src = fs.readFileSync(file, "utf8");
    const out = esbuild.transformSync(src, { loader: "ts", format: "cjs", sourcefile: file }).code;
    mod._compile(out, file);
  };
}

installTsLoader();
const { loadPhaseOf } = require(path.join(ROOT, "src", "views", "proxy", "loadState.ts"));

const agentsSrc = read("src/views/proxy/ProxyAgentsView.vue");
const logSrc = read("src/views/proxy/ProxyLogView.vue");
const statsSrc = read("src/views/proxy/ProxyStatsView.vue");
const mainSrc = read("src/main.ts");

// ===== I4：浏览器启动路径的旧令牌清理接线 =====
console.log("=== I4 桌面浏览器形态清旧令牌 ===");
ok("main.ts 浏览器启动路径调用 clearLegacyToken", /clearLegacyToken\(\)/.test(mainSrc));
ok("main.ts 只在桌面浏览器形态清（容器 Bearer 仍需要该键）", /caps\s*&&\s*!isContainerWeb\(\)\s*\)\s*clearLegacyToken\(\)/.test(mainSrc));
ok("main.ts 登录判定按形态分流（容器看令牌 / 桌面看 ECDH 会话）", /isContainerWeb\(\)\s*\?\s*!!getToken\(\)\s*:\s*hasSession\(\)/.test(mainSrc));

// ===== I5：号池页只认 {type:"pool"} 并 2 秒节流 =====
console.log("=== I5 号池事件接线 ===");
ok("号池页为 pool 事件挂独立 2 秒节流刷新", /schedulePoolRefresh\s*=\s*coalesceAsync\(refresh,\s*2000\)/.test(agentsSrc), "未找到 2 秒节流器");
ok("pool 分支走该节流器（与 credits/status 的 1.2s 节流分开）", /p\.type === "pool"[\s\S]{0,220}schedulePoolRefresh\(\)/.test(agentsSrc), "pool 分支未接节流器");
ok("卸载时取消号池节流器", /schedulePoolRefresh\.cancel\(\)/.test(agentsSrc), "未取消定时器");
ok("断线重连补发的 resync 也触发一次号池全量", /p\.type === "resync"[\s\S]{0,220}schedulePoolRefresh\(\)/.test(agentsSrc), "resync 未接号池刷新");

// ===== I6-b：空态三态纯函数 =====
console.log("=== I6-b 空态三态判定 ===");
ok('首屏未返回 → "loading"', loadPhaseOf({ loading: true, error: "", count: 0 }) === "loading");
ok('无数据且无错 → "empty"', loadPhaseOf({ loading: false, error: "", count: 0 }) === "empty");
ok('有错 → "failed"（即便无数据）', loadPhaseOf({ loading: false, error: "HTTP 500", count: 0 }) === "failed");
ok('有数据 → "ready"', loadPhaseOf({ loading: false, error: "", count: 3 }) === "ready");
ok("加载中带旧错误仍显示 loading（不把首屏误报成失败）", loadPhaseOf({ loading: true, error: "旧错误", count: 0 }) === "loading");

// ===== I6-c：三页空态接线 =====
console.log("=== I6-c 三页空态接线 ===");
// 号池整页级：pool 为空时 v-for 里的失败态根本不渲染，失败原因与「重试」必须给在 v-for 之外
ok("号池页在 v-for 之外给整页级失败态（pool-empty-card）", /v-if="!pool\.length && poolPhase !== 'loading'" class="card pool-empty-card"[\s\S]{0,260}poolPhase === ['"]failed['"][\s\S]{0,200}@click="refresh"/.test(agentsSrc), "未找到 v-for 外的失败态卡片");
ok("切换条 !pool.length 分支是三态（加载中 / 加载失败 / 暂无渠道）", /v-if="!pool\.length" class="ch-strip-empty"[\s\S]{0,260}加载失败[\s\S]{0,120}暂无渠道/.test(agentsSrc), "切换条空态仍是恒显「加载中…」");
for (const [file, src] of [
  ["src/views/proxy/ProxyAgentsView.vue", agentsSrc],
  ["src/views/proxy/ProxyLogView.vue", logSrc],
  ["src/views/proxy/ProxyStatsView.vue", statsSrc],
]) {
  ok(`${file} 用 loadPhaseOf 区分空态与失败`, /loadPhaseOf\(/.test(src), "未找到 loadPhaseOf 接线");
  ok(`${file} 失败态带「重试」入口`, /加载失败[^]{0,120}重试/.test(src), "未找到失败态重试按钮");
}

console.log("");
console.log(`RESULT: ${pass} passed / ${fail} failed`);
if (bad.length) {
  console.log("失败项：");
  for (const b of bad) console.log("  - " + b);
}
process.exit(fail ? 1 : 0);
