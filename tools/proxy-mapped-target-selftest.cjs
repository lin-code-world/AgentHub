/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 反向映射目标被禁用时的路由判定自测
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-mapped-target-selftest.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-mapped-target-"));
process.env.AGENTHUB_DATA_DIR = tmp;

const adapters = require(path.join(ROOT, "electron/backend/proxy/adapters.cjs"));
const { resolveChannel, mappedTargetDisabledMessage, mappedTargetDisabledReply, resolveCustomParams } = require(path.join(ROOT, "electron/backend/proxy/server.cjs"));

let fail = 0;
const eq = (a, e, l) => { if (JSON.stringify(a) !== JSON.stringify(e)) { fail++; console.log(`FAIL ${l}\n 期望 ${JSON.stringify(e)}\n 实际 ${JSON.stringify(a)}`); } else console.log(`ok  ${l}`); };
const check = (l, cond, extra) => { if (cond) console.log(`ok  ${l}`); else { fail++; console.log(`FAIL ${l}${extra ? " — " + extra : ""}`); } };

const orig = { ...adapters.ADAPTERS };
try {
  for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
  Object.assign(adapters.ADAPTERS, {
    workbuddy: { models: () => ["deepseek-v4.1-flash"] },
    loomy: { models: () => ["DeepSeek-V4.1-Flash"] },
  });
  const cfg = {
    channelEnabled: {},
    disabledModels: ["DeepSeek-V4.1-Flash"],
    modelReverseAliases: { "deepseek-v4.1-flash": { loomy: "DeepSeek-V4.1-Flash" } },
  };

  console.log("[1] 绑定渠道命中已禁用的映射目标");
  const bound = resolveChannel({ route: "loomy" }, "deepseek-v4.1-flash", cfg);
  eq(bound, { channel: null, disabledMappedTarget: { model: "deepseek-v4.1-flash", channel: "loomy", target: "DeepSeek-V4.1-Flash" } }, "返回禁用状态而不是路由到该渠道");

  console.log("[2] auto 回落到其他渠道");
  const auto = resolveChannel({ route: "auto" }, "deepseek-v4.1-flash", cfg);
  eq(auto.channel, "workbuddy", "跳过 loomy 落到 workbuddy");

  console.log("[3] 无候选时的专用文案");
  const msg = mappedTargetDisabledMessage("deepseek-v4.1-flash", cfg);
  check("文案点明映射目标", msg.includes("DeepSeek-V4.1-Flash"), msg);
  check("文案点明已关闭", msg.includes("已关闭"), msg);
  const soleCfg = { ...cfg, channelEnabled: { workbuddy: false } };
  const only = resolveChannel({ route: "auto" }, "deepseek-v4.1-flash", soleCfg);
  eq(only.unknownModel, true, "无任何候选时走 unknownModel");

  console.log("[4] 无候选时的专用 400 回复");
  eq(mappedTargetDisabledReply("deepseek-v4.1-flash", cfg), null, "仍有候选渠道时不用专用回复");
  const reply = mappedTargetDisabledReply("deepseek-v4.1-flash", soleCfg);
  eq(reply && reply.status, 400, "无候选时返回 400");
  eq(reply && reply.code, "mapped_target_disabled", "业务码 mapped_target_disabled");
  check("回复文案点明映射目标", !!(reply && reply.message.includes("DeepSeek-V4.1-Flash")), reply && reply.message);

  console.log("[5] 自定义参数按实际模型 + 渠道取值");
  const s = {
    modelCustomByChannel: {
      "DeepSeek-V4.1-Flash": { loomy: { contextLength: 300000 } },
      "deepseek-v4.1-flash": { workbuddy: { contextLength: 200000 } },
    },
    modelCustom: { "deepseek-v4.1-flash": { reasoningEffort: "medium" } },
  };
  eq(resolveCustomParams("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "loomy", s), { contextLength: 300000 }, "实际模型 + 渠道优先");
  eq(resolveCustomParams("deepseek-v4.1-flash", "deepseek-v4.1-flash", "workbuddy", s), { contextLength: 200000 }, "请求模型 + 渠道");
  eq(resolveCustomParams("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "trae", s), { reasoningEffort: "medium" }, "回落旧模型级配置");
  eq(
    resolveCustomParams("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "loomy", { ...s, modelCustomByChannel: { "deepseek-v4.1-flash": { loomy: { contextLength: 1 } } } }),
    { contextLength: 1 },
    "大小写逐字：大写键不命中走小写键"
  );
} finally {
  for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
  Object.assign(adapters.ADAPTERS, orig);
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 句柄未释放交给系统清理 */ }
if (fail) { console.log(`\n结果：${fail} 失败`); process.exit(1); }
console.log("\n结果：全部通过");
process.exit(0);
