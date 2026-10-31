/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-31
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 一次性拉取 ZCode 官方内置模型能力配置并落盘到仓库 assets 目录。
// 为什么要有它：模型能力（schemaVersion / revision / modelRules）由官方客户端版本决定，
// 官方发版后这条配置会更新。跑本脚本即可把最新 revision 拖进仓库，后续 build 自动带进安装包。
// 为什么是一次性脚本而不是集成到运行时：目标机器不装官方客户端、又希望开箱即用，
// 所以这份数据跟代码一起走就够了——运行时联网更新留给后续任务。
"use strict";

const fs = require("fs");
const path = require("path");
const zb = require("../electron/backend/proxy/zcodeBuiltin.cjs");

const BUILTIN_PATH = path.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json");
const CLIENT_CONFIGS_BASE = "https://zcode.z.ai/api/v1/client/configs";
const APP_VERSION = "4.1.10";
const PLATFORM = "win32-x64";
const TIMEOUT_MS = 20000;

async function fetchJson(url) {
  // Node 18+ 内置 fetch，走系统 node 即可。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { redirect: "error", signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`请求超时（${TIMEOUT_MS}ms）：${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`请求失败 HTTP ${res.status} ${res.statusText}：${url}`);
  }
  return res.json();
}

async function main() {
  // 1. 拉 client configs 入口（无鉴权头）
  const entryUrl = zb.buildClientConfigsUrl(CLIENT_CONFIGS_BASE, APP_VERSION, PLATFORM);
  console.log(`→ 拉取 client configs 入口：${entryUrl}`);
  const entry = await fetchJson(entryUrl);
  if (!entry || entry.code !== 0) {
    throw new Error(`入口响应 code 非 0：code=${entry && entry.code} msg=${entry && entry.msg}`);
  }
  const cdnUrl = ((entry.data || {}).configs || {}).builtin_provider_config_json;
  if (!cdnUrl || typeof cdnUrl !== "string") {
    throw new Error(`入口响应缺少 builtin_provider_config_json 字段`);
  }

  // 2. 拉 CDN 上的内置配置
  console.log(`→ 拉取 CDN 配置：${cdnUrl}`);
  const builtin = await fetchJson(cdnUrl);

  // 3. validateRelease 通过后落盘
  const result = zb.validateRelease(builtin);
  if (!result.ok) {
    throw new Error(`validateRelease 失败：${result.reason}`);
  }

  // 确保 assets 目录存在
  const dir = path.dirname(BUILTIN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 紧凑 JSON（不缩进），避免无谓体积；上游下发本身就是紧凑，保持一致
  const raw = JSON.stringify(builtin);
  fs.writeFileSync(BUILTIN_PATH, raw, "utf8");
  const stat = fs.statSync(BUILTIN_PATH);
  console.log(`已写入 revision=${result.release.revision}（${stat.size} 字节）→ ${BUILTIN_PATH}`);
}

main().catch((err) => {
  console.error(`拉取失败：${err.message}`);
  process.exit(1);
});
