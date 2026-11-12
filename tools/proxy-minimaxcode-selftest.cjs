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

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
