/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 路由守卫自测（2026-11 八条裁决对应的新行为）：
//   ① 模型名逐字敏感（含自定义提供商清单）
//   ② 渠道错误类别归一化：quota → rate（带上游等待时间）、auth → relogin
//   ③ Key 绑定自定义提供商：只收 `slug/模型名`，模型不匹配直接拒绝；非法 route 报错
//   ④ /v1/models 与 count_tokens 必须带有效 Key；/healthz 保持公开
//   ⑤ 模型名不对（404）零冷却、不降级渠道
//   ⑥ 上游明示等待时间照单全收，封顶 24 小时
//   ⑦ 客户端中途断开后不再换号（当前这趟跑完）
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-routing-guard-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-guard-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const server = require("../electron/backend/proxy/server.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log("  ok " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (extra !== undefined ? " => " + JSON.stringify(extra) : ""));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UP = 19611;
const GW = 19612;

async function main() {
  store.open();
  rules.init();
  {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "fixtures", "test-catalog.json"), "utf8"));
    const cat = {};
    for (const [ch, seg] of Object.entries(fixture)) cat[ch] = { syncedAt: Date.now(), models: seg.models };
    fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify(cat, null, 2), "utf8");
    rules.reload("catalog.json");
  }

  let mode = "ok";
  let hits = 0;
  let delayMs = 0;
  const fake = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      hits++;
      const send = () => {
        if (mode === "404") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end('{"error":{"message":"model not found"}}');
          return;
        }
        if (mode === "429") {
          res.writeHead(429, { "content-type": "application/json" });
          res.end('{"error":{"message":"your usage will reset at 2030-01-01 00:00:00 UTC+8"}}');
          return;
        }
        if (mode === "500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":{"message":"boom"}}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c1", object: "chat.completion", created: 1, model: "gpt-x",
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise((r) => fake.listen(UP, "127.0.0.1", r));

  const mk = (id, models) => {
    const r = provider.create({ id, baseUrl: `http://127.0.0.1:${UP}/v1`, models });
    if (!r.ok) throw new Error("create " + id + " failed: " + r.message);
    provider.addKey(id, { key: "sk-" + id });
  };
  mk("relay", ["gpt-x", "GPT-Y"]);
  mk("other", ["gpt-z"]);
  mk("ctrl", ["gpt-w"]);

  const cfg = {
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8,
    routeStrategy: "auto", fixedChannel: "", modelOverrides: {}, humanizeJitter: false,
    disabledModels: [], channelFailover: true, channelFailoverMax: 3,
    retrySameAccountCount: 0, concurrencyPerAccount: 3,
  };
  const sr = await server.start(() => cfg);
  ok(sr.ok, "网关启动", sr.message || "");
  const base = `http://127.0.0.1:${GW}`;
  const chat = (key, payload, extra) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(payload),
      ...(extra || {}),
    });

  // ===== ① 模型名逐字敏感 =====
  console.log("\n① 模型名逐字敏感");
  ok(provider.providerHasModel("relay", "relay/gpt-x") === true, "清单里的名字命中");
  ok(provider.providerHasModel("relay", "relay/GPT-X") === false, "大小写不同不命中（逐字敏感）");
  ok(provider.providerHasModel("relay", "relay/GPT-Y") === true, "清单里的 GPT-Y 原样命中");
  const dup = provider.normalizeModels(["GPT-X", "gpt-x"]);
  ok(dup.ok && dup.models.length === 2, "大小写不同视为两个模型（不再折叠去重）", dup.models);

  // ===== ② 渠道错误类别归一化 =====
  console.log("\n② 渠道错误类别归一化");
  const e429 = Object.assign(new Error("too many requests"), { status: 429, retryAfterMs: 60000 });
  const q = server.normalizeChannelCls({ kind: "quota", switchable: true, status: 429 }, e429);
  ok(q.kind === "rate" && q.resetMs > 0, "quota → rate 且带上等待时间", q);
  const au = server.normalizeChannelCls({ kind: "auth", switchable: false, status: 401 }, Object.assign(new Error("unauthorized"), { status: 401 }));
  ok(au.kind === "relogin", "auth → relogin", au);
  const au2 = server.normalizeChannelCls({ kind: "auth", switchable: false, status: 401 }, Object.assign(new Error("usage will reset at 2030-01-01 00:00:00 UTC+8"), { status: 401 }));
  ok(au2.resetMs > 0, "auth 也接住上游明示的重置时间", au2);

  // ===== ③ 绑定自定义提供商 =====
  console.log("\n③ 绑定自定义提供商：模型不匹配直接拒绝");
  const kRelay = store.createKey({ name: "绑定 relay", route: "relay", dailyQuota: 0, rateLimit: 0 });
  ok(!!(kRelay && kRelay.secret), "Key 可绑定自定义提供商（routeOk 放开）");

  let r = await chat(kRelay.secret, { model: "relay/gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] });
  ok(r.status === 200, "绑定提供商 + 正确前缀 → 200", r.status);
  await r.text();

  r = await chat(kRelay.secret, { model: "gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] });
  let j = await r.json().catch(() => ({}));
  ok(r.status === 403 && /relay\//.test((j.error && j.error.message) || ""), "裸名 → 403 且提示要写 relay/模型名", [r.status, j.error && j.error.message]);

  r = await chat(kRelay.secret, { model: "relay/nope", stream: false, messages: [{ role: "user", content: "hi" }] });
  ok(r.status === 403, "模型不在提供商清单 → 403", r.status);
  await r.text();

  r = await chat(kRelay.secret, { model: "other/gpt-z", stream: false, messages: [{ role: "user", content: "hi" }] });
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && /不能/.test((j.error && j.error.message) || ""), "绑定 relay 却请求 other/ 前缀 → 403（前缀不得绕过绑定）", [r.status, j.error && j.error.message]);

  provider.update("relay", { enabled: false });
  r = await chat(kRelay.secret, { model: "relay/gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] });
  ok(r.status === 403, "绑定的提供商被停用 → 403", r.status);
  await r.text();

  let threw = false;
  try {
    store.createKey({ name: "x", route: "no-such-thing", dailyQuota: 0, rateLimit: 0 });
  } catch {
    threw = true;
  }
  ok(threw, "新建 Key 传非法 route → 明确报错（不再静默改 auto）");
  const renamed = (() => {
    try {
      return store.updateKey(kRelay.id, { name: "改个名", route: "relay" });
    } catch (e) {
      return "ERR:" + e.message;
    }
  })();
  ok(renamed === true, "绑定的提供商停用后仍能改名（route 未变化即放行）", renamed);
  provider.update("relay", { enabled: true });

  // ===== ④ 只读端点鉴权 =====
  console.log("\n④ 模型清单与 token 计数必须带有效 Key");
  r = await fetch(base + "/v1/models");
  ok(r.status === 401, "无 Key GET /v1/models → 401", r.status);
  await r.text();
  r = await fetch(base + "/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(r.status === 401, "无 Key count_tokens → 401", r.status);
  await r.text();
  r = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + kRelay.secret } });
  ok(r.status === 200, "带有效 Key GET /v1/models → 200", r.status);
  await r.text();
  const kOff = store.createKey({ name: "停用", route: "auto", dailyQuota: 0, rateLimit: 0 });
  store.updateKey(kOff.id, { enabled: false });
  r = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + kOff.secret } });
  ok(r.status === 401, "停用的 Key 看不到模型清单 → 401", r.status);
  await r.text();
  r = await fetch(base + "/healthz");
  ok(r.status === 200 || r.status === 503, "健康检查保持公开（不要求 Key）", r.status);
  await r.text();

  // ===== ⑤ 404 零冷却、不降级 =====
  console.log("\n⑤ 模型名不对（404）零冷却、不降级");
  mode = "404";
  const kAuto = store.createKey({ name: "auto", route: "auto", dailyQuota: 0, rateLimit: 0 });
  r = await chat(kAuto.secret, { model: "relay/gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] });
  await r.text();
  ok(r.status >= 400, "上游 404 如实回错", r.status);
  ok(Object.keys(server.channelHealthSnapshot()).length === 0, "404 不降级渠道", server.channelHealthSnapshot());
  const accs5 = pool.poolAccounts("relay");
  ok(accs5.every((a) => !a.coolUntil || a.coolUntil <= Date.now()), "404 不给账号落冷却", accs5.map((a) => a.coolUntil));

  // ===== ⑥ 上游等待时间封顶 24h =====
  console.log("\n⑥ 上游明示等待时间照单全收、封顶 24 小时");
  mode = "429";
  store.updateKey(kAuto.id, { route: "relay" });
  r = await chat(kAuto.secret, { model: "relay/gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] });
  await r.text();
  const acc6 = pool.poolAccounts("relay").find((a) => a.coolUntil > Date.now());
  const cd = acc6 ? acc6.coolUntil - Date.now() : -1;
  ok(cd > 23.5 * 3600 * 1000 && cd <= 24.5 * 3600 * 1000, "上游给到 2030 年也封顶在 24 小时", cd);
  store.updateKey(kAuto.id, { route: "auto" });
  for (const a of pool.poolAccounts("relay")) store.updateAccount(a.id, { status: "online", coolUntil: 0, coolReason: "" });

  // ===== ⑦ 断连止损 =====
  console.log("\n⑦ 客户端中途断开后不再换号");
  provider.addKey("relay", { key: "sk-relay-2" }); // 保证同渠道有两个可用账号，才能体现「换号」
  mode = "500";
  delayMs = 300;
  const kDisc = store.createKey({ name: "断连", route: "relay", dailyQuota: 0, rateLimit: 0 });
  const h0 = hits;
  const ac = new AbortController();
  const p = chat(kDisc.secret, { model: "relay/gpt-x", stream: true, messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal }).catch(() => null);
  await sleep(100);
  ac.abort();
  await p;
  await sleep(1500);
  ok(hits - h0 === 1, "断开后只打一次上游（未继续换号）", hits - h0);

  // 对照：不断开时应当换第二个号。用专用渠道（relay 此刻可能已进渠道降级，对照组需要干净渠道）
  mode = "500";
  delayMs = 0;
  provider.addKey("ctrl", { key: "sk-ctrl-2" });
  const kCtrl = store.createKey({ name: "对照", route: "ctrl", dailyQuota: 0, rateLimit: 0 });
  const h1 = hits;
  r = await chat(kCtrl.secret, { model: "ctrl/gpt-w", stream: false, messages: [{ role: "user", content: "hi" }] });
  await r.text();
  ok(hits - h1 >= 2, "对照：不断开时确实换了第二个号", hits - h1);

  await server.stopAsync().catch(() => {});
  fake.close();
  console.log(`\n路由守卫自测：${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
