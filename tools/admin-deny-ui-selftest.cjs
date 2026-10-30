/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 浏览器端命令门控自测（前端置灰 + 原因展示）：
//   1 服务端 deny 清单核查：简报点名的命令在 browser 形态必须是 deny（漏项当场打红）；
//   2 前端门控纯函数（src/api/caps.ts 的 denyState）：给定 caps 时 deny 命令置灰、
//     原因逐字等于服务端下发的 reason（文案单一事实源在服务端，前端不得改写）；
//   3 桌面（无 caps）全部可用：任何按钮都不置灰；
//   4 页面接线：每个入口按钮所在文件必须消费 denyState 并把 reason 用于展示；
//   4b 结构断言（vue/compiler-dom 解析模板 AST）：tooltip 不得直接挂 disabled 控件
//     （disabled 控件不派发鼠标事件，hover 原因提示会失效），deny 控件必须经包裹层接 tooltip 或自带原生 title；
//   5 前端不得自维护禁用文案（.vue 里不得出现服务端口径的固定文案），
//     且服务端 browser 文案不得自指（如叫用户去点被禁的「选择文件」按钮）。
// caps.ts 是无 import 的纯 TS，esbuild 直译成 CJS 后在 Node 里执行，不加载 Vue 运行时。
// 用法：node tools/admin-deny-ui-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-deny-ui-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0,
  fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}

const ROOT = path.join(__dirname, "..");
const commandTable = require(path.join(ROOT, "electron", "backend", "commandTable.cjs"));
const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));

/** esbuild 直译 caps.ts（模块级 let caps 是状态，每次调用拿到一份全新实例） */
function loadCapsModule() {
  const src = fs.readFileSync(path.join(ROOT, "src", "api", "caps.ts"), "utf8");
  const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  return mod.exports;
}

/** 模拟服务端 /api/capabilities（browser 形态）：命令全集取自真实命令表，mode/文案同源 */
function browserCapsPayload() {
  const collected = commandTable.collect({});
  const commands = {};
  for (const cmd of collected.keys()) {
    const mode = commandTable.modeOf(cmd);
    commands[cmd] = mode === "deny" ? { mode, reason: commandTable.denyReason(cmd) } : { mode };
  }
  return { ok: true, platform: "web", version: "0.0.0-test", modules: ["proxy"], features: { sse: false, serviceControl: false, fileDialog: false }, commands };
}

async function main() {
  // ===== 1 服务端 deny 清单核查（简报逐字点名的命令） =====
  const NAMED = ["proxy_start", "proxy_stop", "proxy_restart", "proxy_oauth_begin", "proxy_oauth_submit_callback", "proxy_ide_status", "proxy_ide_switch", "proxy_open_data_dir", "proxy_open_rules_dir", "proxy_account_import_file", "proxy_oplog_export", "proxy_scan"];
  const ZCODE = Object.keys(commandTable.DENY_BROWSER).filter((c) => c.startsWith("proxy_zcode_"));
  ok(
    "简报点名的命令在 browser 形态全部 deny（含 proxy_oauth_submit_callback）",
    NAMED.every((c) => commandTable.modeOf(c) === "deny"),
    NAMED.filter((c) => commandTable.modeOf(c) !== "deny").join(",")
  );
  ok("proxy_zcode_* 一组在 browser 形态全部 deny", ZCODE.length >= 6 && ZCODE.every((c) => commandTable.modeOf(c) === "deny"), ZCODE.join(","));
  ok(
    "每条 deny 都有浏览器口径文案（非空字符串）",
    [...NAMED, ...ZCODE].every((c) => typeof commandTable.denyReason(c) === "string" && commandTable.denyReason(c).length >= 8),
    [...NAMED, ...ZCODE].filter((c) => !commandTable.denyReason(c)).join(",")
  );

  // ===== 2 前端门控：给定 caps（Web 托管形态） =====
  const web = loadCapsModule();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => browserCapsPayload() });
  await web.probeCaps();
  globalThis.fetch = origFetch;

  ok("Web 托管形态下 isWebTransport() === true", web.isWebTransport() === true, String(web.isWebTransport()));
  const denyCmds = Object.keys(commandTable.DENY_BROWSER);
  ok(
    "denyState 对每条 deny 命令置灰",
    denyCmds.every((c) => web.denyState(c).disabled === true),
    denyCmds.filter((c) => !web.denyState(c).disabled).join(",")
  );
  ok(
    "deny 原因逐字等于服务端下发的 reason（前端不改写文案）",
    denyCmds.every((c) => web.denyState(c).reason === commandTable.denyReason(c)),
    denyCmds.filter((c) => web.denyState(c).reason !== commandTable.denyReason(c)).join(",")
  );
  ok(
    "denyReason 逐字透传服务端 reason",
    denyCmds.every((c) => web.denyReason(c) === commandTable.denyReason(c)),
    denyCmds.filter((c) => web.denyReason(c) !== commandTable.denyReason(c)).join(",")
  );
  ok(
    'commandMode 对 deny 命令返回 "deny"',
    denyCmds.every((c) => web.commandMode(c) === "deny"),
    denyCmds.filter((c) => web.commandMode(c) !== "deny").join(",")
  );
  for (const c of ["proxy_pool", "proxy_status", "proxy_oplog_list", "proxy_account_import_json"]) {
    ok(`非 deny 命令 ${c} 不置灰且无原因`, web.denyState(c).disabled === false && web.denyState(c).reason === null, JSON.stringify(web.denyState(c)));
  }
  ok("多命令合并门控：任一 deny 即置灰、原因取命中那条", web.denyState("proxy_pool", "proxy_oauth_begin").disabled === true && web.denyState("proxy_pool", "proxy_oauth_begin").reason === commandTable.denyReason("proxy_oauth_begin"), JSON.stringify(web.denyState("proxy_pool", "proxy_oauth_begin")));
  ok("多命令合并门控：全可用时放行", web.denyState("proxy_pool", "proxy_account_import_json").disabled === false, JSON.stringify(web.denyState("proxy_pool", "proxy_account_import_json")));

  // ===== 3 桌面（无 caps）：全部可用，一个都不置灰 =====
  const desk = loadCapsModule();
  ok("桌面无 caps 时 isWebTransport() === false", desk.isWebTransport() === false, String(desk.isWebTransport()));
  ok(
    "桌面无 caps 时每条 deny 命令都不置灰（行为不变）",
    denyCmds.every((c) => desk.denyState(c).disabled === false),
    denyCmds.filter((c) => desk.denyState(c).disabled).join(",")
  );
  ok(
    "桌面无 caps 时不下发原因",
    denyCmds.every((c) => desk.denyState(c).reason === null),
    denyCmds.filter((c) => desk.denyState(c).reason !== null).join(",")
  );

  // ===== 4 页面接线：入口按钮必须消费 denyState 并展示 reason =====
  const WIRE = [
    ["src/components/Sidebar.vue", ["proxy_start", "proxy_stop"]],
    ["src/components/config/ConfigProxySection.vue", ["proxy_restart", "proxy_open_data_dir", "proxy_open_rules_dir"]],
    ["src/components/config/ConfigGeneralSection.vue", ["open_data_dir"]],
    ["src/views/proxy/ProxyLogView.vue", ["proxy_oplog_export"]],
    ["src/views/proxy/ProxyAgentsView.vue", ["proxy_oauth_begin", "proxy_oauth_submit_callback", "proxy_account_import_file", "proxy_scan", "proxy_scan_import", "proxy_ide_switch", "proxy_zcode_solve_captcha", "proxy_zcode_claim_mode", "proxy_zcode_device_status", "proxy_zcode_device_repair", "proxy_zcode_restore_mid", "proxy_zcode_switch_rollback"]],
    ["src/components/config/ConfigLanSection.vue", ["admin_reset_token"]],
  ];
  for (const [file, cmds] of WIRE) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const cmd of cmds) {
      const wired = new RegExp(`denyState\\([^)]*"${cmd}"`).test(src);
      ok(`${file} 门控接线 ${cmd}`, wired, wired ? "" : '未找到 denyState("' + cmd + '") 调用');
    }
    ok(`${file} 展示服务端原因（模板消费 .reason）`, /\.reason/.test(src), "未找到 .reason 绑定");
  }

  // ===== 4b 结构断言（vue/compiler-dom 解析模板 AST，不查字符串） =====
  // tooltip 的 hover 事件到不了 disabled 控件：deny 原因的 tooltip 必须经 span/div 包裹层接 hover，
  // 或干脆用原生 title（title 由浏览器渲染，不受 disabled 影响）。
  const compilerDom = require(path.join(ROOT, "node_modules", "@vue", "compiler-dom", "dist", "compiler-dom.cjs.js"));
  const FORM_TAGS = ["button", "input", "select", "textarea"];
  const propOf = (el, name) => (el.props || []).find((p) => (p.name === "bind" && p.arg && p.arg.content === name) || p.name === name) || null;
  const exprOf = (el, name) => {
    const p = (el.props || []).find((q) => q.name === "bind" && q.arg && q.arg.content === name);
    return (p && p.exp && p.exp.content) || "";
  };
  /** 取 .vue 顶层 <template> 的内层（嵌套 <template v-if/#slot>` 用深度匹配收口；先剥注释防伪匹配） */
  function templateOf(src) {
    const s = src.replace(/<!--[\s\S]*?-->/g, "");
    const start = s.indexOf("<template>");
    if (start < 0) return null;
    const body = s.slice(start + "<template>".length);
    const re = /<\/?template\b[^>]*>/g;
    let depth = 1,
      m;
    while ((m = re.exec(body))) {
      if (m[0].startsWith("</")) {
        if (--depth === 0) return body.slice(0, m.index);
      } else depth++;
    }
    return null;
  }
  function walkEls(node, fn, chain = []) {
    if (!node) return;
    if (node.type === 1) {
      fn(node, chain);
      for (const c of node.children || []) walkEls(c, fn, chain.concat(node));
    } else {
      for (const c of node.children || []) walkEls(c, fn, chain);
    }
  }

  const vueFiles = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".vue")) vueFiles.push(p);
    }
  })(path.join(ROOT, "src"));

  for (const file of vueFiles) {
    const tpl = templateOf(fs.readFileSync(file, "utf8"));
    if (!tpl) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const tipBad = [];
    const showBad = [];
    const switchBad = [];
    let ast;
    try {
      ast = compilerDom.parse(tpl);
    } catch (e) {
      ok(`${rel} 模板可解析`, false, String((e && e.message) || e));
      continue;
    }
    walkEls(ast, (el, chain) => {
      // A：deny 原因 tooltip 的直接子节点不得是 disabled 控件（需要 span/div 包裹层）。
      // 只查 deny 入口（content 带 .reason 或子控件带门控表达式），非门控的存量 tooltip 不在本任务范围
      if (el.tag === "el-tooltip") {
        const direct = (el.children || []).find((c) => c.type === 1);
        const denyTip = /\.reason/.test(exprOf(el, "content")) || (direct && /Gate\.disabled|methodGate\(/.test(exprOf(direct, "disabled")));
        if (denyTip && direct && FORM_TAGS.includes(direct.tag) && propOf(direct, "disabled")) tipBad.push(`${direct.tag} 直挂 disabled`);
      }
      // B：deny 门控控件必须有原因展示途径：被 tooltip 包裹（且非其直接子节点）或自带 title
      const gateExpr = exprOf(el, "disabled");
      if (FORM_TAGS.includes(el.tag) && /Gate\.disabled|methodGate\(/.test(gateExpr)) {
        const inTip = chain.some((a) => a.tag === "el-tooltip");
        const directOfTip = chain.length > 0 && chain[chain.length - 1].tag === "el-tooltip";
        if (!((inTip && !directOfTip) || propOf(el, "title"))) showBad.push(`${el.tag}[${gateExpr}]`);
      }
      // C：deny 的 div[role=switch]（如网关启停开关）走原生 title 承接原因
      if (el.tag === "div" && /Gate\.disabled/.test(exprOf(el, "class"))) {
        const role = propOf(el, "role");
        if (role && role.value && role.value.content === "switch" && !propOf(el, "title")) switchBad.push("div[role=switch] 无 title");
      }
    });
    ok(`${rel} tooltip 有包裹层（直接子节点不是 disabled 控件）`, tipBad.length === 0, tipBad.join("; "));
    ok(`${rel} deny 控件有原因展示（包裹层 tooltip 或原生 title）`, showBad.length === 0, showBad.join("; "));
    if (switchBad.length) ok(`${rel} deny 开关有原生 title`, false, switchBad.join("; "));
  }

  // ===== 5 前端不得自维护禁用文案 =====
  const selfWritten = vueFiles.filter((p) => fs.readFileSync(p, "utf8").includes("浏览器访问时不可用"));
  ok("前端 .vue 无自写的 deny 文案（统一取服务端 reason）", selfWritten.length === 0, selfWritten.map((p) => path.relative(ROOT, p)).join(","));
  const agentsSrc = fs.readFileSync(path.join(ROOT, "src", "views", "proxy", "ProxyAgentsView.vue"), "utf8");
  ok("ProxyAgentsView 无自维护的形态灌号引导文案", !agentsSrc.includes("容器形态灌号"), "仍含「容器形态灌号」文案块");
  ok("Ruling 22：proxy_account_import_file 的 browser 文案不自指「选择文件」", !String(commandTable.denyReason("proxy_account_import_file")).includes("选择文件"), String(commandTable.denyReason("proxy_account_import_file")));

  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) {
    console.log("失败项：");
    for (const b of bad) console.log("  - " + b);
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 沙箱残留不影响结论 */
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("自测执行异常：", e);
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
  process.exit(1);
});
