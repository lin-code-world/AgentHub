/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Accio / CodeArts / Loomy 三渠道纯函数自测（离线可跑，不打真上游）
// 覆盖：签名向量（CodeArts 尾斜杠 / 字符集 / Go 语义 URL 解析；Loomy 9 段拼接）、
//       Accio 协议翻译（Gemini 信封 / 思考档位落点 / sg_k）、SSE 首帧预读与流内错误、
//       CodeArts 流内错误信封与脱敏、目录归一与大小写查找。
"use strict";

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

const signer = require("../electron/backend/proxy/codearts/signer.cjs");
const loomySign = require("../electron/backend/proxy/loomy/sign.cjs");
const accioProto = require("../electron/backend/proxy/accio/protocol.cjs");
const accioStream = require("../electron/backend/proxy/accio/stream.cjs");
const accioModels = require("../electron/backend/proxy/accio/models.cjs");
const caFault = require("../electron/backend/proxy/codearts/stream_fault.cjs");
const caRedact = require("../electron/backend/proxy/codearts/redact.cjs");
const caModels = require("../electron/backend/proxy/codearts/models.cjs");
const loomyImages = require("../electron/backend/proxy/loomy/images.cjs");
const loomyModels = require("../electron/backend/proxy/loomy/models.cjs");

// ===== CodeArts 签名：尾斜杠 + 字符集 + Go 语义 =====
(function testCodeArtsSigner() {
  const cred = { access_key_id: "AK", secret_access_key: "SK", security_token: "STS", domain_id: "" };
  const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
  const m = signer.signMaterial("POST", url, [["Content-Type", "application/json"]], Buffer.from("{}"), cred, false);
  // canonicalURI 强制补尾斜杠
  ok(m.canonicalRequest.split("\n")[1].endsWith("/"), "CodeArts canonicalURI 补尾斜杠");
  ok(m.canonicalRequest.split("\n")[1] === "/api/v2/chat/completions/", "CodeArts canonicalURI 值");
  // Authorization 头格式
  const auth = m.headers.find(([k]) => k === "Authorization");
  ok(auth && auth[1].startsWith("SDK-HMAC-SHA256 Access=AK, SignedHeaders=") && auth[1].includes("Signature="),
    "CodeArts Authorization 头格式");
  // 空值不进头：domain_id 为空不带 X-Domain-Id
  ok(!m.headers.some(([k]) => k === "X-Domain-Id"), "CodeArts 空 domain_id 不进头");
  // Go 语义 query 解析：+ 是空格
  const q = signer.canonicalQueryString("a=1&b=x+y");
  ok(q.includes("b=x%20y"), "CodeArts query + 折成空格");
})();

// ===== Loomy 签名：9 段拼接 + 路径去尾斜杠 =====
(function testLoomySign() {
  eq(loomySign.buildEscapedPath("/login/phone/checkCode/"), "/login/phone/checkCode", "Loomy 路径去尾斜杠");
  eq(loomySign.buildEscapedPath("login/phone/sendMsgCode"), "/login/phone/sendMsgCode", "Loomy 路径补前导斜杠");
  const headers = loomySign.signedHeaders("POST", "/login/phone/checkCode", { base: {}, param: {} });
  ok(/^account [a-zA-Z0-9]+:[A-Za-z0-9+/=]+$/.test(headers.Authorization), "Loomy Authorization account 形态");
  ok(headers.Date && headers.Nonce && headers["Content-MD5"], "Loomy Date/Nonce/Content-MD5 齐备");
})();

// ===== Accio 协议翻译：Gemini 信封 + 思考档位落点 + sg_k =====
(function testAccioProtocol() {
  const body = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "读", parameters: { type: "object", properties: {} } } }],
    temperature: 0.7, max_tokens: 1024,
  };
  const { body: up, thinking } = accioProto.buildUpstreamBody(body, "claude-sonnet-4-6", "TOKEN", "high", "top");
  eq(up.model, "claude-sonnet-4-6", "Accio model 透传");
  eq(up.token, "TOKEN", "Accio token 在 body");
  eq(up.tenant, "accio-agent", "Accio tenant");
  eq(typeof up.system_instruction, "string", "Accio system_instruction 是字符串");
  eq(up.system_instruction, "你是助手", "Accio system_instruction 值");
  eq(up.contents.length, 1, "Accio contents 合并 system 后剩 user 一轮");
  ok(up.contents[0].parts.some((p) => p.inline_data && p.inline_data.data === "AAAA"), "Accio data URI → inline_data");
  eq(typeof up.tools[0].parameters_json, "string", "Accio parameters_json 是字符串");
  eq(typeof up.tool_config, "string", "Accio tool_config 是字符串");
  eq(up.reasoning_effort, "high", "Accio 顶层 reasoning_effort（top 落点）");
  eq(up.properties.reasoning_effort, undefined, "Accio top 落点不写 properties");
  eq(thinking, true, "Accio thinking 标记");
  // properties 落点（OpenAI 系）
  const { body: up2 } = accioProto.buildUpstreamBody({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }, "gpt-5.4", "T", "low", "properties");
  eq(up2.properties.reasoning_effort, "low", "Accio properties 落点");
  eq(up2.reasoning_effort, undefined, "Accio properties 落点顶层留空");
  // sg_k = md5(requestId)
  const u = accioProto.generateContentUrl("https://gw/api/adk/llm", "abc");
  ok(/sg_k=[0-9a-f]{32}$/.test(u), "Accio sg_k=md5(requestId)");
})();

// ===== Accio SSE：首帧预读 + 流内错误 + 翻译 =====
(function testAccioStream() {
  const frame = accioStream.parseFrame('{"content":{"role":"model","parts":[{"text":"你"}]},"partial":true}');
  eq(frame.parts[0], { kind: "text", text: "你" }, "Accio text part");
  const thought = accioStream.parseFrame('{"content":{"role":"model","parts":[{"thought":true,"text":"想"}]}}');
  eq(thought.parts[0].kind, "thought", "Accio thought part");
  const errFrame = accioStream.parseFrame('{"errorCode":"400","errorMessage":"invalid params"}');
  ok(accioStream.frameIsError(errFrame), "Accio 错误帧判定（camelCase）");
  const snakeErr = accioStream.parseFrame('{"error_code":"401","error_message":"token expired"}');
  ok(accioStream.frameIsError(snakeErr), "Accio 错误帧判定（snake_case）");
  const done = accioStream.parseFrame("[DONE]");
  eq(done, null, "Accio [DONE] 返回 null");
  // Translator 聚合：工具调用分片拼接（argsJson 字符串里的双引号在 JSON 里要转义为 \"）
  const t = new accioStream.Translator("id", "m");
  t.consume(accioStream.parseFrame('{"content":{"parts":[{"functionCall":{"id":"c1","name":"read","argsJson":"{\\"p\\":\\""}}]}}'));
  t.consume(accioStream.parseFrame('{"content":{"parts":[{"functionCall":{"id":"c1","name":"read","argsJson":"1\\"}"}}]}}'));
  const calls = t.finalToolCalls();
  eq(calls.length, 1, "Accio 工具调用分片聚为一条");
  eq(calls[0].function.name, "read", "Accio 工具名");
  // turnComplete 收尾
  const t2 = new accioStream.Translator("id", "m");
  t2.consume(accioStream.parseFrame('{"turnComplete":true,"finishReason":"STOP","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}'));
  eq(t2.finalFinishReason(), "stop", "Accio finishReason STOP→stop");
  eq(t2.usage.prompt_tokens, 10, "Accio usage prompt");
  eq(t2.usage.completion_tokens, 5, "Accio usage completion");
})();

// ===== Accio 目录：v1 数组形态 + 大小写查找 + 思考档位落点 =====
(function testAccioModels() {
  const payload = { success: true, data: [{ provider: "openai", modelList: [
    { modelCode: "1Helix-X", modelName: "1Helix-X", modelDisplayName: "Claude Sonnet 4.6", visible: true, protocol: "responses", contextWindow: 1000000, multimodal: true, reasoningEfforts: ["low", "high"] },
    { modelCode: "gemini-3-flash", modelDisplayName: "Gemini 3 Flash", visible: true, protocol: "", reasoningEfforts: ["low", "high"] },
    { modelCode: "hidden-x", modelDisplayName: "Hidden", visible: false },
  ] }] };
  const parsed = accioModels.parseCatalog(payload);
  eq(parsed.length, 2, "Accio 目录过滤 visible:false");
  eq(parsed[0].id, "claude-sonnet-4-6", "Accio STABLE_IDS 接回老名字");
  eq(parsed[0].upstreamKey, "1Helix-X", "Accio upstreamKey 存代号");
  eq(parsed[0].protocolKind, "properties", "Accio protocol=responses → properties 落点");
  eq(parsed[1].protocolKind, "top", "Accio 空 protocol → top 落点");
})();

// ===== CodeArts 流内错误：额度信封 + 带内容不判故障 + 成功码 =====
(function testCodeArtsFault() {
  const quota = caFault.streamFrameFault('{"error_code":"InferHub.4291.200","error_msg":"insufficient quota","details":[{"error_code":"InferHub.4291.200","error_msg":"requestId: abc"}]}');
  eq(quota && quota.status, 403, "CodeArts 额度信封 → 403");
  const rate = caFault.streamFrameFault('{"error_code":"InferHub.4291.200","error_msg":"rate limit"}');
  eq(rate && rate.status, 429, "CodeArts 限流 → 429");
  eq(caFault.streamFrameFault('{"error_code":"0000","error_msg":"success"}'), null, "CodeArts 成功码不判故障");
  eq(caFault.streamFrameFault('{"error_code":"0","choices":[{"delta":{"content":"hi"}}]}'), null, "CodeArts 带内容不判故障");
  eq(caFault.streamFrameFault('{"choices":[{"index":0,"delta":{"content":"2"},"finish_reason":"stop"}]}'), null, "CodeArts 普通增量不判故障");
  eq(caFault.streamFrameFault('[DONE]'), null, "CodeArts [DONE] 不判故障");
})();

// ===== CodeArts 脱敏：三种拼法 + 后缀残段 =====
(function testCodeArtsRedact() {
  const secret = "AKIA-SECRET-VALUE-12345";
  const redacted = caRedact.redactValues(`auth=${secret} and ${secret.slice(0, 12)}`, [secret], true);
  ok(!redacted.includes(secret), "CodeArts 脱敏盖原文");
  ok(redacted.includes("[REDACTED]"), "CodeArts 脱敏占位");
})();

// ===== CodeArts 目录：三源合并 + 大小写查找 + 福利判定 =====
(function testCodeArtsModels() {
  const merged = caModels.mergeCatalog([{ id: "GLM-5.2" }], [{ id: "qwen3-vl" }], [{ id: "benefit-1" }]);
  eq(merged.length, 3, "CodeArts 三源合并去重");
  eq(caModels.resolveModelId(merged, "glm-5.2"), "GLM-5.2", "CodeArts 小写→上游真名");
  eq(caModels.resolveModelId(merged, "GLM-5.2"), "GLM-5.2", "CodeArts 真名命中");
  ok(caModels.isBenefitId(merged, "BENEFIT-1"), "CodeArts 福利判定大小写无关");
  ok(!caModels.isBenefitId(merged, "glm-5.2"), "CodeArts 非福利不误判");
})();

// ===== Loomy 倍率：上游展示名后缀拆成数字（与全站 catalog 的 rate 口径一致，前端 fmtRate 直接读数字）=====
(function testLoomyRate() {
  eq(loomyModels.splitRateSuffix("Kimi k2.6 (x6.5)"), { name: "Kimi k2.6", rate: 6.5 }, "Loomy 倍率后缀拆成数字");
  eq(loomyModels.splitRateSuffix("某模型（x0.0）"), { name: "某模型", rate: 0 }, "Loomy 0 倍率保留为 0");
  eq(loomyModels.splitRateSuffix("Spark-X2.6 正式版(限时免费)"), { name: "Spark-X2.6 正式版(限时免费)", rate: null }, "Loomy 非倍率后缀不误判");
})();

// ===== Loomy 图片：deepseek 标记改写 =====
(function testLoomyImages() {
  eq(loomyImages.prefersTagFormat("deepseek-v3"), true, "Loomy deepseek 命中");
  eq(loomyImages.prefersTagFormat("spark-x"), false, "Loomy 非 deepseek 不命中");
  const { body, converted } = loomyImages.rewriteToTag({ messages: [{ role: "user", content: [
    { type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
  ] }] });
  eq(converted, 1, "Loomy 图片转标记数");
  eq(body.messages[0].content[1].text, "<image_base64>BBBB</image_base64>", "Loomy <image_base64> 标记");
})();

// ===== Loomy 余额归一：上游摘要必须变成数字（账号级 credits 按 Number() 落库，数组会被吞成 0）=====
// ===== Loomy 模型名精确校验：上游大小写敏感且对未知名静默回落 spark-x2.6 =====
(async () => {
  const loomyBalance = require("../electron/backend/proxy/loomy/balance.cjs");
  const fakeFetch = async () =>
    new Response(JSON.stringify({ code: "000000", desc: "成功", data: { balance: 5000, dailyBalance: 5000, dailyLimitPoints: 5000, dailyRemainingPoints: 5000, total: 0, list: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const bal = await loomyBalance.queryBalance({ session: "test-session" }, fakeFetch);
  ok(typeof bal.credits === "number", "Loomy 余额 credits 是数字（账号级字段按数字落库）");
  eq(bal.credits, 10000, "Loomy credits = 永久 5000 + 每日赠送 5000");
  eq(
    bal.wallets.map((w) => w.balance),
    [5000, 5000],
    "Loomy 双钱包明细保留"
  );
  eq(bal.wallets.map((w) => w.known), [true, true], "Loomy 双钱包 known 标记（上游明确返回才为 true）");

  // 上游漏字段：known=false，不能把「没读到」当成 0（否则路由插件会误判每日赠送已用完）
  const missingFetch = async () =>
    new Response(JSON.stringify({ code: "000000", data: { balance: 30000 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const partial = await loomyBalance.queryBalance({ session: "test-session" }, missingFetch);
  eq(partial.wallets.map((w) => w.known), [true, false], "Loomy 缺 dailyBalance 时 known=false");
  eq(partial.wallets[1].balance, 0, "Loomy 缺 dailyBalance 时展示值仍为 0（既有口径）");

  // 路由插件：每日赠送 0 + 永久还有 → 排后面；其余一律 0（含字段缺失）
  const loomyPolicy = require("../electron/backend/proxy/loomy/routePolicy.cjs");
  const routePolicies = require("../electron/backend/proxy/routePolicies.cjs");
  const accWith = (wallets) => ({ creditsDetail: wallets });
  const W = (d, p, known = true) => [
    { type: "permanent_points", balance: p, known },
    { type: "daily_points", balance: d, known },
  ];
  eq(loomyPolicy.accountRank(accWith(W(0, 30000))), 1, "每日赠送 0 + 永久还有 → 靠后");
  eq(loomyPolicy.accountRank(accWith(W(10, 30000))), 0, "每日赠送还有 → 正常");
  eq(loomyPolicy.accountRank(accWith(W(0, 0))), 0, "两个钱包都 0 → 交给耗尽判据，不当让位");
  eq(loomyPolicy.accountRank(accWith(W(0, 30000, false))), 0, "明细未明确读到 → 不判断");
  eq(loomyPolicy.accountRank({ creditsDetail: null }), 0, "没有明细 → 不判断");
  eq(routePolicies.hasPolicy("loomy"), true, "loomy 登记了路由插件");
  eq(routePolicies.hasPolicy("workbuddy"), false, "其他渠道没有插件");
  eq(routePolicies.accountRankOf("workbuddy", accWith(W(0, 30000))), 0, "插件只对自己的渠道生效");

  const loomyModels = require("../electron/backend/proxy/loomy/models.cjs");
  const ids = ["DeepSeek-V4.1-Flash", "MiniMax-M3", "Kimi-k2.6", "GLM-5.3-Flash", "spark-x"];
  eq(loomyModels.resolveFrom(["DeepSeek-V4.1-Flash"], "deepseek-v4.1-flash"), null, "严格模式不再把大小写不同当成同一个模型");
  eq(loomyModels.resolveFrom(["DeepSeek-V4.1-Flash"], "DeepSeek-V4.1-Flash"), "DeepSeek-V4.1-Flash", "精确写法原样返回");
  eq(loomyModels.resolveFrom(ids, "KIMI-K2.6"), null, "目录多项时大小写不同同样不算命中");
  eq(loomyModels.resolveFrom(ids, "Kimi-k2.6"), "Kimi-k2.6", "目录多项时精确写法仍能命中（不是只比第一项）");
  eq(loomyModels.resolveFrom(["DeepSeek-V4.1-Flash"], " DeepSeek-V4.1-Flash "), null, "前后空白不算精确写法（校验不 trim，否则校验值与发送值不一致）");
  eq(loomyModels.resolveFrom(["DeepSeek-V4.1-Flash"], ""), null, "空字符串不命中");
  eq(loomyModels.resolveFrom(ids, "nonexistent"), null, "Loomy 目录里没有的名字返回 null（不得静默透传）");
  eq(loomyModels.resolveFrom([], "deepseek-v4.1-flash"), null, "目录为空时无从判断，返回 null");

  // 渠道归属逐字精确匹配：写法不同即不同模型（上游大小写敏感，未知名会被静默回落）
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const origGet = adapters.get;
  const origAdapters = adapters.ADAPTERS;
  try {
    const fake = {
      workbuddy: { models: () => ["deepseek-v4.1-flash"] },
      loomy: { models: () => ["DeepSeek-V4.1-Flash"] },
    };
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, fake);
    eq(adapters.modelOwners("deepseek-v4.1-flash", {}), ["workbuddy"], "小写写法只归属小写渠道");
    eq(adapters.modelOwners("DeepSeek-V4.1-Flash", {}), ["loomy"], "大写写法只归属大写渠道");
    eq(adapters.modelOwners("DEEPSEEK-V4.1-FLASH", {}), [], "无渠道精确命中时归属为空（不回退忽略大小写）");
    // 反向映射不受严格匹配影响：配了映射就按映射结果走（resolveModelTarget 依赖 nativeModel）
    const revCfg = { modelReverseAliases: { "my-deepseek": { workbuddy: "deepseek-v4.1-flash" } } };
    eq(adapters.resolveModelTarget("my-deepseek", "workbuddy", revCfg), "deepseek-v4.1-flash", "反向映射目标仍能命中（严格匹配不影响映射）");
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, origAdapters);
    adapters.get = origGet;
  }

  // ===== Loomy chat() 主路径：校验值与发送值一致（不改写 / 不精确不打上游 / 目录为空透传）=====
  // 注入假 fetchStream 与 pumpSse，全程不触网；catalog.json 落系统临时目录，跑完即删
  {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { makeLoomy } = require("../electron/backend/proxy/loomy/adapter.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-loomy-chat-"));
    const mk = () => {
      const sent = [];
      const adapter = makeLoomy({
        rules: { get: () => ({}), rulesDir: () => dir },
        httpJson: async () => ({}),
        util: { verbose: () => {} },
        firstByteBudgetMs: () => 5000,
        fetchStream: async (url, opts) => {
          sent.push(JSON.parse(opts.body));
          return { resp: {}, cancelTimer: () => {} };
        },
        pumpSse: async (resp, onEvent) => { onEvent("message", "[DONE]"); },
      });
      return { adapter, sent };
    };
    const call = (adapter, model) =>
      adapter.chat({ account: {}, secrets: { token: "test-session" }, model, body: { model, messages: [] }, emit: () => {} });
    try {
      // ① 目录为空（从未拉取过模型目录）：无从判断，照常透传。
      //    必须放第一个跑：list() 读不到 catalog.json 时不置 loaded，后续场景仍会重新读盘
      const empty = mk();
      await call(empty.adapter, "whatever-model");
      ok(empty.sent.length === 1 && empty.sent[0].model === "whatever-model", "Loomy chat 目录为空时原样透传（不因目录没有而拒绝）");

      // ② 目录就绪：精确写法放行，发出的 body.model 必须与请求名逐字一致（不替用户改写）
      fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ loomy: { syncedAt: Date.now(), models: [{ id: "DeepSeek-V4.1-Flash" }] } }), "utf8");
      const exact = mk();
      await call(exact.adapter, "DeepSeek-V4.1-Flash");
      ok(exact.sent.length === 1, "Loomy chat 精确写法放行");
      eq(exact.sent[0] && exact.sent[0].model, "DeepSeek-V4.1-Flash", "Loomy chat 发出的模型名与请求名逐字一致（不改写）");

      // ③ 不精确写法：400 且一次都不打上游（上游对未知名会静默回落 spark-x2.6，放过去等于让用户以为在跑别的模型）
      for (const bad of ["deepseek-v4.1-flash", " DeepSeek-V4.1-Flash "]) {
        const wrong = mk();
        let err = null;
        try { await call(wrong.adapter, bad); } catch (e) { err = e; }
        eq(err && err.status, 400, `Loomy chat「${bad}」抛 400`);
        eq(wrong.sent.length, 0, `Loomy chat「${bad}」不发上游请求`);
      }

      // ④ 反向映射：ctx.model 才是要发给上游的真值，body.model（客户端请求名）不得覆盖它。
      // 与 CatPaw 的 withUpstreamModel 同口径；漏掉就会把统一虚拟名发给上游（目录校验直接 400）
      const mapped = mk();
      await mapped.adapter.chat({
        account: {},
        secrets: { token: "test-session" },
        model: "DeepSeek-V4.1-Flash",
        body: { model: "deepseek-v4.1-flash", messages: [] },
        emit: () => {},
      });
      eq(mapped.sent[0] && mapped.sent[0].model, "DeepSeek-V4.1-Flash", "Loomy chat 发上游的是 ctx.model（映射目标），不是 body.model（请求名）");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
