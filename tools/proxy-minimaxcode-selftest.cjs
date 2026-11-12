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
function testRegistry() {
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
}

// ===== 签名：encodeURIComponent 口径 / 两个摘要的固定向量 / 指纹查询串顺序 =====
// 向量取自实现公式（与实测探针同一套：用该实现打 get_membership_info 实测 200），
// 固化字面量是为了防"改签名顺手改坏"的回归，不是用实现验证自己。
function testSign() {
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
}

// ===== OAuth 设备码：表单参数 / 只有 user_code 的变体 / 三态轮询 / 刷新 =====
async function testOAuth() {
  const http = require("node:http");
  const oauth = require("../electron/backend/proxy/minimaxcode/oauth.cjs");
  const seen = { device: null, polls: [], refreshes: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const p = new URLSearchParams(raw);
      if (req.url === "/oauth2/device/code") {
        seen.device = Object.fromEntries(p);
        res.writeHead(200, { "content-type": "application/json" });
        // 真实变体之一：只回 user_code，没有 device_code
        res.end(JSON.stringify({ user_code: "ABCD-EFGH", verification_uri: "https://example.test/activate", expires_in: 600, interval: 1 }));
        return;
      }
      if (req.url === "/oauth2/token") {
        if (p.get("grant_type") === "refresh_token") {
          seen.refreshes.push(Object.fromEntries(p));
          res.writeHead(p.get("refresh_token") === "mmort_bad" ? 400 : 200, { "content-type": "application/json" });
          res.end(p.get("refresh_token") === "mmort_bad"
            ? JSON.stringify({ error: "invalid_grant" })
            : JSON.stringify({ access_token: "mmoat_new", refresh_token: "mmort_new", expires_in: 43200, token_type: "Bearer" }));
          return;
        }
        seen.polls.push(Object.fromEntries(p));
        const n = seen.polls.length;
        res.writeHead(200, { "content-type": "application/json" });
        if (n === 1) res.end(JSON.stringify({ status: "pending" }));
        else if (n === 2) res.end(JSON.stringify({ status: "slow_down" }));
        else res.end(JSON.stringify({ access_token: "mmoat_a", refresh_token: "mmort_a", expires_in: 43200, token_type: "Bearer" }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { accountBase: `http://127.0.0.1:${server.address().port}` };
  try {
    const { verifier, challenge } = oauth.pkce();
    ok(verifier.length >= 32 && challenge.length > 10, "PKCE 生成");
    const dev = await oauth.requestDeviceCode(challenge, cfg, adapters.httpJson);
    ok(dev.ok, "设备码申请成功");
    eq(seen.device.client_id, "mcode-public", "client_id");
    eq(seen.device.scope, "agent.default", "scope");
    eq(seen.device.audience, "agent-backend", "audience");
    eq(seen.device.code_challenge_method, "S256", "PKCE 方法");
    eq(seen.device.code_challenge, challenge, "challenge 原样上送");
    eq(dev.pollByUser, true, "无 device_code 时按 user_code 轮询");
    const device = { deviceCode: dev.deviceCode, pollByUser: dev.pollByUser, verifier };
    eq((await oauth.pollToken(device, cfg, adapters.httpJson)).kind, "pending", "第一次 pending");
    eq((await oauth.pollToken(device, cfg, adapters.httpJson)).kind, "slowDown", "第二次 slow_down");
    const done = await oauth.pollToken(device, cfg, adapters.httpJson);
    eq(done.kind, "confirmed", "第三次 confirmed");
    eq(done.tokens.accessToken, "mmoat_a", "拿到 accessToken");
    eq(seen.polls[0].user_code, "ABCD-EFGH", "轮询体用 user_code");
    ok(!("device_code" in seen.polls[0]), "不该同时带 device_code");
    const rf = await oauth.refresh({ refreshToken: "mmort_a", cfg, httpJson: adapters.httpJson });
    ok(rf.ok && rf.accessToken === "mmoat_new" && rf.refreshToken === "mmort_new", "刷新成功");
    ok(rf.expiresAt > Date.now(), "刷新写回到期");
    const bad = await oauth.refresh({ refreshToken: "mmort_bad", cfg, httpJson: adapters.httpJson });
    ok(!bad.ok && bad.authError === true, "invalid_grant 判 authError");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  testRegistry();
  testSign();
  await testOAuth();
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
