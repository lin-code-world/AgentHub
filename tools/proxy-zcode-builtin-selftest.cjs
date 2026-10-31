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
// 反代网关 · ZCode 模型能力数据来源选择与校验纯函数自测（离线可跑，不打真上游、不读真客户端）
// 覆盖：validateRelease（schemaVersion / revision / modelRules 结构校验 + 规则映射）、
//       pickLatestRelease（revision 降序 + 同 revision 来源优先级）、URL 构造、缓存。
"use strict";

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

const zb = require("../electron/backend/proxy/zcodeBuiltin.cjs");

// ===== 合成样本：revision 43 的合法 release =====
function rel(rev) {
  return {
    schemaVersion: 1,
    revision: rev,
    config: {
      modelConfigRules: {
        modelRules: [
          {
            modelMatch: ".*glm-5\\.3",
            config: {
              properties: { contextWindow: 1000000, inputFormat: { supportsImage: true } },
              optionSpecs: { maxOutputTokens: { max: 128000 } },
            },
          },
          {
            modelMatch: ".*doubao",
            config: {
              properties: { contextWindow: 128000 },
              optionSpecs: {},
            },
          },
        ],
      },
    },
  };
}

// ===== mapModelRules 直接断言（确认共享函数的形状语义本身） =====
(function testMapModelRules() {
  const input = [
    {
      modelMatch: ".*glm-5\\.3",
      config: {
        properties: { contextWindow: 1000000, inputFormat: { supportsImage: true } },
        optionSpecs: { maxOutputTokens: { max: 128000 } },
      },
    },
    { // 无 modelMatch → 被 filter 掉
      modelMatch: "",
      config: { properties: { contextWindow: 500000 } },
    },
    null, // 空对象 → filter 掉
    { // 完整缺失 config
      modelMatch: ".*foo",
      config: undefined,
    },
  ];
  const out = zb.mapModelRules(input);
  eq(out.length, 2, "只有两条有 modelMatch 的规则留下");
  eq(out[0].re, ".*glm-5\\.3", "第一条 re");
  eq(out[0].contextWindow, 1000000, "第一条 contextWindow");
  eq(out[0].maxOutputTokens, 128000, "第一条 maxOutputTokens");
  ok(out[0].fmt && out[0].fmt.supportsImage === true, "第一条 fmt");
  eq(out[1].re, ".*foo", "第二条 re");
  eq(out[1].contextWindow, undefined, "缺失 config → contextWindow undefined");
  eq(out[1].maxOutputTokens, undefined, "缺失 config → maxOutputTokens undefined");
  eq(out[1].fmt, null, "缺失 config → fmt null");
  // 非数组输入安全降级
  eq(zb.mapModelRules(null), [], "null 输入返回空数组");
  eq(zb.mapModelRules(undefined), [], "undefined 输入返回空数组");
  eq(zb.mapModelRules({}), [], "对象输入返回空数组");
})();

// ===== validateRelease =====
(function testValidateRelease() {
  const r = zb.validateRelease(rel(43));
  eq(r.ok, true, "合法 release 通过校验");
  eq(r.release.revision, 43, "revision 透传");
  eq(r.release.schemaVersion, 1, "schemaVersion 透传");

  eq(zb.validateRelease({ schemaVersion: 2, revision: 1, config: {} }).ok, false, "schemaVersion 非 1 拒绝");
  eq(zb.validateRelease({ schemaVersion: 1, revision: 0, config: {} }).ok, false, "revision 非正整数拒绝");
  eq(zb.validateRelease({ schemaVersion: 1, revision: -5, config: {} }).ok, false, "revision 负数拒绝");
  eq(zb.validateRelease({ schemaVersion: 1, revision: 2, config: {} }).ok, false, "modelRules 非数组拒绝");
  eq(zb.validateRelease(null).ok, false, "null 输入拒绝");
  eq(zb.validateRelease(undefined).ok, false, "undefined 输入拒绝");
  eq(zb.validateRelease("string").ok, false, "字符串输入拒绝");
})();

// ===== 规则映射形状（与 zcodeLocal.readClientModelRules 口径一致） =====
(function testRuleMapping() {
  const rules = zb.validateRelease(rel(43)).release.modelRules;
  eq(rules.length, 2, "两条规则都映射出来");

  // 第一条：glm-5.3
  eq(rules[0].re, ".*glm-5\\.3", "re 字段来自 modelMatch");
  eq(rules[0].contextWindow, 1000000, "contextWindow 来自 properties");
  eq(rules[0].maxOutputTokens, 128000, "maxOutputTokens 来自 optionSpecs.maxOutputTokens.max");
  ok(rules[0].fmt && rules[0].fmt.supportsImage === true, "fmt 来自 properties.inputFormat");

  // 第二条：doubao（无 optionSpecs.maxOutputTokens → undefined）
  eq(rules[1].re, ".*doubao", "第二条 re");
  eq(rules[1].contextWindow, 128000, "第二条 contextWindow");
  eq(rules[1].maxOutputTokens, undefined, "无 maxOutputTokens 时为 undefined");
  eq(rules[1].fmt, null, "无 inputFormat 时 fmt 为 null");
})();

// ===== pickLatestRelease =====
(function testPickLatest() {
  // 取 revision 最大
  const picked1 = zb.pickLatestRelease([
    { origin: "stored", revision: 40, raw: rel(40) },
    { origin: "builtin", revision: 43, raw: rel(43) },
  ]);
  eq(picked1.revision, 43, "取最大 revision");
  eq(picked1.origin, "builtin", "最大 revision 者的 origin");

  // 同 revision：stored(0) > client(1) > builtin(2)
  eq(zb.pickLatestRelease([
    { origin: "builtin", revision: 43, raw: rel(43) },
    { origin: "stored", revision: 43, raw: rel(43) },
  ]).origin, "stored", "同 revision 优先 stored");

  eq(zb.pickLatestRelease([
    { origin: "builtin", revision: 43, raw: rel(43) },
    { origin: "client", revision: 43, raw: rel(43) },
  ]).origin, "client", "同 revision builtin vs client → client");

  eq(zb.pickLatestRelease([
    { origin: "client", revision: 43, raw: rel(43) },
    { origin: "stored", revision: 43, raw: rel(43) },
    { origin: "builtin", revision: 43, raw: rel(43) },
  ]).origin, "stored", "三源同 revision → stored");

  // 空输入
  eq(zb.pickLatestRelease([]), null, "空数组返回 null");
})();

// ===== URL 构造 =====
(function testBuildUrl() {
  const url = zb.buildClientConfigsUrl("https://zcode.z.ai/api/v1/client/configs", "4.1.10", "win32-x64");
  ok(url.includes("app_version=4.1.10"), "URL 带 app_version");
  ok(url.includes("platform=win32-x64"), "URL 带 platform");
  ok(url.startsWith("https://zcode.z.ai/api/v1/client/configs"), "URL 保留基础路径");

  // 基础 URL 带尾斜杠时也正确拼接
  const url2 = zb.buildClientConfigsUrl("https://example.com/", "1.0.0", "darwin-arm64");
  ok(url2.includes("app_version=1.0.0"), "尾斜杠 URL 也带 app_version");
})();

// ===== cachedModelRules / invalidateModelRules =====
(function testCached() {
  eq(zb.cachedModelRules(), [], "初始缓存为空数组");
  ok(typeof zb.invalidateModelRules === "function", "应导出 invalidateModelRules（唯一显式失效入口）");
  ok(zb.setCachedModelRules === undefined, "setCachedModelRules 已移除，避免与 invalidateModelRules 状态分裂");
  zb.invalidateModelRules();
  eq(zb.cachedModelRules(), [], "失效后缓存仍为空数组（幂等、不抛错）");
})();

// ===== 仓库内置副本可用 =====
(function testBuiltinAsset() {
  const builtin = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json"), "utf8"));
  eq(zb.validateRelease(builtin).ok, true, "仓库内置副本通过校验");
  ok(builtin.revision >= 43, "内置副本 revision 不低于实测基线 43");
})();

// ===== Task 4：远端拉取 / 落盘 / 定时更新（全集假 fetch，不联网、不打真上游） =====
const os = require("node:os");
const paths = require("node:path");
const fsSync = require("node:fs");

const INNER_URL = "https://cdn.zcode.z.ai/configs/builtin.json";
const CONFIG = { clientConfigsUrl: "https://zcode.z.ai/api/v1/client/configs", appVersion: "4.1.10", platform: "win32-x64" };

/** 合成 Response（真实 Response 对象，数据全在内存） */
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
}

/** 两跳假 fetch：第一跳（client/configs）回 firstBody，其余 URL 回 innerBody；记录每次请求 URL */
function twoHopFetch(firstBody, innerBody) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return String(url).includes("client/configs") ? firstBody : innerBody;
  };
  fn.calls = calls;
  return fn;
}

const okFirstHop = () => jsonResponse({ code: 0, data: { configs: { builtin_provider_config_json: INNER_URL } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ⑥⑦ 落盘拒绝/采纳（临时目录，不碰用户数据） */
function testWriteStored(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-write-"));
  const file = paths.join(dir, "proxy", "zcode-builtin.json");
  try {
    ok(zb.writeStoredRelease(file, rel(44), [45]) === false, `${t}60 不比现有来源新 → false`);
    ok(!fsSync.existsSync(file), `${t}61 被拒时连文件都不该建`);
    ok(zb.writeStoredRelease(file, rel(45), [45]) === false, `${t}62 与现有来源同 revision 也不写`);
    ok(zb.writeStoredRelease(file, rel(45), [43]) === true, `${t}63 比现有来源新 → true`);
    const before = fsSync.readFileSync(file, "utf8");
    ok(zb.writeStoredRelease(file, rel(44), [45]) === false, `${t}64 更旧 revision → false`);
    eq(fsSync.readFileSync(file, "utf8"), before, `${t}65 被拒时文件内容一字未变`);
    ok(zb.writeStoredRelease(file, rel(46), [45]) === true, `${t}66 更新 → true`);
    eq(JSON.parse(fsSync.readFileSync(file, "utf8")).revision, 46, `${t}67 文件内容为新 revision`);
    ok(zb.validateRelease(JSON.parse(fsSync.readFileSync(file, "utf8"))).ok, `${t}68 落盘内容仍是上游原始形状（stored 来源可直接读）`);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

/** ④①②③⑤ 远端拉取的两跳请求与畸形拒绝 */
async function testRemoteFetch(t, zb) {
  {
    const f = twoHopFetch(jsonResponse({ code: 7, data: {} }), jsonResponse(rel(44)));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f }), null, `${t}40 业务码非 0 → null`);
    eq(f.calls.length, 1, `${t}41 业务码非 0 时不发第二跳`);
  }
  {
    const f = twoHopFetch(jsonResponse({ code: 0, data: { configs: {} } }), jsonResponse(rel(44)));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f }), null, `${t}42 缺内置配置字段 → null`);
  }
  {
    const bad = rel(44);
    bad.schemaVersion = 2;
    const f = twoHopFetch(okFirstHop(), jsonResponse(bad));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f }), null, `${t}43 下载体 schemaVersion 非 1 → null`);
    eq(f.calls.length, 2, `${t}44 畸形体在校验下载体时才被拒（走了两跳）`);
  }
  {
    const f = twoHopFetch(okFirstHop(), jsonResponse(rel(44)));
    const out = await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f });
    ok(out && out.revision === 44, `${t}45 正常两跳返回 revision 44 的 release`);
    eq(f.calls.length, 2, `${t}46 正常路径正好两跳`);
    ok(f.calls[0].includes("app_version=4.1.10") && f.calls[0].includes("platform=win32-x64"), `${t}47 第一跳带版本与平台参数`);
    eq(f.calls[1], INNER_URL, `${t}48 第二跳取内置配置 URL`);
  }
  {
    const f = twoHopFetch(okFirstHop(), jsonResponse(rel(44)));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, clientConfigsUrl: "https://u:p@zcode.z.ai/api/v1/client/configs", fetchImpl: f }), null, `${t}49 带用户名密码的 URL → null`);
    eq(f.calls.length, 0, `${t}50 带用户名密码时一次请求都不发`);
  }
  {
    // 网络异常（非 abort）一律转 null 且不外泄：更新循环绝不能因一次抖动中断
    const orig = console.warn;
    console.warn = () => {};
    try {
      const boom = async () => {
        throw new Error("boom");
      };
      eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: boom }), null, `${t}51 fetch 抛异常 → null（不抛给调用方）`);
    } finally {
      console.warn = orig;
    }
  }
  {
    // 超大响应体：content-length 超限时不读正文
    const big = new Response("x", { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } });
    const f = twoHopFetch(big, jsonResponse(rel(44)));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f }), null, `${t}52 第一跳超 10MB → null`);
  }
}

/** ⑧⑨⑩ 定时更新：延迟首拉、成功后失效缓存、失败保留旧数据、stopUpdater 彻底停 */
async function testUpdater(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-updater-"));
  const deps = {
    storedFile: paths.join(dir, "proxy", "zcode-builtin.json"),
    clientDirs: [],
    builtinFile: paths.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json"),
  };
  try {
    const f = twoHopFetch(okFirstHop(), jsonResponse(rel(44)));
    zb.startUpdater({ getConfig: () => CONFIG, fetchImpl: f, deps, initialDelayMs: 10, successMs: 40 });
    await sleep(150);
    eq(JSON.parse(fsSync.readFileSync(deps.storedFile, "utf8")).revision, 44, `${t}70 启动延迟后拉取并落盘 revision 44`);
    const resolved = zb.resolveModelRules(deps);
    eq(resolved.origin, "stored", `${t}71 落盘后解析命中 stored 来源`);
    eq(resolved.revision, 44, `${t}72 落盘后解析拿到新数据（成功即失效缓存）`);
    ok(f.calls.length >= 2, `${t}73 成功后按成功间隔继续调度下一轮`);
    zb.stopUpdater();
    const after = f.calls.length;
    await sleep(120);
    eq(f.calls.length, after, `${t}74 stopUpdater 后定时器与在途流程全停，不再发请求`);

    // 失败退避：静默保留旧数据、不抛错、不改落盘副本
    const orig = console.warn;
    console.warn = () => {};
    try {
      const boom = async () => {
        throw new Error("boom");
      };
      zb.startUpdater({ getConfig: () => CONFIG, fetchImpl: boom, deps, initialDelayMs: 5, failBaseMs: 10, failMaxMs: 20 });
      await sleep(80);
      zb.stopUpdater();
    } finally {
      console.warn = orig;
    }
    eq(JSON.parse(fsSync.readFileSync(deps.storedFile, "utf8")).revision, 44, `${t}75 持续失败不回退落盘副本（仍是 44）`);

    // 无配置时不发请求（配置热加载后自然恢复）
    const f2 = twoHopFetch(okFirstHop(), jsonResponse(rel(45)));
    zb.startUpdater({ getConfig: () => ({}), fetchImpl: f2, deps, initialDelayMs: 5, failBaseMs: 10 });
    await sleep(60);
    zb.stopUpdater();
    eq(f2.calls.length, 0, `${t}76 未配置 clientConfigsUrl 时不发请求`);
  } finally {
    zb.stopUpdater();
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  try {
    // RED 阶段：函数不存在时给出可读的失败信息，而不是 TypeError 直接崩掉
    ok(typeof zb.fetchRemoteRelease === "function", "应导出 fetchRemoteRelease");
    ok(typeof zb.writeStoredRelease === "function", "应导出 writeStoredRelease");
    ok(typeof zb.startUpdater === "function", "应导出 startUpdater");
    ok(typeof zb.stopUpdater === "function", "应导出 stopUpdater");
    if (fail) {
      console.log(`\n结果：${pass} 通过 / ${fail} 失败（前置断言未通过，跳过后续用例）`);
      process.exit(1);
    }
    await testWriteStored("writeStoredRelease ", zb);
    await testRemoteFetch("fetchRemoteRelease ", zb);
    await testUpdater("updater ", zb);
  } catch (e) {
    fail++;
    console.log(`  ✗ 测试脚本异常：${(e && e.stack) || e}`);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
