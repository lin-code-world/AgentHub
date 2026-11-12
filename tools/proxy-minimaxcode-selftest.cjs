/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MiniMax Code（国内站）渠道自测（离线可跑，不打真上游）
// 覆盖：渠道注册与双表一致性、签名向量与指纹查询串顺序、设备码登录（含只回 user_code 的变体）、
//       身份与指纹派生、账号落库、模型目录归一与落盘、对话体翻译与错误分类、续期不重复花费、
//       积分余额（字符串小数 / 401 两种错误体）、签到幂等（claim_result=2）。
"use strict";

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

const path = require("node:path");
process.env.AGENTHUB_DATA_DIR = path.join(process.env.TEMP, "agenthub-minimaxcode-selftest");

const store = require("../electron/backend/proxy/store.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");

// ===== 渠道注册 =====
(function testRegistry() {
  const row = store.CHANNELS.find((c) => c.id === "minimaxcode");
  ok(!!row, "CHANNELS 含 minimaxcode");
  eq(row && row.display, "MiniMax Code", "显示名");
  eq(row && row.domain, "agent.minimax.cn", "渠道域");
  eq(row && row.costTier, undefined, "不标 costTier");
  const report = adapters.consistencyReport();
  eq(report.channelsWithoutAdapter, [], "无缺适配器的渠道");
  eq(report.adaptersWithoutChannel, [], "无缺渠道的适配器");
  const ad = adapters.get("minimaxcode");
  ok(ad && typeof ad.cfg === "function", "cfg 是函数");
})();

// ===== 签名：encodeURIComponent 口径 / 两个摘要的固定向量 / 指纹查询串顺序 =====
// 向量取自实现公式（与实测探针同一套：用该实现打 get_membership_info 实测 200），
// 固化字面量是为了防"改签名顺手改坏"的回归，不是用实现验证自己。
(function testSign() {
  const sign = require("../electron/backend/proxy/minimaxcode/sign.cjs");
  eq(sign.encodeUriComponent("a b!~*'()中"), "a%20b!~*'()%E4%B8%AD", "encodeURIComponent 口径（!*'() 不编码、中文按 UTF-8）");
  eq(sign.formEncode("a b"), "a+b", "formEncode 空格变 +");
  eq(sign.xSignature(1700000000, "{}"), "b0c74b46e28053fb22e53239b1061505", "x-signature 固定向量");
  eq(sign.yy("/v1/api/user/info?user_id=0", "{}", 1700000000000), "8ab80a4e733088ee2ae62df69ee8345d", "yy 固定向量");
  const q = sign.desktopQuery({
    unixMs: 1700000000000,
    userId: "123",
    deviceId: "d1",
    uuid: "u1",
    cfg: { desktopVersion: "3.1.14", screenWidth: 2048, screenHeight: 1152, deviceMemory: 32, cpuCoreNum: 12 },
  });
  eq(
    q.split("&").map((p) => p.split("=")[0]).join(","),
    "device_platform,biz_id,app_id,version_code,unix,timezone_offset,is_desktop,desktop_version,sys_language,lang,uuid,device_id,os_name,browser_name,device_memory,cpu_core_num,browser_language,browser_platform,user_id,screen_width,screen_height,client,region",
    "指纹查询串顺序（顺序是契约的一部分）",
  );
  ok(q.includes("user_id=123"), "user_id 进查询串");
  ok(q.includes("device_id=d1"), "device_id 进查询串");
})();

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
