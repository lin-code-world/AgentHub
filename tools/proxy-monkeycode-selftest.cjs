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
//   · ACP 事件 → OpenAI delta 的翻译（事件在 update.sessionUpdate、正文在 update.content.text；usage 不下发）；
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
  // cli_name 固定 opencode，不随接口类型变：按接口映射成 claude/codex 时容器里的 agent
  // 连不上模型 API（实测 llm_call_retry "Cannot connect to API"），官方三端一律用 opencode
  eq(endpoints.cliNameFor("anthropic"), "opencode", "anthropic 接口也用 opencode（不映射 claude）");
  eq(endpoints.cliNameFor("openai_responses"), "opencode", "openai_responses 接口也用 opencode（不映射 codex）");
  eq(endpoints.cliNameFor(""), "opencode", "缺接口类型也回落 opencode");
  // 任务跑完仍占账号，用完即停（否则下一个请求撞 10811）
  eq(endpoints.TASKS_STOP_PATH, "/api/v1/users/tasks/stop", "停止任务端点");
  ok(typeof task.stopTask === "function", "adapter 依赖的 stopTask 已导出");
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
    target: { modelId: "c79063e2-a4d4-4f15-8f8c-a604f959c377", cliName: "opencode" },
    imageId: "img-uuid",
  });
  eq(body.model_id, "c79063e2-a4d4-4f15-8f8c-a604f959c377", "model_id 用目录里的 UUID");
  eq(body.host_id, "public_host", "host_id 用公共宿主占位符");
  eq(body.image_id, "img-uuid", "image_id 原样带上");
  eq(body.system_prompt, "sys", "system_prompt 独立字段");
  ok(body.resource && body.resource.core === 2 && body.resource.life === 3 * 3600, "resource 用官方口径（2核/3小时）且与任务流总时长同口径", body.resource);
  eq(body.task_type, "develop", "task_type 固定 develop（与官方客户端一致）");
  ok(body.repo && body.repo.branch === "master", "repo 为必填占位");

  const ui = JSON.parse(Buffer.from(task.userInputData("你好"), "base64").toString("utf8"));
  eq(Buffer.from(ui.content, "base64").toString("utf8"), "你好", "user-input 的 content 走 base64");
  eq(ui.attachments, [], "user-input 带空 attachments");
  // data 外层也必须 base64：服务端 TaskStream.Data 是 []byte，发 JSON 会被反序列化丢弃
  ok(!task.userInputData("你好").trim().startsWith("{"), "user-input 的 data 外层是 base64（不是明文 JSON）");
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
  const t = new stream.Translator("abc123", "monkeycode-basic/glm-5.3-flash");
  // 真实结构（实测）：事件类型在 update.sessionUpdate，正文在 update.content.text
  let r = t.handleAcp({ sessionId: "ses_x", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你" } } });
  eq(r.deltas, [{ content: "你" }], "正文 chunk → content delta");
  r = t.handleAcp({ sessionId: "ses_x", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } } });
  eq(r.deltas, [{ reasoning_content: "想" }], "思考 chunk → reasoning_content");
  r = t.handleAcp({ sessionId: "ses_x", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", kind: "read", rawInput: { path: "/a" } } });
  const tc = r.deltas[0].tool_calls[0];
  eq(tc.id, "tc-1", "工具调用 id 用上游 toolCallId");
  eq(tc.function.name, "read", "工具名取 kind");
  ok(tc.function.arguments.includes("path"), "对象参数转 JSON 串", tc.function.arguments);
  // usage_update 只记录、不造帧（下游按本地估算记账，见 stream.cjs succeed 注释）
  r = t.handleAcp({ sessionId: "ses_x", update: { sessionUpdate: "usage_update", used: 34807, size: 200000 } });
  eq(r.deltas, [], "usage_update 不下发任何帧");
  eq(t.model, "monkeycode-basic/glm-5.3-flash", "下发给客户端的 model 用请求名");
  // 已确认不需要的事件：plan / 命令列表 / 重试 都只记录、不造帧
  r = t.handleAcp({ sessionId: "ses_x", update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
  eq(r.deltas, [], "命令列表事件不造帧");

  // 收发 data 都是 base64(JSON)：服务端 TaskStream.Data 是 []byte，JSON 里表现为 base64 字符串
  const enc = stream.encodeData({ request_id: "q1" });
  eq(stream.decodeData(enc), { request_id: "q1" }, "上行编码 / 下行解码成对");
  eq(stream.parseQuestion(enc).request_id, "q1", "提问 data 走 base64 解码");
  eq(stream.decodeData(stream.questionReply(enc).data), { request_id: "q1", answers_json: "", cancelled: false }, "提问自动回复（data 亦 base64）");
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
  // 名字只认上游 remark：上游没给名时必须是空串（回填 model 等于凭空造名字，
  // 渠道页按名字分列时就看不出「这个渠道其实没给名」）
  eq(models.mapEntry(row({ model: "glm-5" })).name, "", "上游没给 remark → 名字为空");
  eq(models.mapEntry(row({ model: "glm-5", remark: "极致模型-5" })).name, "极致模型-5", "名字取上游 remark 字段");
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

console.log("\n[8] 目录持久化：只有磁盘文件（模拟重启）时仍能读到模型");
{
  // 回归守卫：清单曾经只存在进程内 Map 里，重启后归零 —— 页面看不到模型、发请求报「目录为空」。
  // 这里造一份临时 catalog.json，确认 list() 在内存为空时能从盘上读回。
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tmp = path.join(os.tmpdir(), "ah-mc-selftest-" + Date.now());
  fs.mkdirSync(path.join(tmp, "proxy", "rules"), { recursive: true });
  const sample = {
    monkeycode: {
      syncedAt: 1,
      models: [{ id: "glm-5", name: "", model: "glm-5", upstreamId: "uuid-glm5", interfaceType: "anthropic", cliName: "claude", contextLength: 200000 }],
    },
  };
  fs.writeFileSync(path.join(tmp, "proxy", "rules", "catalog.json"), JSON.stringify(sample), "utf8");
  const old = process.env.AGENTHUB_DATA_DIR;
  process.env.AGENTHUB_DATA_DIR = tmp;
  // 换数据目录后 rules 模块的路径才会变：清缓存重新 require
  delete require.cache[require.resolve("../electron/backend/proxy/rules.cjs")];
  delete require.cache[require.resolve(`${P}/models.cjs`)];
  const rules2 = require("../electron/backend/proxy/rules.cjs");
  rules2.init();
  const models2 = require(`${P}/models.cjs`);
  eq(models2.list("monkeycode").length, 1, "磁盘有目录 → list() 读回 1 条");
  eq(models2.ids("monkeycode"), ["glm-5"], "ids() 从盘上读回模型名");
  const target = models2.resolveTarget("monkeycode", "glm-5");
  ok(target && target.modelId === "uuid-glm5", "建任务能从盘上目录解析出 UUID", target);
  // 落盘条目里 cliName 是旧的 claude：必须吃当前规则（opencode），不能被旧值带走
  eq(target && target.cliName, "opencode", "cli_name 不信任落盘旧值（旧目录里的 claude 被纠正为 opencode）");
  eq(models2.list("monkeycode_intl").length, 0, "另一站独立一格，不串数据");
  // 复位：还原环境与模块，避免影响后续断言
  if (old === undefined) delete process.env.AGENTHUB_DATA_DIR;
  else process.env.AGENTHUB_DATA_DIR = old;
  delete require.cache[require.resolve("../electron/backend/proxy/rules.cjs")];
  delete require.cache[require.resolve(`${P}/models.cjs`)];
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}

console.log(`\nMonkeyCode 自测：${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
