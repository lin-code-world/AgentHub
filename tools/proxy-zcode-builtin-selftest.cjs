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
    {
      // 无 modelMatch → 被 filter 掉
      modelMatch: "",
      config: { properties: { contextWindow: 500000 } },
    },
    null, // 空对象 → filter 掉
    {
      // 完整缺失 config
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
  eq(
    zb.pickLatestRelease([
      { origin: "builtin", revision: 43, raw: rel(43) },
      { origin: "stored", revision: 43, raw: rel(43) },
    ]).origin,
    "stored",
    "同 revision 优先 stored"
  );

  eq(
    zb.pickLatestRelease([
      { origin: "builtin", revision: 43, raw: rel(43) },
      { origin: "client", revision: 43, raw: rel(43) },
    ]).origin,
    "client",
    "同 revision builtin vs client → client"
  );

  eq(
    zb.pickLatestRelease([
      { origin: "client", revision: 43, raw: rel(43) },
      { origin: "stored", revision: 43, raw: rel(43) },
      { origin: "builtin", revision: 43, raw: rel(43) },
    ]).origin,
    "stored",
    "三源同 revision → stored"
  );

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

/** 假 fetch 的中止错误（与真实 fetch 被 signal 掐断时的形态一致） */
function abortErr() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** 慢速假 fetch：等 delayMs 再回响应；等待期间 signal 一旦 abort 就立刻抛 AbortError。
 *  （真实 fetch 尊重 signal；桩也必须尊重，否则"总预算被掐断"这类断言测不出来） */
function slowFetch(delayMs, makeResponse) {
  return async (url, init) => {
    const signal = init && init.signal;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (!signal) return;
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortErr());
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortErr());
        },
        { once: true }
      );
    });
    return String(url).includes("client/configs") ? okFirstHop() : makeResponse(url);
  };
}

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
  {
    // 超时是**本次更新的总预算**，两跳共享同一个 deadline（不是每跳各自 20s）：
    // 第一跳吃掉 40ms 后，第二跳必须被同一个 60ms deadline 掐断 → null。
    // 若按"每跳各自计时"实现，第二跳会拿到完整 60ms 预算而成功返回对象，本断言即失败。
    const f = slowFetch(40, () => jsonResponse(rel(44)));
    eq(await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f, timeoutMs: 60 }), null, `${t}53 两跳共享总预算 60ms：第一跳耗 40ms 后第二跳被掐断 → null`);
  }
  {
    // 共享预算下正常路径仍要能跑通（防止把 deadline 做得过紧误杀正常请求）
    const f = slowFetch(10, () => jsonResponse(rel(44)));
    const out = await zb.fetchRemoteRelease({ ...CONFIG, fetchImpl: f, timeoutMs: 500 });
    ok(out && out.revision === 44, `${t}54 共享总预算 500ms、两跳各 10ms → 正常返回 revision 44`);
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

// ===== 空 modelRules 必须整体拒绝（Critical：更新失败不得把已有能力写坏） =====
/** 构造指定 revision 与原始 modelRules 的 release（上游形状） */
function relWith(rev, list) {
  return { schemaVersion: 1, revision: rev, config: { modelConfigRules: { modelRules: list } } };
}

/** 取规则里能覆盖 GLM-5.3 的那条（与 resolveModelMeta 同口径：整串锚定 + 忽略大小写） */
function pickRule(rules, modelId) {
  for (const r of rules || []) {
    let re;
    try {
      re = new RegExp("^(?:" + r.re + ")$", "i");
    } catch {
      continue;
    }
    if (re.test(modelId)) return r;
  }
  return null;
}

function testEmptyRulesRejected(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-empty-"));
  const storedFile = paths.join(dir, "proxy", "zcode-builtin.json");
  const builtinFile = paths.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json");
  const deps = { storedFile, clientDirs: [], builtinFile };
  try {
    fsSync.mkdirSync(paths.dirname(storedFile), { recursive: true });
    fsSync.writeFileSync(storedFile, JSON.stringify(rel(43)), "utf8");
    zb.invalidateModelRules();

    // ① 空数组与"全是垃圾条目"都要在校验层被拒，且理由能区分是哪一种
    const emptyR = zb.validateRelease(relWith(100, []));
    eq(emptyR.ok, false, `${t}80 modelRules 为空数组 → 校验拒绝`);
    ok(/空数组/.test(emptyR.reason || ""), `${t}81 拒绝理由指明"空数组"`);
    const junkR = zb.validateRelease(relWith(100, [{ modelMatch: "" }, { config: {} }, null]));
    eq(junkR.ok, false, `${t}82 modelRules 全是无效条目 → 校验拒绝`);
    ok(/无效/.test(junkR.reason || ""), `${t}83 拒绝理由指明"全部无效"`);

    // ② 落盘层对任何调用方兜底：即便绕过校验直接喂进来也不写、文件一字未变
    const before = fsSync.readFileSync(storedFile, "utf8");
    ok(zb.writeStoredRelease(storedFile, relWith(100, []), [43]) === false, `${t}84 revision 很大但 modelRules 为空 → 拒绝落盘`);
    ok(zb.writeStoredRelease(storedFile, relWith(100, [{ modelMatch: "" }]), [43]) === false, `${t}85 revision 很大但条目全无效 → 拒绝落盘`);
    eq(fsSync.readFileSync(storedFile, "utf8"), before, `${t}86 被拒时落盘文件内容一字未变`);

    // ③ 已有能力值不能被弄坏：解析结果与兜底缓存都仍是原来那份
    const res = zb.resolveModelRules(deps);
    ok(res && res.revision === 43, `${t}87 被拒后解析仍拿到原 revision 43`);
    eq(res && res.origin, "stored", `${t}88 被拒后解析仍命中 stored 来源`);
    const glm = pickRule(zb.cachedModelRules(), "GLM-5.3");
    ok(glm !== null, `${t}89 兜底缓存里仍有 GLM-5.3 的规则`);
    eq(glm && glm.contextWindow, 1000000, `${t}90 兜底缓存 GLM-5.3 contextWindow 未被写坏`);
    eq(glm && glm.maxOutputTokens, 128000, `${t}91 兜底缓存 GLM-5.3 maxOutputTokens 未被写坏`);

    // ④ 合法 release 仍能正常落盘（拦截没误伤正常路径）
    const valid = rel(44);
    ok(zb.writeStoredRelease(storedFile, valid, [43]) === true, `${t}92 合法 release（有规则）仍能落盘`);
    eq(JSON.parse(fsSync.readFileSync(storedFile, "utf8")).revision, 44, `${t}93 合法 release 落盘内容为新 revision`);

    // ⑤ 目标文件不存在时被拒，且不会先把文件建出来
    const fresh = paths.join(dir, "fresh", "zcode-builtin.json");
    ok(zb.writeStoredRelease(fresh, relWith(100, []), [43]) === false, `${t}94 空规则 + 目标不存在 → 拒绝`);
    ok(!fsSync.existsSync(fresh), `${t}95 拒绝时连文件都不该建`);
  } finally {
    zb.invalidateModelRules();
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 规则非空、但没有一条给出能力值时必须拒绝（Critical 同类路径） =====
// 为什么这条不能省：条目有 modelMatch、缺 config 时映射后 re 仍在、能力字段全 undefined，
// 这种 release 的 revision 一样能很大，一旦采纳照样把内置副本整份压住，能力全部退化。
function testNoCapabilityRejected(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-nocap-"));
  const storedFile = paths.join(dir, "proxy", "zcode-builtin.json");
  const builtinFile = paths.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json");
  const deps = { storedFile, clientDirs: [], builtinFile };
  try {
    fsSync.mkdirSync(paths.dirname(storedFile), { recursive: true });
    fsSync.writeFileSync(storedFile, JSON.stringify(rel(43)), "utf8");
    zb.invalidateModelRules();

    // ① 校验层：只有 match、没有 config 的条目（含"空格 match"这种变体）一律拒绝
    const noCfgR = zb.validateRelease(relWith(100, [{ modelMatch: " " }]));
    eq(noCfgR.ok, false, `${t}108 有 modelMatch 但无 config（无能力字段）→ 校验拒绝`);
    ok(/能力值/.test(noCfgR.reason || ""), `${t}109 拒绝理由指明"没有一条规则给出能力值"`);
    eq(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*" }])).ok, false, `${t}110 带真实模型名但同样无 config → 校验拒绝`);
    // 多条目全无能力同样拒绝（不是"只要条数够就放行"）
    eq(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*" }, { modelMatch: ".*doubao.*" }])).ok, false, `${t}111 多条都无能力字段 → 校验拒绝`);

    // ② 反向：只要有一条规则给出任意一项能力就算有效（官方数据里就有只补单项的规则）
    ok(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*", config: { properties: { contextWindow: 1000 } } }])).ok === true, `${t}112 仅 contextWindow 一条能力 → 校验通过`);
    ok(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*", config: { optionSpecs: { maxOutputTokens: { max: 4096 } } } }])).ok === true, `${t}113 仅 maxOutputTokens 一条能力 → 校验通过`);
    ok(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*", config: { properties: { inputFormat: { supportsImage: true } } } }])).ok === true, `${t}114 仅 inputFormat 一条能力 → 校验通过`);
    // 混在里面的纯 match 条目不该连累整份 release（只要求"至少一条"）
    ok(zb.validateRelease(relWith(100, [{ modelMatch: ".*glm.*" }, { modelMatch: ".*doubao.*", config: { properties: { contextWindow: 1000 } } }])).ok === true, `${t}115 有一条给能力、另一条只给 match → 整体仍通过`);

    // ③ 落盘层兜底：即便绕过校验，也不写、文件一字未变，原有能力值不变
    const before = fsSync.readFileSync(storedFile, "utf8");
    ok(zb.writeStoredRelease(storedFile, relWith(100, [{ modelMatch: ".*glm.*" }]), [43]) === false, `${t}116 revision 很大但规则都不给能力 → 拒绝落盘`);
    ok(zb.writeStoredRelease(storedFile, relWith(100, [{ modelMatch: " " }]), [43]) === false, `${t}117 空格 match 无 config → 拒绝落盘`);
    eq(fsSync.readFileSync(storedFile, "utf8"), before, `${t}118 被拒时落盘文件内容一字未变`);
    const res = zb.resolveModelRules(deps);
    eq(res && res.revision, 43, `${t}119 被拒后解析仍拿到原 revision 43`);
    const glm = pickRule(zb.cachedModelRules(), "GLM-5.3");
    eq(glm && glm.contextWindow, 1000000, `${t}120 兜底缓存 GLM-5.3 contextWindow 仍是 1000000`);
    eq(glm && glm.maxOutputTokens, 128000, `${t}121 兜底缓存 GLM-5.3 maxOutputTokens 仍是 128000`);
  } finally {
    zb.invalidateModelRules();
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 缓存 key 必须带文件路径（不同来源指向不同文件、mtime 同毫秒不能串味） =====
function testCacheKeyIncludesPath(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-cachekey-"));
  try {
    const fileA = paths.join(dir, "a.json");
    const fileB = paths.join(dir, "b.json");
    const rawB = rel(61);
    rawB.config.modelConfigRules.modelRules[0].config.properties.contextWindow = 777777;
    fsSync.writeFileSync(fileA, JSON.stringify(rel(60)), "utf8");
    fsSync.writeFileSync(fileB, JSON.stringify(rawB), "utf8");
    // 两份文件 mtime 落到同一毫秒：旧 key（label + mtime）完全相同，第二次会吃第一次的结论
    const stamp = new Date(1600000000000);
    fsSync.utimesSync(fileA, stamp, stamp);
    fsSync.utimesSync(fileB, stamp, stamp);
    eq(fsSync.statSync(fileA).mtimeMs, fsSync.statSync(fileB).mtimeMs, `${t}96 两份文件 mtime 相同（前提成立）`);

    zb.invalidateModelRules();
    const resA = zb.resolveModelRules({ storedFile: fileA, clientDirs: [], builtinFile: "" });
    eq(resA && resA.revision, 60, `${t}97 先解析 A 得到 60`);
    const resB = zb.resolveModelRules({ storedFile: fileB, clientDirs: [], builtinFile: "" });
    eq(resB && resB.revision, 61, `${t}98 换成同 mtime 的另一份文件 B → 必须重新解析得到 61（不串味）`);
    eq(pickRule(resB && resB.rules, "GLM-5.3").contextWindow, 777777, `${t}99 解析 B 拿到的是 B 自己的能力值`);
  } finally {
    zb.invalidateModelRules();
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 三来源 deps 只有一份口径（zcodeBuiltin.defaultRulesDeps，zcodeLocal 直接复用） =====
function testDefaultRulesDeps(t, zb) {
  const dir = fsSync.mkdtempSync(paths.join(os.tmpdir(), "zcode-deps-"));
  const savedData = process.env.AGENTHUB_DATA_DIR;
  const savedV2 = process.env.ZCODE_V2_DIR;
  process.env.AGENTHUB_DATA_DIR = paths.join(dir, "data");
  process.env.ZCODE_V2_DIR = paths.join(dir, "v2");
  try {
    ok(typeof zb.defaultRulesDeps === "function", `${t}100 应导出 defaultRulesDeps`);
    const deps = zb.defaultRulesDeps();
    eq(deps.storedFile, paths.join(process.env.AGENTHUB_DATA_DIR, "proxy", "zcode-builtin.json"), `${t}101 storedFile 落在 dataDir()/proxy/zcode-builtin.json`);
    eq(deps.builtinFile, paths.join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json"), `${t}102 builtinFile 指向仓库内置副本`);
    ok(fsSync.existsSync(deps.builtinFile), `${t}103 内置副本文件真实存在`);
    ok(Array.isArray(deps.clientDirs), `${t}104 clientDirs 是数组`);
    eq(deps.clientDirs, [paths.join(process.env.ZCODE_V2_DIR, "runtime", "provider")], `${t}105 clientDirs 为 ZCODE_V2_DIR/runtime/provider`);

    // zcodeLocal 必须复用同一组 deps：把一份能力值特殊的副本放到 storedFile，
    // 若两处各自拼路径（漏改一处），这里就读不到它
    const own = rel(70);
    own.config.modelConfigRules.modelRules = [
      {
        modelMatch: ".*glm-5\\.3-own.*",
        config: { properties: { contextWindow: 123456, inputFormat: { supportsImage: true } }, optionSpecs: { maxOutputTokens: { max: 6543 } } },
      },
    ];
    fsSync.mkdirSync(paths.dirname(deps.storedFile), { recursive: true });
    fsSync.writeFileSync(deps.storedFile, JSON.stringify(own), "utf8");
    zb.invalidateModelRules();
    const zcodeLocal = require(paths.join(__dirname, "..", "electron", "backend", "proxy", "zcodeLocal.cjs"));
    const meta = zcodeLocal.resolveModelMeta("GLM-5.3-own");
    eq(meta && meta.contextWindow, 123456, `${t}106 zcodeLocal 与更新器看到同一份 storedFile（窗口）`);
    eq(meta && meta.maxOutputTokens, 6543, `${t}107 zcodeLocal 与更新器看到同一份 storedFile（上限）`);
  } finally {
    zb.invalidateModelRules();
    if (savedData === undefined) delete process.env.AGENTHUB_DATA_DIR;
    else process.env.AGENTHUB_DATA_DIR = savedData;
    if (savedV2 === undefined) delete process.env.ZCODE_V2_DIR;
    else process.env.ZCODE_V2_DIR = savedV2;
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
    await testEmptyRulesRejected("emptyRules ", zb);
    await testNoCapabilityRejected("noCapability ", zb);
    await testCacheKeyIncludesPath("cacheKey ", zb);
    await testDefaultRulesDeps("defaultRulesDeps ", zb);
  } catch (e) {
    fail++;
    console.log(`  ✗ 测试脚本异常：${(e && e.stack) || e}`);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
