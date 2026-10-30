/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Trae Web/Remote 模型目录自测：/api/remote/v1/models -> data.list[].models
// 覆盖 solo_agent_remote 组选择、features 字符串倍率、上下文/能力与过滤规则。
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-catalog-web-"));
process.env.AGENTHUB_DATA_DIR = tmp;

let failures = 0;
function assert(cond, label, extra) {
  if (cond) console.log("  ok   " + label);
  else {
    failures++;
    console.error("  FAIL " + label + (extra ? " —— " + extra : ""));
  }
}

const entry = (name, displayName, extra) => ({ name, display_name: displayName, ...(extra || {}) });
const features = (rate) => JSON.stringify({ consumption_rate: { enable: true, data: { rate } }, reasoning: { enable: true } });

async function main() {
  const models = [
    entry("qwen3.8-flash", "Qwen3.8-Flash", { features: features(0.08), multimodal: true, context_window_tokens: { dev: 200000, max: 1000000 }, reasoning_effort_config: { support_thinking: true, options: ["light", "high", "extra_high"] } }),
    entry("glm-5.3", "GLM-5.3", { features: features(0.78), multimodal: false, context_window_tokens: { max: 1000000 } }),
    entry("no-rate", "No Rate", { features: "{}", context_window_tokens: { max: 200000 } }),
    entry("direct-max", "Direct Max", { max_tokens: 32000 }),
    entry("hidden", "Hidden", { is_invisible_to_user: true }),
    entry("offline", "Offline", { config_switch: false }),
    entry("unselectable", "Unselectable", { selectable: false }),
    entry("stopped", "Stopped", { status: false }),
  ];
  let lastUrl = "";
  const server = http.createServer((req, res) => {
    lastUrl = req.url || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { list: [{ function: "solo_agent_remote", models }] } }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;

  try {
    const store = require("../electron/backend/proxy/store.cjs");
    const rules = require("../electron/backend/proxy/rules.cjs");
    store.open();
    rules.init();
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(JSON.stringify(rules.DEFAULTS["headers.json"]));
    cfg.trae.modelsUrl = `http://127.0.0.1:${port}/api/remote/v1/models?functions=solo_agent_remote&show_custom_model=true`;
    cfg.trae.mirrorModelsUrl = "";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    // 磁盘旧值：qwen 故意写成 0（历史版本写坏的样子）→ 回退内置默认；glm 有值 → 优先磁盘
    const catalogPath = path.join(rules.rulesDir(), "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.trae = {
      models: [
        { id: "qwen3.8-flash", name: "Qwen3.8-Flash", rate: 0.01, capabilities: {}, contextLength: 1, maxOutputTokens: 0, reasoning_effort: [] },
        { id: "glm-5.3", name: "GLM-5.3", rate: 0.5, capabilities: {}, contextLength: 1, maxOutputTokens: 32000, reasoning_effort: [] },
      ],
    };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    rules.reload("catalog.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");

    console.log("[0] 目录地址归一");
    assert(adapters.normalizeModelsUrl("https://x/api/ide/v1/get_detail_param") === "", "旧 get_detail_param 地址被弃用");
    assert(adapters.normalizeModelsUrl("https://x/api/ide/v1/model_list") === "", "旧 model_list 地址被弃用");
    assert(adapters.normalizeModelsUrl("https://x/api/remote/v1/models?show_custom_model=true") === "https://x/api/remote/v1/models?show_custom_model=false", "show_custom_model 归一为 false");
    assert(adapters.normalizeModelsUrl("https://x/api/remote/v1/models?a=1") === "https://x/api/remote/v1/models?a=1", "其它地址原样保留");
    assert(adapters.normalizeModelsUrl("") === "", "空地址返回空");

    const out = await adapters.get("trae").fetchModels({ id: "t1", uid: "u1" }, { token: "tk" });
    assert(out && out.ok === true, "目录拉取成功", JSON.stringify(out && out.message));
    const byId = new Map((out.models || []).map((m) => [m.id, m]));
    console.log("  解析结果：" + JSON.stringify([...byId.keys()]));

    assert(lastUrl.includes("show_custom_model=false") && !lastUrl.includes("show_custom_model=true"), "实发请求不带自定义模型");
    assert(byId.get("qwen3.8-flash").maxOutputTokens === 0, "旧目录输出上限为 0 且上游未给时记 0（不回退内置默认）");
    assert(byId.get("glm-5.3").maxOutputTokens === 32000, "旧目录有输出上限时优先用旧值");
    assert(byId.get("direct-max").maxOutputTokens === 32000, "上游直给的最大输出优先");
    assert(byId.has("qwen3.8-flash"), "solo_agent_remote 组模型保留");
    assert(byId.get("qwen3.8-flash").rate === 0.08, "features 字符串中的倍率被解析");
    assert(byId.get("qwen3.8-flash").name === "Qwen3.8-Flash", "展示名取 display_name");
    assert(byId.get("qwen3.8-flash").contextLength === 1000000, "上下文取 context_window_tokens.max");
    assert(byId.get("qwen3.8-flash").capabilities.images === true && byId.get("qwen3.8-flash").capabilities.reasoning === true, "图片/推理能力");
    assert(JSON.stringify(byId.get("qwen3.8-flash").reasoning_effort) === JSON.stringify(["light", "high", "extra_high"]), "思考档位从 reasoning_effort_config 解析");
    assert(Array.isArray(byId.get("no-rate").reasoning_effort) && byId.get("no-rate").reasoning_effort.length === 0, "无思考档位返回空数组");
    assert(byId.get("glm-5.3").rate === 0.78, "第二条倍率");
    assert(byId.has("no-rate") && byId.get("no-rate").rate === null, "无倍率条目保留且 rate 为空");
    assert(!byId.has("hidden") && !byId.has("offline") && !byId.has("unselectable") && !byId.has("stopped"), "隐藏/下线/不可选/停用条目被过滤");

    console.log("[组缺失] 不拿其它组顶替");
    const badServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { list: [{ function: "solo_design_remote", models: [entry("design-only", "Design Only")] }] } }));
    });
    await new Promise((ok) => badServer.listen(0, "127.0.0.1", ok));
    try {
      cfg.trae.modelsUrl = `http://127.0.0.1:${badServer.address().port}/api/remote/v1/models`;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      rules.reload("headers.json");
      const bad = await adapters.get("trae").fetchModels({ id: "t1", uid: "u1" }, { token: "tk" });
      assert(bad && bad.ok === false, "缺少 solo_agent 组时拉取失败");
      assert(/solo_agent/.test(String(bad && bad.message)), "错误文案点明缺少 solo_agent 组", bad && bad.message);
    } finally {
      badServer.close();
    }
  } finally {
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* SQLite 句柄未释放时交给系统清理 */ }
  }

  console.log(failures ? `\nRESULT: ${failures} failed` : "\nTrae 模型目录自测全过");
  process.exitCode = failures ? 1 : 0;
  const t = setTimeout(() => process.exit(failures ? 1 : 0), 5000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
