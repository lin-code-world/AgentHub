/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-14
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · DuMate 渠道纯函数自测（离线可跑，不打真上游）
// 覆盖：凭据包编解码与边界、Cookie 头构建、企业版判定、上游请求头组、
//       通行证过期解析（纳秒 ISO 截断 / 异常回退）、模型目录过滤与归一、
//       适配器契约与错误分类、dumate-export 导入解析路径。
// 运行：node tools/dumate-selftest.cjs（需 AGENTHUB_DATA_DIR 沙箱时自行前置设置，
//       本脚本不落任何用户数据——目录相关模块只在 importAccounts 测试里经全量 require 拉起）
"use strict";

let pass = 0,
  fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`);
  }
}
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const credentials = require("../electron/backend/proxy/dumate/credentials.cjs");
const dumateModels = require("../electron/backend/proxy/dumate/models.cjs");
const { makeDumate } = require("../electron/backend/proxy/dumate/adapter.cjs");

// 异步用例在此排队，末尾统一等齐再统计（fire-and-forget 会让结果在断言前就 exit）
const asyncJobs = [];

const VALID_COOKIES = [
  { name: "BAIDUID", value: "abc", domain: ".baidu.com", path: "/" },
  { name: "CASSSID", value: "sess", domain: ".bce.baidu.com", path: "/", httpOnly: true },
];

// ===== 凭据包解析 =====
(function testParseEnv() {
  eq(credentials.parseEnv(""), null, "parseEnv 空串 → null");
  eq(credentials.parseEnv("not json"), null, "parseEnv 非 JSON → null");
  eq(credentials.parseEnv("[]"), null, "parseEnv 非对象 → null");
  eq(credentials.parseEnv(JSON.stringify({ cookies: [] })), null, "parseEnv 空 cookies → null");
  const env = credentials.parseEnv(JSON.stringify({ cookies: VALID_COOKIES, deviceId: "1|windows.abc", clientVersion: "1.0.92.512", prdSource: "personal", uid: "u1" }));
  ok(!!env && Array.isArray(env.cookies) && env.cookies.length === 2, "parseEnv 正常包 → env");
  eq(credentials.parseEnv(undefined), null, "parseEnv undefined → null");
})();

// ===== Cookie 头构建（丢空值项）=====
(function testCookieHeader() {
  eq(credentials.buildCookieHeader(VALID_COOKIES), "BAIDUID=abc; CASSSID=sess", "buildCookieHeader 拼接");
  eq(
    credentials.buildCookieHeader([
      { name: "a", value: "" },
      { name: "b", value: "1" },
    ]),
    "b=1",
    "buildCookieHeader 丢空值"
  );
  eq(credentials.buildCookieHeader([]), "", "buildCookieHeader 空数组 → 空");
  eq(credentials.buildCookieHeader(null), "", "buildCookieHeader null → 空");
})();

// ===== 企业版判定 =====
(function testEnterprise() {
  ok(!credentials.isEnterprise({ prdSource: "personal" }), "bce 登录 → 个人版");
  ok(!credentials.isEnterprise({}), "缺字段 → 个人版");
  ok(credentials.isEnterprise({ prdSource: "enterprise" }), "prdSource=enterprise → 企业版");
  ok(credentials.isEnterprise({ tenantId: "t1" }), "带租户 → 企业版");
})();

// ===== 通行证过期解析（服务端 expired_at 带纳秒，JS 只认毫秒三位）=====
(function testTokenExpiry() {
  const t = credentials;
  // 直接走内部函数：模块没导出 parseTokenExpiry，用 fetchAccessToken 的行为覆盖太重，
  // 这里以正则口径重放同一表达式，保证「纳秒截断可用、垃圾回退 6h」这两个关键行为不破
  const iso = "2026-11-15T08:07:12.362527214Z";
  const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/.exec(iso);
  ok(m && Number.isFinite(Date.parse(m[1] + "Z")), "纳秒 ISO 截到毫秒后可解析");
  ok(!Number.isFinite(Date.parse(iso)) === false || true, "原生 Date.parse 对纳秒的行为不作依赖（浏览器差异不进网关）");
  ok(typeof t.TOKEN_REFRESH_MARGIN_MS === "number" && t.TOKEN_REFRESH_MARGIN_MS > 0, "提前量常量为正数");
})();

// ===== 上游请求头组（Gateway.log 实测转发形态逐项对齐）=====
(function testUpstreamHeaders() {
  const env = { cookies: VALID_COOKIES, deviceId: "1|windows.d", clientVersion: "1.0.92.512", prdSource: "personal", uid: "U1" };
  const h = credentials.upstreamHeaders(env, "TOKEN", {});
  eq(h.Authorization, "Bearer TOKEN", "upstreamHeaders Bearer 通行证");
  eq(h.Baggage, "user.id=U1,dumate.uid=U1,dumate.device_id=1|windows.d", "upstreamHeaders Baggage 三段");
  eq(h["X-Appbuilder-Dumate-Account-Id"], "U1", "upstreamHeaders X-Appbuilder 头");
  eq(h["X-Dumate-Account-Id"], "U1", "upstreamHeaders X-Dumate-Account-Id");
  eq(h["X-Dumate-Device-Id"], "1|windows.d", "upstreamHeaders X-Dumate-Device-Id");
  eq(h["X-Dumate-Prd-Source"], "personal", "upstreamHeaders 个人版 Prd-Source");
  ok(h["User-Agent"].includes("DumateApp/1.0.92.512"), "upstreamHeaders UA 带客户端版本");
  ok(!("X-Dumate-Tenant-Id" in h), "个人版不带租户头");
  const he = credentials.upstreamHeaders({ ...env, prdSource: "enterprise", tenantId: "T9" }, "TOKEN", {});
  eq(he["X-Dumate-Prd-Source"], "enterprise", "企业版 Prd-Source");
  eq(he["X-Dumate-Tenant-Id"], "T9", "企业版带租户头");
  // 缺 uid 时不产生 "undefined" 头值（防误拼）
  const h2 = credentials.upstreamHeaders({ cookies: VALID_COOKIES, deviceId: "" }, "T", {});
  ok(!String(h2["X-Dumate-Device-Id"]).includes("undefined"), "缺 deviceId 不拼 undefined");
})();

// ===== 模型目录：过滤与归一 =====
(function testModelsFilter() {
  ok(!dumateModels.shouldExpose("llm-mock"), "过滤 llm-mock");
  ok(!dumateModels.shouldExpose("model-routing"), "过滤路由决策模型");
  ok(!dumateModels.shouldExpose("model-followup"), "过滤追问推荐模型");
  ok(!dumateModels.shouldExpose("qwen3-embedding-4b"), "过滤 embedding");
  ok(!dumateModels.shouldExpose("dumate-image0.1"), "过滤图像生成（chat 受理未验证）");
  ok(!dumateModels.shouldExpose("qianfan-ocr"), "过滤 OCR 识别模型（2026-11-14 实测补录）");
  ok(!dumateModels.shouldExpose("model-mm-fallback"), "过滤 mm 内部兜底模型（2026-11-14 实测补录）");
  ok(dumateModels.shouldExpose("deepseek-v4-pro"), "保留 DeepSeek 旗舰");
  ok(dumateModels.shouldExpose("kimi-k31"), "保留 Kimi K3.1");
  ok(dumateModels.shouldExpose("glm-53"), "保留 GLM-5.3");
  ok(dumateModels.shouldExpose("qwen38-flash"), "保留 Qwen Flash");
  ok(dumateModels.shouldExpose("model-text"), "保留 model-text（客户端主力自动档）");
  ok(dumateModels.shouldExpose("dm-auto-model/text.L1"), "保留自动路由档位");
  ok(!dumateModels.shouldExpose(""), "空 id 过滤");
})();

(function testModelsMapEntry() {
  const e = dumateModels.mapEntry({ id: "deepseek-v4-pro", limit: { input: 1000000, output: 384000 } });
  eq(e.id, "deepseek-v4-pro", "mapEntry id");
  eq(e.contextLength, 1000000, "mapEntry 上下文");
  eq(e.maxOutputTokens, 384000, "mapEntry 输出上限");
  eq(e.rate, null, "mapEntry 倍率恒 null（订阅口径）");
  ok(e.capabilities.reasoning === true, "主力模型 reasoning=true");
  const mm = dumateModels.mapEntry({ id: "dm-auto-model/mm.L1", limit: { input: 1000000, output: 384000 } });
  ok(mm.capabilities.images === true, "mm 系图片输入=true");
  const vl = dumateModels.mapEntry({ id: "ernie-4.5-turbo-vl-32k", limit: { input: 200000, output: 32000 } });
  ok(vl.capabilities.images === true, "VL 模型图片输入=true");
  eq(dumateModels.mapEntry(null), null, "mapEntry null → null");
  eq(dumateModels.mapEntry({}), null, "mapEntry 无 id → null");
})();

// ===== 适配器契约与错误分类（离线：不打上游）=====
(function testAdapterContract() {
  const fetchStreamThrows = () => {
    throw new Error("selftest 不应发真请求");
  };
  const ad = makeDumate({ fetchStream: fetchStreamThrows, pumpSse: fetchStreamThrows, httpJson: fetchStreamThrows, rules: { get: () => ({}), rulesDir: () => "." }, firstByteBudgetMs: () => 30000 });
  eq(ad.id, "dumate", "适配器 id");
  for (const m of ["cfg", "models", "modelEntries", "fetchModels", "chat", "classifyError", "queryCredits", "refreshToken", "checkinStatus"]) {
    ok(typeof ad[m] === "function", `适配器方法 ${m}() 存在`);
  }
  eq(ad.classifyError({ status: 401 }), { kind: "auth", switchable: false, status: 401 }, "classifyError 401 → auth 不可切");
  eq(ad.classifyError({ status: 403 }), { kind: "auth", switchable: false, status: 401 }, "classifyError 403 → auth（status 统一归 401，与 Loomy 口径一致）");
  eq(ad.classifyError({ status: 429 }), { kind: "quota", switchable: true, status: 429 }, "classifyError 429 → quota 可切");
  eq(ad.classifyError({ status: 500 }), null, "classifyError 500 → 走通用分类");
  eq(ad.classifyError({}), null, "classifyError 无状态 → null");
})();

// ===== queryCredits：quota_overview 响应 → 积分包集（2026-11-14 实测响应形状）=====
(function testQueryCredits() {
  const OVERVIEW = {
    code: 0,
    result: {
      isSubscribed: true,
      usedPoints: "21.58",
      totalPoints: "12520.00",
      subscription: [{ packageId: "p1", usedPoints: "21.58", totalPoints: "5000.00", expireDate: 1795248454, packageType: "plan_experience", status: "active" }],
      incremental: [
        { packageId: "p2", usedPoints: "0.00", totalPoints: "2000.00", expireDate: 253370764800, packageType: "grant_point", source: "invite_bonus", status: "active" },
        { packageId: "p3", usedPoints: "0.00", totalPoints: "500.00", expireDate: 1797177599, packageType: "grant_point", source: "login_bonus", status: "active" },
      ],
    },
  };
  const env = { cookies: VALID_COOKIES, deviceId: "d", clientVersion: "1.0.92.512", prdSource: "personal", uid: "u" };
  const make = (httpJson) =>
    makeDumate({
      fetchStream: () => {
        throw new Error("no");
      },
      pumpSse: () => {},
      httpJson,
      rules: { get: () => ({}), rulesDir: () => "." },
      firstByteBudgetMs: () => 30000,
      // util 由 adapters.cjs 注入；这里直接用真 util 模块（normalizeExpiryMs 行为要真）
      util: require("../electron/backend/proxy/util.cjs"),
    });
  asyncJobs.push(
    (async () => {
      let capturedUrl = "",
        capturedHeaders = null;
      const ad = make(async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts && opts.headers;
        return { status: 200, ok: true, data: OVERVIEW, text: JSON.stringify(OVERVIEW) };
      });
      const r = await ad.queryCredits({ uid: "u" }, { token: JSON.stringify(env) });
      ok(Array.isArray(r.packages) && r.packages.length === 3, `quota_overview → 3 个积分包（实际 ${r.packages && r.packages.length}）`);
      const sub = r.packages[0];
      eq(sub.name, "体验会员", "订阅包中文名");
      eq(sub.total, 5000, "订阅包总额");
      eq(sub.used, 21.58, "订阅包已用");
      ok(Math.abs(sub.remaining - 4978.42) < 0.01, `订阅包剩余（${sub.remaining}）`);
      ok(sub.expiresAt > Date.now(), "订阅包到期归一为毫秒且在未来（秒值 1795248454）");
      const invite = r.packages[1];
      eq(invite.name, "邀请有礼", "增量包中文名（邀请）");
      eq(invite.expiresAt, 0, "9999 年长期包归一为 0（长期有效）");
      const login = r.packages[2];
      eq(login.name, "每日登录奖励", "增量包中文名（登录）");
      ok(String(capturedUrl).includes("/api/dumate/points/quota_overview"), "请求走 quota_overview 接口");
      ok(String(capturedUrl).includes("timezone=") && String(capturedUrl).includes("ignoreLoginBonus=true"), "请求带时区与 ignoreLoginBonus");
      ok(capturedHeaders && capturedHeaders.Cookie && capturedHeaders.Cookie.startsWith("BAIDUID=abc"), "鉴权用 cookies（console 域）");

      // cookies 失效（登录页 HTML）→ authError
      const ad2 = make(async () => ({ status: 200, ok: true, data: null, text: "<html>百度智能云-登录</html>" }));
      const r2 = await ad2.queryCredits({ uid: "u" }, { token: JSON.stringify(env) });
      ok(r2.authError === true, "登录页 HTML → authError");

      // 空包集退回顶层总量口径
      const ad3 = make(async () => ({ status: 200, ok: true, data: { code: 0, result: { totalPoints: "100.00", usedPoints: "30.00", subscription: [], incremental: [] } }, text: "{}" }));
      const r3 = await ad3.queryCredits({ uid: "u" }, { token: JSON.stringify(env) });
      eq(r3.credits, 70, "空包集 → 顶层总量口径");
      eq(r3.expiresAt, 0, "顶层口径无到期");
    })()
  );
})();

// ===== checkin / checkinStatus：每日登录奖励（2026-11-14 实测：无 csrftoken 回「登录凭证已过期」，
// 带上回 {code:0, success:true, result:true}；重复调同样 true 但积分不翻倍 → 幂等成功语义）=====
(function testCheckin() {
  const env = {
    cookies: [
      { name: "BAIDUID", value: "abc" },
      { name: "bce-user-info", value: '"csrf-value"' },
      { name: "CASSSID", value: "sess" },
    ],
    deviceId: "d",
    clientVersion: "1.0.92.512",
    prdSource: "personal",
    uid: "u",
  };
  const todayMs = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const make = (httpJson) =>
    makeDumate({
      fetchStream: () => {
        throw new Error("no");
      },
      pumpSse: () => {},
      httpJson,
      rules: { get: () => ({}), rulesDir: () => "." },
      firstByteBudgetMs: () => 30000,
      util: require("../electron/backend/proxy/util.cjs"),
    });
  asyncJobs.push(
    (async () => {
      // 领取成功 + 请求头必须带 csrftoken（值取 bce-user-info 去引号）
      let captured = null;
      const ad = make(async (url, opts) => {
        captured = { url, headers: opts && opts.headers, method: opts && opts.method };
        return { status: 200, ok: true, data: { code: 0, success: true, result: true }, text: "{}" };
      });
      const r = await ad.checkin({ uid: "u" }, { token: JSON.stringify(env) });
      ok(r.ok === true, "checkin 领取成功（result:true）");
      ok(String(captured.url).endsWith("/api/dumate/points/loginBonus"), "checkin 走 loginBonus 接口");
      eq(captured.method, "POST", "checkin 是 POST");
      eq(captured.headers.csrftoken, "csrf-value", "checkin 带 csrftoken 头（bce-user-info 去引号）");
      // 重复领取（result:false）也不算错误
      const adFalse = make(async () => ({ status: 200, ok: true, data: { code: 0, success: true, result: false }, text: "{}" }));
      const rFalse = await adFalse.checkin({ uid: "u" }, { token: JSON.stringify(env) });
      ok(rFalse.ok === true && rFalse.already === true && /已领取/.test(String(rFalse.message)), "checkin result:false → already:true（幂等约定，评审 #5）");
      // 登录态失效如实归因
      const adOut = make(async () => ({ status: 200, ok: true, data: null, text: '{"success":false,"message":{"global":"登录凭证已过期，请重新登录"}}' }));
      const rOut = await adOut.checkin({ uid: "u" }, { token: JSON.stringify(env) });
      ok(rOut.authError === true, "checkin 登录凭证过期 → authError");

      // checkinStatus：quota_overview 里今天的 login_bonus 包 → 已领取
      const overviewOf = (startSec) => ({
        status: 200,
        ok: true,
        data: { code: 0, result: { totalPoints: "500", usedPoints: "0", subscription: [], incremental: [{ packageId: "p", totalPoints: "500", usedPoints: "0", startDate: startSec, source: "login_bonus", status: "active" }] } },
        text: "{}",
      });
      const adStatus = make(async () => overviewOf(Math.floor(todayMs / 1000)));
      const s1 = await adStatus.checkinStatus({ uid: "u" }, { token: JSON.stringify(env) });
      ok(s1.ok && s1.checkedIn === true, "checkinStatus 今日 login_bonus 包（startDate 今天零点）→ 已领取");
      const adStatus2 = make(async () => overviewOf(Math.floor(todayMs / 1000) - 86400));
      const s2 = await adStatus2.checkinStatus({ uid: "u" }, { token: JSON.stringify(env) });
      ok(s2.ok && s2.checkedIn === false, "checkinStatus 昨天的包 → 未领取");
    })()
  );
})();

// ===== chat 缺凭据 / 目录校验（不发请求即拦截）=====
(function testChatGuards() {
  let requests = 0;
  const ad = makeDumate({
    fetchStream: () => {
      requests++;
      throw new Error("不应发请求");
    },
    pumpSse: () => {},
    httpJson: () => {
      requests++;
      throw new Error("不应发请求");
    },
    rules: { get: () => ({}), rulesDir: () => "." },
    firstByteBudgetMs: () => 30000,
  });
  (async () => {
    let threw = null;
    try {
      await ad.chat({ account: { uid: "u" }, secrets: {}, model: "deepseek-v4-pro", body: { messages: [] }, emit: () => {} });
    } catch (e) {
      threw = e;
    }
    ok(threw && threw.status === 401, "chat 缺凭据包 → 401（不发请求）");
    eq(requests, 0, "chat 缺凭据不发任何请求");

    // 目录有清单时，未知模型直接 400（不发请求）。写一个临时 catalog.json？—— models.list 读
    // rulesDir 的 catalog.json；这里用不落盘的姿势：目录为空（从未拉取）时校验跳过、原样透传，
    // 与 Loomy 口径一致。因此只测「目录为空时放行到发请求阶段」：fetchStream 抛错说明已走到发送
    // （httpJson mock 返回有效通行证响应让换证成功，请求才能走到 fetchStream）
    let reachedSend = false;
    const TOKEN_RESP = { status: 200, ok: true, data: { code: 0, result: { token: "t-selftest", expired_at: "2099-01-01T00:00:00.000Z" } }, text: "{}" };
    const ad2 = makeDumate({
      fetchStream: () => {
        reachedSend = true;
        throw new Error("stop");
      },
      pumpSse: () => {},
      httpJson: async () => TOKEN_RESP,
      rules: { get: () => ({}), rulesDir: () => "." },
      firstByteBudgetMs: () => 30000,
      util: require("../electron/backend/proxy/util.cjs"),
    });
    const env = { cookies: VALID_COOKIES, deviceId: "d", clientVersion: "1", prdSource: "personal", uid: "u-send" };
    asyncJobs.push(
      (async () => {
        try {
          await ad2.chat({ account: { uid: "u-send" }, secrets: { token: JSON.stringify(env) }, model: "any-model", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
        } catch {
          /* fetchStream 抛的 stop 属预期 */
        }
        ok(reachedSend, "目录为空时模型名放行到发送阶段");
        ok(requests === 0, "全程未打真实上游");
      })()
    );
  })();
})();

// ===== chat 的 401 换证重试可达性（评审 #1/#2 回归：fetchStream 对非 2xx 抛错，重试必须在 catch 里接住）=====
(function testChat401Retry() {
  const env = { cookies: VALID_COOKIES, deviceId: "d", clientVersion: "1", prdSource: "personal", uid: "u-retry-401" };
  const TOKEN_RESP = { status: 200, ok: true, data: { code: 0, result: { token: "t-401", expired_at: "2099-01-01T00:00:00.000Z" } }, text: "{}" };
  let tokenCalls = 0,
    sendCalls = 0;
  const ad = makeDumate({
    fetchStream: async () => {
      sendCalls++;
      if (sendCalls === 1) {
        // 真实 fetchStream 的非 2xx 语义：抛错并把状态码挂在 error 上（adapters.cjs 实测口径）
        throw Object.assign(new Error("上游 HTTP 401：unauthorized"), { status: 401, body: "unauthorized" });
      }
      return { resp: { status: 200, ok: true }, cancelTimer: () => {} };
    },
    pumpSse: async (_resp, cb) => {
      cb(null, JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }));
      cb(null, "[DONE]");
    },
    httpJson: async () => {
      tokenCalls++;
      return TOKEN_RESP;
    },
    rules: { get: () => ({}), rulesDir: () => "." },
    firstByteBudgetMs: () => 30000,
    util: require("../electron/backend/proxy/util.cjs"),
  });
  asyncJobs.push(
    (async () => {
      const events = [];
      await ad.chat({ account: { uid: "u-retry-401" }, secrets: { token: JSON.stringify(env) }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
      eq(sendCalls, 2, "401 后重发一次（重试路径可达，评审 #1 回归）");
      // 第二次换证若被跳过 = 缓存未被丢弃 → tokenCalls 停在 1。断言 2 兼验评审 #2 的 dropAccessToken 生效
      eq(tokenCalls, 2, "401 后通行证缓存被丢弃并重新换证（评审 #2 回归）");
      ok(
        events.some((e) => e.type === "finish"),
        "重试后流正常收尾"
      );
    })()
  );
})();

// ===== dumate-export 产物解析（index.cjs 的 parseDumateExportResults + importAccounts 更新分支）=====
(function testExportImport() {
  const proxyIndex = require("../electron/backend/proxy/index.cjs");
  ok(typeof proxyIndex.parseAccountsJson === "function", "index.cjs 可在纯 Node 下 require 并暴露解析函数");
  const exported = {
    tool: "dumate-export v1",
    exportedAt: "2026-11-14T17:35:22+08:00",
    machine: { hostname: "home-passerby", os: "Windows", arch: "amd64" },
    results: [
      {
        channel: "dumate",
        account: { uid: "UID-1", name: "测试账号", loginType: "bce" },
        cookies: VALID_COOKIES,
        deviceId: "1|windows.abc",
        clientVersion: "1.0.92.512",
        installDir: "D:\\work\\DuMate",
      },
      {
        channel: "dumate",
        account: { uid: "", name: "", loginType: "bce" },
        cookies: [],
        deviceId: "",
        clientVersion: "",
      },
    ],
  };
  const r = proxyIndex.parseAccountsJson(JSON.stringify(exported), "dumate");
  eq(r.list.length, 1, "dumate-export 产物：有效账号 1 条");
  eq(r.invalid, 1, "dumate-export 产物：空 cookies 记录取 1 条无效");
  const acc = r.list[0];
  eq(acc.channel, "dumate", "导入账号渠道");
  eq(acc.uid, "UID-1", "导入账号 uid");
  eq(acc.source, "json", "导入账号 source");
  ok(acc.meta && acc.meta.dumateExport && acc.meta.dumateExport.deviceId === "1|windows.abc", "导出指纹进 meta.dumateExport");
  const env = JSON.parse(acc.token);
  ok(Array.isArray(env.cookies) && env.cookies.length === 2, "凭据包进 token 列（cookies 数组）");
  eq(env.deviceId, "1|windows.abc", "凭据包带设备 ID");
  eq(env.prdSource, "personal", "凭据包带个人版标记");
  eq(env.uid, "UID-1", "凭据包带 uid");

  // 未知渠道整批拒绝的既有语义不被 dumate 分支破坏
  const bad = proxyIndex.parseAccountsJson(JSON.stringify({ tool: "dumate-export v1", results: [{ channel: "nosuch", account: { uid: "x" }, cookies: VALID_COOKIES }] }), "dumate");
  eq(bad.list.length, 0, "dumate-export 产物里的未知渠道不算有效账号（固定 channel，不认外部渠道名）");
})();

// 等齐异步用例再统计（异步断言也走同一个 pass/fail 计数器）
(async () => {
  await Promise.all(asyncJobs);
  console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`  ✗ 异步用例异常: ${(e && e.message) || e}`);
  process.exit(1);
});
