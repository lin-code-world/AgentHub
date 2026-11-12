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

    const accs = store.listAccounts("minimaxcode").filter((a) => a.uid === "577097653167349763");
    eq(accs.length, 1, "入池一条账号");
    const acc = accs[0];
    const secrets = store.accountSecrets(store.accountRows("minimaxcode").find((r) => r.uid === "577097653167349763"));
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
    eq(store.listAccounts("minimaxcode").filter((a) => a.uid === "577097653167349763").length, 1, "同 uid 不重复入池");
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

    // 外部改写 catalog.json（index.cjs 的 proxy_models_sync 会独立写同一份）后，进程内缓存必须失效
    const file = path.join(rulesDir, "catalog.json");
    const all2 = JSON.parse(fs.readFileSync(file, "utf8"));
    all2.minimaxcode = {
      syncedAt: Date.now() + 1000,
      models: [{ id: "MiniMax-New", name: "New", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 1, maxOutputTokens: 1 }],
    };
    fs.writeFileSync(file, JSON.stringify(all2, null, 2), "utf8");
    eq(models.list(rulesDir, "minimaxcode"), ["MiniMax-New"], "外部改写目录文件后 list 按文件变化失效");
    // 复原：后续 chat 用例按真实目录校验模型名
    all2.minimaxcode = { syncedAt: Date.now(), models: parsed };
    fs.writeFileSync(file, JSON.stringify(all2, null, 2), "utf8");
    eq(models.list(rulesDir, "minimaxcode").sort(), ["MiniMax-M3", "MiniMax-M3.1-Flash"], "复原目录后缓存跟随");
    eq(adapters.get("minimaxcode").models().sort(), ["MiniMax-M3", "MiniMax-M3.1-Flash"], "适配器 models() 读同一份目录");
    eq(adapters.get("minimaxcode").mapModel("MiniMax-M3"), "MiniMax-M3", "mapModel 原样透传");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 对话：请求体翻译、SSE 事件桥、未知模型 400、401 交给通用层 =====
async function testChat() {
  const http = require("node:http");
  const ad = adapters.get("minimaxcode");
  const seen = { body: null, headers: null };
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.body = raw;
      seen.headers = req.headers;
      if (String(req.headers.authorization || "").includes("bad401")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 401, message: "auth failed" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const hf = path.join(rules.rulesDir(), "headers.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
  all.minimaxcode = { ...(all.minimaxcode || {}), agentBase: `http://127.0.0.1:${server.address().port}`, messagesPath: "/mavis/api/v1/llm/v1/messages" };
  fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
  rules.reload("headers.json");
  try {
    const events = [];
    const result = await ad.chat({
      account: { id: "a1", uid: "u1", meta: {} },
      secrets: { token: "mmoat_ok" },
      model: "MiniMax-M3.1-Flash",
      body: { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] },
      emit: (ev) => events.push(ev),
      meta: {},
    });
    eq(result.status, 200, "chat 返回 200");
    const sent = JSON.parse(seen.body);
    eq(sent.model, "MiniMax-M3.1-Flash", "模型逐字透传");
    eq(sent.stream, true, "恒开流式");
    eq(sent.max_tokens, 128000, "max_tokens 用目录里的输出上限");
    eq(Array.isArray(sent.system) || typeof sent.system === "string" ? "has" : "none", "has", "system 抽到顶层");
    ok(events.some((e) => e.type === "delta" && String(JSON.stringify(e.delta)).includes("你好")), "SSE 文本增量 emit");
    ok(/Bearer mmoat_ok/.test(String(seen.headers.authorization)), "带 Bearer");

    // 未知模型：入口 400（不猜模型名）
    let unknownErr = null;
    await ad.chat({ account: { id: "a1", meta: {} }, secrets: { token: "mmoat_ok" }, model: "MiniMax-Not-Exist", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {}, meta: {} }).catch((e) => { unknownErr = e; });
    ok(unknownErr && unknownErr.status === 400 && /可用/.test(unknownErr.message), "未知模型 400 并给可用清单");

    // 401：抛给通用层（适配器不自己刷新）
    let authErr = null;
    await ad.chat({ account: { id: "a1", meta: {} }, secrets: { token: "bad401" }, model: "MiniMax-M3", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {}, meta: {} }).catch((e) => { authErr = e; });
    ok(authErr && authErr.status === 401, "401 原样抛出交通用层");

    // 分类器：对话 401 与账号接口 401 都判 auth；403 是「未订阅该模型/权限不足」，不罚号
    eq(ad.classifyError({ status: 401, body: JSON.stringify({ code: 401, message: "auth failed" }) }), { kind: "auth", switchable: false }, "对话 401 分类");
    eq(ad.classifyError({ status: 401, body: JSON.stringify({ error: "invalid access token" }) }), { kind: "auth", switchable: false }, "账号接口 401 分类");
    eq(ad.classifyError({ status: 403, body: JSON.stringify({ error: "model not subscribed" }) }), { kind: "model_denied", switchable: false }, "403 判 model_denied，不罚号");
    eq(ad.classifyError({ status: 403, body: JSON.stringify({ error: "invalid access token" }) }), { kind: "auth", switchable: false }, "403 明确写凭据失效时才判 auth");
    eq(ad.classifyError({ status: 400, body: JSON.stringify({ type: "error", error: { message: "invalid params, unknown model 'X' (2013)" } }) }), null, "未知模型 400 交通用层（400 → fatal，不罚号）");
    eq(ad.classifyError({ status: 500, body: "" }), null, "其它错误交通用分类器");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 续期：窗口收窄、一次性 token 不重复花费、写回形状 =====
async function testRefresh() {
  const ad = adapters.get("minimaxcode");
  eq(ad.refreshWindowSec, 600, "预刷新窗口 10 分钟（默认 24h 会把每轮余额刷新变成一次续期）");
  eq(ad.tokenExpiryMs({ meta: { accessExpiresAt: 123456 } }, {}), 123456, "到期取 meta.accessExpiresAt");
  eq(ad.tokenExpiryMs({ meta: {} }, {}), 0, "没有到期信息返回 0（不预刷新）");
  ok(typeof ad.refreshToken === "function", "实现 refreshToken");
  ok(typeof ad.classifyError === "function", "实现 classifyError");

  const http = require("node:http");
  let hits = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mmoat_r2", refresh_token: "mmort_r2", expires_in: 43200 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const hf = path.join(rules.rulesDir(), "headers.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
  all.minimaxcode = { ...(all.minimaxcode || {}), accountBase: `http://127.0.0.1:${server.address().port}` };
  fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
  rules.reload("headers.json");
  try {
    const first = await ad.refreshToken({ id: "a1", meta: {} }, { refreshToken: "mmort_once" });
    ok(first.ok && first.token === "mmoat_r2", "续期成功并回传新令牌");
    eq(hits, 1, "上游只被请求一次");
    const second = await ad.refreshToken({ id: "a1", meta: {} }, { refreshToken: "mmort_once" });
    ok(!second.ok && second.authError === true, "同一枚 refresh token 第二次直接拒绝");
    eq(hits, 1, "第二次没有再打上游（一次性 token 不会被花第二次）");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 余额：字符串小数、401 两种形态、适配器返回形状 =====
async function testCredits() {
  const http = require("node:http");
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const credits = require("../electron/backend/proxy/minimaxcode/credits.cjs");
  let mode = "ok";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (mode === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid access token" }));
        return;
      }
      if (mode === "biz401") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ base_resp: { status_code: 401, status_msg: "not login" } }));
        return;
      }
      if (mode === "forbidden") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model not subscribed" }));
        return;
      }
      if (mode === "wrapped") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { op_credit_summary: { total_remaining_amount: "88" } }, base_resp: { status_code: 0 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        plan_type: 1,
        plan_name: "",
        has_token_plan: false,
        op_credit_summary: { total_remaining_amount: mode === "decimal" ? "1492.125" : "400", free_remaining_amount: "400", purchased_remaining_amount: "0" },
        base_resp: { status_code: 0, status_msg: "success" },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = { agentBase: base, membershipPath: "/matrix/api/v1/commerce/get_membership_info" };
  const args = { token: "mmoat_x", userId: "u1", deviceId: "12345678", uuid: "u1-uuid", cfg, httpJson: adapters.httpJson };
  try {
    const one = await credits.query(args);
    ok(one.ok && one.credits === 400, "字符串积分转数字 400");
    mode = "decimal";
    const dec = await credits.query(args);
    ok(dec.ok && dec.credits === 1492.125, "小数积分不截断");
    mode = "auth";
    const a = await credits.query(args);
    ok(!a.ok && a.authError === true, "HTTP 401 判 authError");
    mode = "biz401";
    const b = await credits.query(args);
    ok(!b.ok && b.authError === true, "业务码 401 也判 authError");
    mode = "forbidden";
    const f = await credits.query(args);
    ok(!f.ok && !f.authError, "403 不判 authError（不烧一次性令牌、不打死账号）");
    mode = "wrapped";
    const w = await credits.query(args);
    ok(w.ok && w.credits === 88, "兼容 { data: {...} } 包裹形态");

    // 适配器层：meta 已有 realUserID 时不再打 user/info；返回 { credits, expiresAt: 0 }
    const hf = path.join(rules.rulesDir(), "headers.json");
    let all = {};
    try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
    all.minimaxcode = { ...(all.minimaxcode || {}), ...cfg };
    fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
    rules.reload("headers.json");
    mode = "ok";
    const r = await adapters.get("minimaxcode").queryCredits(
      { id: "a1", uid: "u1", meta: { realUserID: "u1", deviceId: "12345678", uuid: "u1-uuid" } },
      { token: "mmoat_x" },
    );
    eq(r, { credits: 400, expiresAt: 0 }, "适配器返回 { credits, expiresAt: 0 }");
    mode = "auth";
    const authErr = await adapters.get("minimaxcode").queryCredits(
      { id: "a1", uid: "u1", meta: { realUserID: "u1", deviceId: "12345678", uuid: "u1-uuid" } },
      { token: "mmoat_x" },
    );
    ok(authErr.authError === true, "适配器把 401 转成 authError（刷新重试由通用层做）");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 签到：面板解析、已签幂等、领取成功回查、401 =====
async function testCheckin() {
  const http = require("node:http");
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const checkin = require("../electron/backend/proxy/minimaxcode/checkin.cjs");
  let mode = "status";
  const panel = {
    data: {
      scene: 2,
      days: [
        { status: 3, is_today: true, bonus_points: 0, day_no: 1, points: 400 },
        { status: 1, is_today: false, bonus_points: 0, day_no: 2, points: 400 },
      ],
    },
    base_resp: { status_code: 0, status_msg: "ok" },
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (mode === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid access token" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (mode === "already") {
        res.end(JSON.stringify({ data: { claim_result: 2, day_no: 1, points: 0 }, base_resp: { status_code: 0 } }));
        return;
      }
      if (mode === "claim") {
        res.end(JSON.stringify({ data: { claim_result: 0, day_no: 1, points: 400 }, base_resp: { status_code: 0 } }));
        return;
      }
      res.end(JSON.stringify(panel));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = {
    agentBase: base,
    signinStatusPath: "/minimax-cloud/api/v1/signin/status",
    signinClaimPath: "/minimax-cloud/api/v1/signin/claim",
  };
  const args = { token: "mmoat_x", userId: "u1", deviceId: "12345678", uuid: "u1-uuid", cfg, httpJson: adapters.httpJson };
  try {
    const st = await checkin.status(args);
    ok(st.ok && st.checkedIn === true, "今日已签");
    eq([st.streakDays, st.credit], [1, 400], "面板字段用仓库签到契约 credit / streakDays");

    mode = "already";
    const al = await checkin.claim(args);
    ok(al.ok && al.already === true, "claim_result=2 判已签（幂等，不算失败）");

    mode = "claim";
    const cl = await checkin.claim(args);
    ok(cl.ok && cl.already === false && cl.credit === 400, "领取成功带回 credit（前端只认这个键）");

    mode = "auth";
    const au = await checkin.status(args);
    ok(!au.ok && au.authError === true, "401 判 authError");

    // 适配器层
    const hf = path.join(rules.rulesDir(), "headers.json");
    let all = {};
    try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
    all.minimaxcode = { ...(all.minimaxcode || {}), ...cfg };
    fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
    rules.reload("headers.json");
    const acc = { id: "a1", uid: "u1", meta: { realUserID: "u1", deviceId: "12345678", uuid: "u1-uuid" } };
    mode = "status";
    const s = await adapters.get("minimaxcode").checkinStatus(acc, { token: "mmoat_x" });
    ok(s.ok && s.checkedIn === true, "适配器 checkinStatus");
    mode = "already";
    const c = await adapters.get("minimaxcode").checkin(acc, { token: "mmoat_x" });
    ok(c.ok && c.already === true, "适配器 checkin 幂等");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 元数据完整性：走真实余额链路不破坏 meta（原始行的 meta 是字符串） =====
async function testMetaIntegrity() {
  const http = require("node:http");
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const creditsMod = require("../electron/backend/proxy/credits.cjs");
  let calls = { userInfo: 0, membership: 0 };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (String(req.url).startsWith("/v1/api/user/info")) {
      calls.userInfo += 1;
      res.end(JSON.stringify({ data: { userInfo: { realUserID: "uid-e2e", name: "e2e" } } }));
      return;
    }
    calls.membership += 1;
    res.end(JSON.stringify({ has_token_plan: false, plan_name: "", op_credit_summary: { total_remaining_amount: "400" }, base_resp: { status_code: 0 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hf = path.join(rules.rulesDir(), "headers.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
  all.minimaxcode = {
    ...(all.minimaxcode || {}),
    agentBase: `http://127.0.0.1:${server.address().port}`,
    userInfoPath: "/v1/api/user/info",
    membershipPath: "/matrix/api/v1/commerce/get_membership_info",
  };
  fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
  rules.reload("headers.json");
  try {
    const meta = { realUserID: "uid-e2e", deviceId: "11111111", uuid: "11111111-1111-4111-8111-111111111111", accessExpiresAt: Date.now() + 3600 * 1000, loginEpoch: "e2e" };
    const id = store.addAccount({ channel: "minimaxcode", uid: `uid-e2e-${Date.now()}`, name: "e2e", token: "mmoat_e2e", refreshToken: "mmort_e2e", expiresAt: Date.now() + 3600 * 1000, meta });
    const r = await creditsMod.refreshAccount(id);
    eq(r.credits, 400, "真实余额链路拿到积分");
    const view = store.listAccounts("minimaxcode").find((a) => a.id === id);
    eq([view.meta.deviceId, view.meta.uuid, view.meta.accessExpiresAt], ["11111111", meta.uuid, meta.accessExpiresAt], "余额刷新不破坏 meta（deviceId/uuid/到期）");
    ok(!Object.keys(view.meta).some((k) => /^\d+$/.test(k)), "meta 没被字符串展开成索引键");
    // 套餐事实要能落库：键名必须避开 store.stripSensitiveMeta 的 /token/i 脱敏
    ok(view.meta.planSubscribed === false, "「确认没有套餐」也存进 meta（键名避开脱敏词）");
    eq(calls.userInfo, 0, "meta 命中时不再打 user/info");

    // saveMeta 必须是读-改-写：库里有别的链路刚写的 checkin，不能被整份覆盖抹掉
    const id2 = store.addAccount({ channel: "minimaxcode", uid: `uid-e2e-noid-${Date.now()}`, name: "e2e2", token: "mmoat_e2e2", refreshToken: "mmort_e2e2", meta: { deviceId: "22222222", uuid: "22222222-2222-4222-8222-222222222222" } });
    store.noteCheckin(id2, { ok: true, credit: 400, streakDays: 1 }, "checkin");
    await creditsMod.refreshAccount(id2);
    const view2 = store.listAccounts("minimaxcode").find((a) => a.id === id2);
    ok(view2.meta.checkin && view2.meta.checkin.credit === 400, "补 realUserID 写回时不抹掉 checkin 记录");
    eq(view2.meta.realUserID, "uid-e2e", "确实写回了 realUserID");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 预刷新窗口：续期写回到期后，连续两次检查只续期一次 =====
async function testRefreshWindow() {
  const http = require("node:http");
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const creditsMod = require("../electron/backend/proxy/credits.cjs");
  let hits = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mmoat_win", refresh_token: "mmort_win", expires_in: 43200 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    accountBase: `http://127.0.0.1:${server.address().port}`,
    agentBase: "http://127.0.0.1:1",
    clientId: "mcode-public",
    scope: "agent.default",
    audience: "agent-backend",
  };
  const hf = path.join(rules.rulesDir(), "headers.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
  all.minimaxcode = { ...(all.minimaxcode || {}), ...cfg };
  fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
  rules.reload("headers.json");
  try {
    // 视图形态（meta 是对象），到期已进入 10 分钟窗口内
    const acc = { id: "acc-win", channel: "minimaxcode", uid: "uid-win", meta: { realUserID: "uid-win", accessExpiresAt: Date.now() + 60 * 1000 } };
    const secrets = { token: "mmoat_old", refreshToken: "mmort_old_window", meta: { ...acc.meta } };
    const first = await creditsMod.ensureFreshSecrets(acc, secrets);
    eq(hits, 1, "第一次进入窗口触发一次续期");
    ok(/mmoat_win/.test(first.token), "返回新令牌");
    ok(Number(acc.meta.accessExpiresAt) > Date.now() + 3600 * 1000, "续期把新到期写回账号 meta");
    const second = await creditsMod.ensureFreshSecrets(acc, first);
    eq(hits, 1, "第二次不再续期（窗口已按新到期判定）");
    ok(/mmoat_win/.test(second.token), "第二次直接用新令牌");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== 网络失败不算「已花」：同一枚 refresh token 恢复后仍可用 =====
async function testRefreshNotBlacklistedOnNetworkError() {
  const http = require("node:http");
  const fs = require("node:fs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const ad = adapters.get("minimaxcode");
  let hits = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits += 1;
      const p = new URLSearchParams(raw);
      if (p.get("refresh_token") === "mmort_param") {
        // 参数类 400：这枚令牌其实还活着，不能拉黑
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "unsupported scope" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mmoat_net", refresh_token: "mmort_net", expires_in: 43200 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hf = path.join(rules.rulesDir(), "headers.json");
  const writeBase = (base) => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(hf, "utf8")); } catch { /* 新建 */ }
    all.minimaxcode = { ...(all.minimaxcode || {}), accountBase: base };
    fs.writeFileSync(hf, JSON.stringify(all, null, 2), "utf8");
    rules.reload("headers.json");
  };
  try {
    writeBase("http://127.0.0.1:1");
    const failed = await ad.refreshToken({ id: "acc-net", meta: {} }, { refreshToken: "mmort_net_once" });
    ok(!failed.ok && failed.authError === false, "网络失败不判 authError");
    writeBase(`http://127.0.0.1:${server.address().port}`);
    const retried = await ad.refreshToken({ id: "acc-net", meta: {} }, { refreshToken: "mmort_net_once" });
    ok(retried.ok && retried.token === "mmoat_net", "同一枚 token 在恢复后可重试");
    eq(hits, 1, "上游只真正收到一次");

    // 参数类 400（invalid_request）不是「令牌已作废」：不判 authError，也不拉黑
    const param = await ad.refreshToken({ id: "acc-param", meta: {} }, { refreshToken: "mmort_param" });
    ok(!param.ok && param.authError === false, "参数类 400 不判 authError");
    const param2 = await ad.refreshToken({ id: "acc-param", meta: {} }, { refreshToken: "mmort_param" });
    ok(!param2.ok, "重试仍失败（上游确实拒绝）");
    eq(hits, 3, "参数类 400 没有被拉黑，第二次仍打到上游");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ===== OAuth 标准错误体：authorization_pending / slow_down / access_denied =====
async function testOAuthStandardErrors() {
  const http = require("node:http");
  const oauth = require("../electron/backend/proxy/minimaxcode/oauth.cjs");
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n += 1;
      if (n === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "authorization_pending", error_description: "the user has not finished authorizing yet" }));
        return;
      }
      if (n === 2) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "slow_down" }));
        return;
      }
      if (n === 3) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "access_denied" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mmoat_std", refresh_token: "mmort_std", expires_in: 43200 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { accountBase: `http://127.0.0.1:${server.address().port}` };
  const device = { deviceCode: "DEV-CODE", pollByUser: false, verifier: "v" };
  try {
    eq((await oauth.pollToken(device, cfg, adapters.httpJson)).kind, "pending", "标准 authorization_pending 继续等");
    eq((await oauth.pollToken(device, cfg, adapters.httpJson)).kind, "slowDown", "标准 slow_down 拉长间隔");
    const denied = await oauth.pollToken(device, cfg, adapters.httpJson);
    ok(denied.kind === "failed" && /拒绝/.test(denied.message), "access_denied 判失败");
    const okd = await oauth.pollToken(device, cfg, adapters.httpJson);
    eq(okd.kind, "confirmed", "标准体下拿到令牌");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  testRegistry();
  testSign();
  await testOAuth();
  await testOAuthStandardErrors();
  await testIdentity();
  await testLogin();
  await testModels();
  await testChat();
  await testRefresh();
  await testCredits();
  await testCheckin();
  await testMetaIntegrity();
  await testRefreshWindow();
  await testRefreshNotBlacklistedOnNetworkError();
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
  else console.log("全部通过");
})();
