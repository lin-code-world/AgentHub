/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-01
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 「输入过大跳更大上下文渠道」自测（离线可跑，不打真上游）
// 覆盖：① 剩余候选渠道按上下文声明降序重排（reorderQueueByContext 纯函数）；
// ② prompt_too_long 的渠道跳转标记（channelSwitchable，switchable 保持 false）；
// ③ 渠道×模型的有效上下文声明口径（channelModelContext：渠道自定义 > 模型级 > 渠道目录，反向映射按映射名查）。
// 行为背景见 server.cjs 的 prompt_too_long 分类注释；集成行为由黄金基线
// prompt-overflow-jump-channel / prompt-overflow-all-fail / prompt-overflow-stream-jump 三场景守。
//
// 用法：node tools/proxy-overflow-failover-selftest.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-overflow-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%
if (!process.env.AGENTHUB_DATA_DIR) process.env.AGENTHUB_DATA_DIR = tmp;

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

/** 沙箱目录用完即删：sqlite / watcher 句柄可能仍占用目录，删不掉不影响退出码 */
function cleanup() {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 句柄未释放时留给系统临时目录清理 */
  }
}

(async () => {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  store.open();
  // 沙箱目录：同名模型在两个渠道声明不同上下文（全部渠道视图合并行「报最大值」的数据前提）
  fs.writeFileSync(
    path.join(rules.rulesDir(), "catalog.json"),
    JSON.stringify({
      workbuddy: { syncedAt: Date.now(), models: [{ id: "model-x", name: "Model X", contextLength: 131072 }] },
      workbuddy_ai: { syncedAt: Date.now(), models: [{ id: "model-x", name: "Model X", contextLength: 1048576 }] },
    }),
    "utf8"
  );
  rules.reload("catalog.json");

  const server = require("../electron/backend/proxy/server.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  // ===== 1. reorderQueueByContext：剩余候选按上下文声明降序 =====
  {
    const ctx = { a: 1, b: 200, c: 1000, d: 50 };
    const q = ["a", "b", "c", "d"];
    server.reorderQueueByContext(q, 1, (ch) => ctx[ch]);
    eq(q, ["a", "c", "b", "d"], "startIdx 之前（已试渠道）不动，剩余按声明降序");
  }
  {
    const ctx = { a: 1, b: 0, c: 0, d: 500 };
    const q = ["a", "b", "c", "d"];
    server.reorderQueueByContext(q, 1, (ch) => ctx[ch]);
    eq(q, ["a", "d", "b", "c"], "声明 0（未知）殿后且保持原相对顺序");
  }
  {
    const q = ["a", "b", "c"];
    server.reorderQueueByContext(q, 0, () => 100);
    eq(q, ["a", "b", "c"], "声明全相同：稳定排序保持原序");
  }
  {
    const q = ["a", "b"];
    server.reorderQueueByContext(q, 1, () => 100);
    eq(q, ["a", "b"], "startIdx 指向最后一个：不动");
  }
  {
    const q = ["a"];
    server.reorderQueueByContext(q, 0, () => 100);
    eq(q, ["a"], "单元素队列：不动");
  }
  {
    const q = ["a", "b", "c"];
    eq(
      server.reorderQueueByContext(q, 3, () => 1),
      q,
      "startIdx 越界（= length）：原样返回"
    );
    eq(
      server.reorderQueueByContext(q, -1, () => 1),
      q,
      "startIdx 负数：原样返回"
    );
    eq(
      server.reorderQueueByContext(null, 0, () => 1),
      null,
      "非数组：原样返回"
    );
  }
  {
    const ctxOf = () => {
      throw new Error("不应被调用");
    };
    server.reorderQueueByContext(["a"], 0, ctxOf);
    ok(true, "无可重排元素时不调用 ctxOf");
  }

  // ===== 2. classifyUpstream：prompt_too_long 带渠道跳转标记 =====
  eq(server.classifyUpstream({ status: 413, message: "request entity too large" }, false, "trae"), { kind: "prompt_too_long", switchable: false, channelSwitchable: true, status: 413 }, "413：prompt_too_long + 不换号（switchable false）+ 可跳渠道");
  eq(server.classifyUpstream({ status: 400, message: "prompt is too long" }, false, "trae"), { kind: "prompt_too_long", switchable: false, channelSwitchable: true, status: 413 }, "「prompt is too long」文案（先被 413 词表分支命中）：同上");
  eq(server.classifyUpstream({ status: 400, message: "对话内容上下文过长" }, false, "trae"), { kind: "prompt_too_long", switchable: false, channelSwitchable: true, status: 413 }, "中文过大文案（词表大小写不敏感、原样匹配）：同上");
  ok(server.classifyUpstream({ status: 429, message: "Too Many Requests" }, false, "trae").channelSwitchable === undefined, "429 限流：不带渠道跳转标记（换号语义不变）");
  ok(server.classifyUpstream({ status: 402, message: "insufficient_quota" }, false, "trae").channelSwitchable === undefined, "402 欠费：不带渠道跳转标记");
  ok(server.classifyUpstream({ status: 400, message: "Custom_raccoonException 不支持关闭思考" }, false, "trae").channelSwitchable === undefined, "普通参数 400：不带渠道跳转标记");

  // ===== 3. channelModelContext：渠道×模型的有效上下文声明 =====
  eq(adapters.channelModelContext({}, "workbuddy", "model-x"), 131072, "无自定义：读该渠道自己的目录声明");
  eq(adapters.channelModelContext({}, "workbuddy_ai", "model-x"), 1048576, "同名模型两渠道各自独立（不互相取大）");
  eq(adapters.channelModelContext({ modelCustomByChannel: { "model-x": { workbuddy: { contextLength: 2097152 } } } }, "workbuddy", "model-x"), 2097152, "渠道级自定义覆盖目录声明");
  eq(adapters.channelModelContext({ modelCustom: { "model-x": { contextLength: 500000 } } }, "workbuddy", "model-x"), 500000, "模型级自定义兜底目录声明");
  eq(adapters.channelModelContext({ modelCustomByChannel: { "model-x": { workbuddy: { contextLength: 2097152 } } }, modelCustom: { "model-x": { contextLength: 500000 } } }, "workbuddy_ai", "model-x"), 500000, "模型级自定义对所有渠道兜底（与 resolveCustomParams 出站口径一致），渠道级只作用于所配渠道");
  eq(adapters.channelModelContext({ modelReverseAliases: { "unified-x": { workbuddy_ai: "model-x" } } }, "workbuddy_ai", "unified-x"), 1048576, "反向映射统一名按映射后的实际模型名查目录");
  eq(adapters.channelModelContext({ modelReverseAliases: { "unified-x": { workbuddy: "model-x" } }, modelCustom: { "model-x": { contextLength: 262144 } } }, "workbuddy", "unified-x"), 262144, "模型级自定义按映射后的实际名也认（与 resolveCustomParams 出站口径对齐）");
  eq(adapters.channelModelContext({}, "no-such-channel", "model-x"), 0, "未知渠道 → 0");
  eq(adapters.channelModelContext({}, "workbuddy", "no-such-model"), 0, "未知模型 → 0");
  eq(adapters.channelModelContext({}, "workbuddy", ""), 0, "空模型名 → 0");

  cleanup();
  console.log(`\n共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
