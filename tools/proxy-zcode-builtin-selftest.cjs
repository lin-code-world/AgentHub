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

// ===== cachedModelRules =====
(function testCached() {
  eq(zb.cachedModelRules(), [], "初始缓存为空数组");
})();

// ===== 仓库内置副本可用 =====
(function testBuiltinAsset() {
  const builtin = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "electron", "backend", "proxy", "assets", "zcode-builtin.json"), "utf8"));
  eq(zb.validateRelease(builtin).ok, true, "仓库内置副本通过校验");
  ok(builtin.revision >= 43, "内置副本 revision 不低于实测基线 43");
})();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
