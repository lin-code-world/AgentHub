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
// 反代网关 · MonkeyCode 双站离线自测（纯函数，不联网、不读真实数据）
// 运行：node tools/proxy-monkeycode-selftest.cjs
//
// 守的是几条最容易在重构里静默坏掉的协议事实：
//   · 站点身份与 Cookie 名（改错即全渠道 401）；
//   · 建任务体：system 走独立字段且只取第一条、model_id 用目录里的 UUID、resource 与任务流同口径；
//   · ACP 事件 → OpenAI delta 的翻译（工具调用 id 合成、tool_call_update 增量路由、usage 是累计值）；
//   · 模型目录过滤：隐藏不列、只留 basic 档与裸名；
//   · 镜像发现优先级：任务列表 → 用户镜像(devbox) → 内置兜底；
//   · 签到验证码随机数发生器（FNV-1a + xorshift32）的确定性。
"use strict";

const P = "../electron/backend/proxy/monkeycode";
const region = require(`${P}/region.cjs`);
const endpoints = require(`${P}/endpoints.cjs`);
const task = require(`${P}/task.cjs`);
const stream = require(`${P}/stream.cjs`);
const probe = require(`${P}/probe.cjs`);
const captcha = require(`${P}/captcha.cjs`);
const models = require(`${P}/models.cjs`);

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, a);

console.log("\n[1] 站点身份与端点常量");
{
  eq(endpoints.SESSION_COOKIE_NAME, "monkeycode_ai_session", "Cookie 名");
  eq(endpoints.FALLBACK_DEVBOX_IMAGE_ID, "2e214f06-79ba-4535-9ac1-89adc2d9c6cc", "内置兜底镜像 UUID");
  eq(region.byChannel("monkeycode").siteOrigin, "https://monkeycode-ai.com", "国内站 Origin");
  eq(region.byChannel("monkeycode_intl").siteOrigin, "https://monkeycode-ai.net", "国际站 Origin");
  ok(region.byChannel("cn") === region.byChannel("monkeycode"), "短键 cn 与渠道 id 同指");
  ok(region.byChannel("intl") === region.byChannel("monkeycode_intl"), "短键 intl 与渠道 id 同指");
  eq(region.toWsScheme("https://monkeycode-ai.com"), "wss://monkeycode-ai.com", "https → wss");
}

console.log("\n[2] 建任务：messages → prompt + 请求体");
{
  const p = task.buildPrompt([
    { role: "system", content: "系统A" },
    { role: "system", content: "系统B（应被忽略）" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
  ]);
  ok(p.systemPrompt === "系统A", "system 只取第一条", p.systemPrompt);
  ok(p.prompt.includes("[User]") && p.prompt.includes("[Assistant]"), "user/assistant 带角色前缀", p.prompt);
  ok(!p.prompt.includes("系统B"), "后面的 system 不进正文");
  eq(p.prompt, "[User]\n你好\n\n[Assistant]\n在的", "段间空行、顺序正确");

  let threw = false;
  try { task.buildPrompt([{ role: "user", content: "   " }]); } catch (e) { threw = e.status === 400; }
  ok(threw, "全空 messages 抛 400");

  const body = task.buildBody({
    region: region.byChannel("monkeycode"),
    section: {},
    deps: {},
    prompt: { prompt: "hi", systemPrompt: "sys" },
    target: { modelId: "c79063e2-a4d4-4f15-8f8c-a604f959c377", cliName: "claude" },
    imageId: "img-uuid",
  });
  eq(body.model_id, "c79063e2-a4d4-4f15-8f8c-a604f959c377", "model_id 用目录里的 UUID");
  eq(body.host_id, "public_host", "host_id 用公共宿主占位符");
  eq(body.image_id, "img-uuid", "image_id 原样带上");
  eq(body.system_prompt, "sys", "system_prompt 独立字段");
  ok(body.resource && body.resource.core === 1 && body.resource.life === 3600, "resource 与任务流总时长同口径", body.resource);
  ok(body.repo && body.repo.branch === "master", "repo 为必填占位");

  const ui = JSON.parse(task.userInputData("你好"));
  eq(Buffer.from(ui.content, "base64").toString("utf8"), "你好", "user-input 的 content 走 base64");
  eq(ui.attachments, [], "user-input 带空 attachments");
}

console.log("\n[3] 上游错误 → 网关状态");
{
  eq(task.statusError(401).status, 401, "HTTP 401 → relogin 基");
  eq(task.statusError(402).status, 402, "HTTP 402 → 额度不足");
  eq(task.statusError(404).status, 404, "HTTP 404 → 模型/镜像不存在");
  eq(task.statusError(503).status, 502, "HTTP 5xx 归一到 502");
  eq(task.businessError(10811).status, 409, "业务码 10811 = 已有任务在跑（409 忙）");
  eq(task.businessError(50000).status, 502, "业务码 50000 → 502");
  eq(task.taskIdOf({ data: { task_id: "t-1" } }), "t-1", "任务 id 兼容 task_id 写法");
}

console.log("\n[4] 任务流 ACP → OpenAI delta");
{
  const t = new stream.Translator("abc123", "monkeycode-basic/glm-5.3-flash", true);
  let r = t.handleAcp({ type: "agent_message_chunk", text: "你" });
  eq(r.deltas, [{ content: "你" }], "正文 chunk → content delta");
  r = t.handleAcp({ type: "agent_thought_chunk", text: "想" });
  eq(r.deltas, [{ reasoning_content: "想" }], "思考 chunk → reasoning_content");
  r = t.handleAcp({ type: "tool_call", tool_name: "read", tool_input: { path: "/a" } });
  const tc = r.deltas[0].tool_calls[0];
  eq(tc.id, "call_0_abc123", "工具调用 id 按 call_<序号>_<任务 id> 合成");
  eq(tc.function.name, "read", "工具名原样");
  ok(tc.function.arguments.includes("path"), "对象参数转 JSON 串", tc.function.arguments);
  r = t.handleAcp({ type: "tool_call_update", tool_name: "read", delta: "更多" });
  eq(r.deltas[0].tool_calls[0].index, 0, "tool_call_update 增量路由到同名工具");
  ok(r.deltas[0].tool_calls[0].function.arguments === "更多", "增量按 delta 下发");
  t.handleAcp({ type: "usage_update", input_tokens: 10 });
  t.handleAcp({ type: "usage_update", output_tokens: 5 });
  eq(t.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 0 }, "usage 是累计值、0 视为未说话");
  eq(t.model, "monkeycode-basic/glm-5.3-flash", "下发给客户端的 model 用请求名");

  eq(stream.questionReply(JSON.stringify({ request_id: "q1" })).data, JSON.stringify({ request_id: "q1", answers_json: "", cancelled: false }), "提问自动回复");
  const b64 = Buffer.from(JSON.stringify({ id: "q2" })).toString("base64");
  eq(stream.parseQuestion(b64).id, "q2", "提问 data 兼容 base64");
  eq(stream.errorDetail({ error: "炸了" }), "炸了", "task-error 人话原因");
}

console.log("\n[5] 模型目录过滤（隐藏不列、只留 basic 档与裸名）");
{
  const row = (o) => ({ provider: "BaiZhiCloud", model: "x", id: "u", interface_type: "anthropic", access_level: "basic", context_limit: 200000, output_limit: 32000, ...o });
  ok(models.mapEntry(row({ is_hidden: true })) === null, "隐藏模型不列");
  ok(models.mapEntry(row({ model: "monkeycode-pro/hy3", access_level: "pro" })) === null, "pro 档且带前缀 → 不列");
  ok(models.mapEntry(row({ model: "monkeycode-ultra/gpt-5", access_level: "ultra" })) === null, "ultra 档且带前缀 → 不列");
  const basicPrefixed = models.mapEntry(row({ model: "monkeycode-basic/glm-5.3-flash", access_level: "basic" }));
  ok(basicPrefixed && basicPrefixed.id === "monkeycode-basic/glm-5.3-flash", "basic 档带前缀 → 保留（id 不拼 provider）");
  const naked = models.mapEntry(row({ model: "glm-5", access_level: "basic" }));
  ok(naked && naked.model === "glm-5", "裸名 basic → 保留");
  const nakedPro = models.mapEntry(row({ model: "monkeycode-pro", access_level: "pro" }));
  ok(nakedPro && nakedPro.model === "monkeycode-pro", "裸名 pro → 保留（裸名规则优先）");
  // 条目形状必须带目录页富化要的键（上下文 / 能力 / 思考），否则页面上这几列全是空的
  const shaped = models.mapEntry(row({ model: "glm-5", support_image: true, thinking_enabled: true }));
  ok(shaped && shaped.contextLength === 200000, "带上下文长度（contextLength）", shaped && shaped.contextLength);
  ok(shaped && shaped.maxOutputTokens === 32000, "带输出上限（maxOutputTokens）", shaped && shaped.maxOutputTokens);
  ok(shaped && shaped.capabilities.images === true, "图片能力取上游 support_image", shaped && shaped.capabilities);
  ok(shaped && shaped.capabilities.reasoning === true, "思考能力取上游 thinking_enabled");
  ok(shaped && shaped.capabilities.tools === true, "工具能力为 true");
  ok(models.mapEntry(row({ model: "" })) === null, "无模型名的幽灵条目不列");
}

console.log("\n[6] 镜像发现优先级");
{
  eq(probe.firstImageId({ data: { tasks: [{ image: { id: "img-1" } }] } }), "img-1", "任务列表取到镜像 id");
  eq(probe.firstImageId({ data: { tasks: [] } }), "", "无任务 → 空串");
  eq(probe.devboxImageId({ data: [{ id: "i-a", remark: "other" }, { id: "i-b", remark: "devbox" }] }), "i-b", "镜像列表按 remark=devbox 命中");
  eq(probe.devboxImageId({ data: [{ id: "i-c", name: "my-devbox-image" }] }), "i-c", "无 remark 时按名字含 devbox 命中");
  eq(probe.devboxImageId({ data: [] }), "", "镜像列表为空 → 空串");
}

console.log("\n[7] 签到验证码随机数发生器");
{
  eq(captcha.fnv1a(""), 0x811c9dc5, "FNV-1a 空串 = offset basis");
  eq(captcha.prng("seed", 8).length, 8, "prng 输出长度 = 请求长度");
  eq(captcha.prng("seed", 32), captcha.prng("seed", 32), "prng 确定性（同输入同输出）");
  ok(captcha.prng("a", 16) !== captcha.prng("b", 16), "不同种子输出不同");
  // 已知难度下应能快速解出（d=2 → 期望约 256 次/子挑战）
  const n = captcha.solveSub("tok", 1, 8, 2);
  ok(Number.isInteger(n) && n >= 0, "子挑战可解出 nonce", n);
}

console.log(`\nMonkeyCode 自测：${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
