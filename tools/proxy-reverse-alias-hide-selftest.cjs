/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-08
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 反向映射吸收的原生真名：对外隐藏与拒绝直连
// 用法：node tools/proxy-reverse-alias-hide-selftest.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-rev-alias-hide-"));
process.env.AGENTHUB_DATA_DIR = tmp;

const adapters = require(path.join(ROOT, "electron/backend/proxy/adapters.cjs"));

let fail = 0;
const eq = (a, e, l) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) { fail++; console.log(`FAIL ${l}\n 期望 ${JSON.stringify(e)}\n 实际 ${JSON.stringify(a)}`); }
  else console.log(`ok  ${l}`);
};
const check = (l, cond, extra) => { if (cond) console.log(`ok  ${l}`); else { fail++; console.log(`FAIL ${l}${extra ? " — " + extra : ""}`); } };

const withChannels = (fake, fn) => {
  const orig = { ...adapters.ADAPTERS };
  try {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, fake);
    return fn();
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, orig);
  }
};

// [1] 吸收判据 + 请求归属
withChannels({ workbuddy: { models: () => ["hy4free", "GLM-5.3-Flash", "glm-5.3"] }, zcode: { models: () => ["glm-5.3-flash"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" }, "glm-5.3-flash": { workbuddy: "GLM-5.3-Flash" }, "glm-5.3": { workbuddy: "glm-5.3" } } };
  eq(adapters.absorbedByAlias("hy4free", "workbuddy", cfg), true, "hy4free 被 hy4 占用");
  eq(adapters.absorbedByAlias("hy4free", "zcode", cfg), false, "zcode 没占用 hy4free");
  eq(adapters.absorbedByAlias("glm-5.3", "workbuddy", cfg), false, "恒等映射不算吸收");
  eq(adapters.modelOwners("hy4free", cfg), [], "被吸收真名：无归属");
  check("统一名 hy4 仍归属 workbuddy", adapters.modelOwners("hy4", cfg).includes("workbuddy"));
  eq(adapters.modelOwners("GLM-5.3-Flash", cfg), [], "仅大小写不同的真名也被吸收");
  check("统一名 glm-5.3-flash 归属含 zcode", adapters.modelOwners("glm-5.3-flash", cfg).includes("zcode"));
});

// [2] 对外清单：唯一来源被吸收 → 整行隐藏；另有来源 → 保留
withChannels({ workbuddy: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  const ids = adapters.listableModels(cfg).map((m) => m.id);
  check("统一名 hy4 在对外清单", ids.includes("hy4"));
  check("唯一来源被吸收 → hy4free 不在对外清单", !ids.includes("hy4free"));
});
withChannels({ workbuddy: { models: () => ["hy4free"] }, catpaw: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  const row = adapters.listableModels(cfg).find((m) => m.id === "hy4free");
  check("仍有其它来源 → hy4free 保留", !!row);
  eq(row && row.sources, ["catpaw"], "被吸收的来源 workbuddy 被剔除");
});

// [3] 别的渠道同名原生、未映射 → 归属保留
withChannels({ workbuddy: { models: () => ["hy4free"] }, catpaw: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  eq(adapters.modelOwners("hy4free", cfg), ["catpaw"], "另一渠道同名原生保留归属");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 句柄交给系统 */ }
if (fail) { console.log(`\n结果：${fail} 失败`); process.exit(1); }
console.log("\n结果：全部通过");
process.exit(0);
