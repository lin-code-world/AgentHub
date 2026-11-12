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

// ===== 身份与指纹：同账号稳定、不同账号不共享、user/info 解析与 401 =====
async function testIdentity() {
  const http = require("node:http");
  const identity = require("../electron/backend/proxy/minimaxcode/identity.cjs");
  const a = identity.deviceIdentity({ id: "acc-1", uid: "uid-1" });
  const a2 = identity.deviceIdentity({ id: "acc-1", uid: "uid-1" });
  const b = identity.deviceIdentity({ id: "acc-2", uid: "uid-2" });
  eq(a, a2, "同账号两次派生完全一致");
  ok(a.deviceId !== b.deviceId && a.uuid !== b.uuid, "不同账号不共享指纹");
  ok(/^\d{8}$/.test(a.deviceId), "deviceId 是 8 位数字（贴近官方形态）");
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.uuid), "uuid 是 v4 形态");
  eq(identity.deviceIdentity({ id: "x", uid: "u", meta: { deviceId: "12345678", uuid: "keep-me" } }), { deviceId: "12345678", uuid: "keep-me" }, "meta 已有时原样沿用");

  const seen = { url: "", headers: null };
  const server = http.createServer((req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    const bad401 = String(req.headers.authorization || "").includes("bad401");
    res.writeHead(bad401 ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(bad401 ? { error: "invalid access token" } : { data: { userInfo: { realUserID: "577097653167349763", name: "MiniMax380993" } } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    agentBase: `http://127.0.0.1:${server.address().port}`,
    userInfoPath: "/v1/api/user/info",
    desktopVersion: "3.1.14",
    screenWidth: 2048,
    screenHeight: 1152,
    deviceMemory: 32,
    cpuCoreNum: 12,
  };
  try {
    const r = await identity.fetchUserInfo({ token: "mmoat_x", cfg, deviceId: a.deviceId, uuid: a.uuid, httpJson: adapters.httpJson });
    ok(r.ok && r.realUserID === "577097653167349763" && r.name === "MiniMax380993", "user/info 解析 realUserID / name");
    ok(/user_id=0/.test(seen.url), "首次引导的签名 user_id 填 0");
    ok(/Bearer mmoat_x/.test(String(seen.headers && seen.headers.authorization)), "带 Bearer");

    const bad = await identity.fetchUserInfo({ token: "bad", cfg: { ...cfg, agentBase: "http://127.0.0.1:1" }, deviceId: "1", uuid: "u", httpJson: adapters.httpJson });
    ok(!bad.ok && bad.authError === false, "网络失败不误判 authError");

    const unauthorized = await identity.fetchUserInfo({ token: "bad401", cfg, deviceId: a.deviceId, uuid: a.uuid, httpJson: adapters.httpJson });
    ok(!unauthorized.ok && unauthorized.authError === true, "401 判 authError");
  } finally {
    await new Promise((r) => server.close(r));
  }

  const saved = {};
  const uid = await identity.ensureRealUserID({
    account: { id: "acc-1", uid: "uid-1", meta: { realUserID: "cached-uid" } },
    secrets: { token: "x" },
    cfg: {},
    httpJson: async () => ({ status: 500, ok: false, data: null, text: "" }),
    save: (patch) => Object.assign(saved, patch),
  });
  eq(uid, "cached-uid", "meta 命中不再请求上游");
  eq(saved, {}, "命中时不做无谓写回");
}

// ===== 登录：设备码形态、轮询入池、meta 完整、同 uid 不重复、本机导入被拒 =====
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const v = predicate();
      if (v) { clearInterval(timer); resolve(v); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("等待超时")); }
    }, 50);
  });
}

async function testLogin() {
  const fs = require("node:fs");
  const http = require("node:http");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");

  let pollCount = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const p = new URLSearchParams(raw);
      if (req.url === "/oauth2/device/code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ user_code: "ABCD-EFGH", verification_uri: "https://example.test/activate", expires_in: 600, interval: 1 }));
        return;
      }
      if (req.url === "/oauth2/token") {
        if (p.get("grant_type") === "refresh_token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "mmoat_r", refresh_token: "mmort_r", expires_in: 43200 }));
          return;
        }
        pollCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        if (pollCount === 1) res.end(JSON.stringify({ status: "pending" }));
        else res.end(JSON.stringify({ access_token: "mmoat_login", refresh_token: "mmort_login", expires_in: 43200, token_type: "Bearer" }));
        return;
      }
      if (String(req.url).startsWith("/v1/api/user/info")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { userInfo: { realUserID: "577097653167349763", name: "MiniMax380993" } } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rulesDir = rules.rulesDir();
    const hf = path.join(rulesDir, "headers.json");
    let all = {};
    try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
    all.minimaxcode = { ...(all.minimaxcode || {}), accountBase: base, agentBase: base };
    fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
    rules.reload("headers.json");

    let done = null;
    const started = await discovery.beginOAuth("minimaxcode", (r) => { done = r; });
    ok(started.ok && started.mode === "device" && started.userCode === "ABCD-EFGH", "begin 返回设备码形态");
    ok(started.url === "https://example.test/activate", "回传授权地址");
    await waitFor(() => done, 20000);
    ok(done && done.ok, "轮询到 confirmed 后 onDone ok");

    const accs = store.listAccounts("minimaxcode");
    eq(accs.length, 1, "入池一条账号");
    const acc = accs[0];
    const secrets = store.accountSecrets(store.accountRows("minimaxcode")[0]);
    eq(acc.uid, "577097653167349763", "uid = realUserID");
    ok(/mmoat_login/.test(secrets.token), "token 落库");
    ok(/mmort_login/.test(secrets.refreshToken || ""), "refreshToken 落库");
    ok((acc.expiresAt || 0) > Date.now(), "expiresAt 落在未来");
    const meta = acc.meta || {};
    eq(meta.realUserID, "577097653167349763", "meta.realUserID");
    ok(!!meta.deviceId && !!meta.uuid, "meta 固化设备指纹");
    ok((meta.accessExpiresAt || 0) > Date.now(), "meta.accessExpiresAt");
    eq(discovery.isScanImportAllowed("minimaxcode"), false, "本机导入被拒");

    // 同 uid 再登一次：更新而不是新增
    let done2 = null;
    await discovery.beginOAuth("minimaxcode", (r) => { done2 = r; });
    await waitFor(() => done2, 20000);
    ok(done2 && done2.ok, "二次登录成功");
    eq(store.listAccounts("minimaxcode").length, 1, "同 uid 不重复入池");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 模型目录：归一、落盘、空清单不覆盖、大小写敏感 =====
async function testModels() {
  const http = require("node:http");
  const fs = require("node:fs");
  const models = require("../electron/backend/proxy/minimaxcode/models.cjs");
  const payload = {
    providers: [
      {
        providerId: "minimax",
        config: {
          models: {
            "MiniMax-M3.1-Flash": {
              name: "M3.1-Flash",
              limit: { context: 512000, output: 128000 },
              modalities: { input: ["text", "image", "video"] },
              tool_call: true,
              reasoning: true,
              variants: { thinking: {}, "none-thinking": {} },
            },
            "MiniMax-M3": { name: "M3", limit: { context: 512000, output: 128000 }, modalities: { input: ["text"] }, tool_call: true },
          },
        },
      },
    ],
  };
  const parsed = models.parseModels(payload);
  eq(parsed.length, 2, "解析两个模型");
  const flash = parsed.find((m) => m.id === "MiniMax-M3.1-Flash");
  eq(flash.capabilities, { images: true, reasoning: true, tools: true }, "能力归一");
  eq([flash.contextLength, flash.maxOutputTokens], [512000, 128000], "上下文与输出上限");
  eq(flash.rate, null, "倍率不编造");

  let mode = "ok";
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mode === "ok" ? payload : { providers: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const rulesDir = require("../electron/backend/proxy/rules.cjs").rulesDir();
  const cfg = { agentBase: `http://127.0.0.1:${server.address().port}`, modelsPath: "/mavis/api/v1/models?region=cn&buildEnv=prod" };
  try {
    const r = await models.refresh({ token: "mmoat_x", cfg, httpJson: adapters.httpJson }, rulesDir, "minimaxcode", true);
    ok(r.ok && r.count === 2, "拉取成功计数");
    eq(models.list(rulesDir, "minimaxcode").sort(), ["MiniMax-M3", "MiniMax-M3.1-Flash"], "落盘后 list 读到");
    const onDisk = JSON.parse(fs.readFileSync(path.join(rulesDir, "catalog.json"), "utf8"));
    ok(onDisk.minimaxcode && Array.isArray(onDisk.minimaxcode.models) && onDisk.minimaxcode.syncedAt > 0, "catalog.json 的 minimaxcode 段");

    // 空清单：失败且不覆盖已有清单（Review Focus 4）
    mode = "empty";
    const bad = await models.refresh({ token: "mmoat_x", cfg, httpJson: adapters.httpJson }, rulesDir, "minimaxcode", true);
    ok(!bad.ok, "空清单报失败");
    eq(models.list(rulesDir, "minimaxcode").length, 2, "空清单不覆盖已有清单");

    eq(models.resolveId(rulesDir, "minimaxcode", "MiniMax-M3"), "MiniMax-M3", "逐字命中");
    eq(models.resolveId(rulesDir, "minimaxcode", "minimax-m3"), null, "大小写不同不命中");
    eq(adapters.get("minimaxcode").models().sort(), ["MiniMax-M3", "MiniMax-M3.1-Flash"], "适配器 models() 读同一份目录");
    eq(adapters.get("minimaxcode").mapModel("MiniMax-M3"), "MiniMax-M3", "mapModel 原样透传");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  testRegistry();
  testSign();
  await testOAuth();
  await testIdentity();
  await testLogin();
  await testModels();
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
