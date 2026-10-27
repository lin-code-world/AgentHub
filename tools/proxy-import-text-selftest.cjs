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
// 浏览器端账号 JSON 上传导入自测（proxy_account_import_text）：
//   1 命令在收集表里、browser 形态可写（不 deny）、preload 白名单已同步；
//   2 合法账号 JSON 导入 added=1，并触发额度刷新、写一条操作日志；
//   3 同 channel:uid 再导入计为 dup（只新增不更新）；
//   4 format=agenthub-accounts 元数据包被拒（提示「只有元数据」语义），号池不变；
//   5 channel 为不存在的提供商时回落到 fallback（store.CHANNELS[0]），JSON 里未知渠道归当前选中渠道；
//   6 空文本 / 非法 JSON / 缺 token 均返回明确失败（ok=false 且有可读 message）；
//   7 前端入口接线（input[type=file] 只收 .json、调 proxyAccountImportText）与 Ruling 29 文案；
// 解析与入库复用 parseAccountsJson + importAccounts（不新写），故断言口径与桌面导入逐字一致。
// 全部在沙箱数据目录内运行，额度刷新按测试替身计数，绝不发真实请求。
// 用法：node tools/proxy-import-text-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-import-text-"));
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
const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
const credits = require(path.join(ROOT, "electron", "backend", "proxy", "credits.cjs"));
const oplog = require(path.join(ROOT, "electron", "backend", "proxy", "oplog.cjs"));

// 额度刷新测试替身：importAccounts 入池即调 credits.refreshAccount（失败不阻塞），
// 真发请求会碰网络——这里替换实现只计数，顺带验证「导入后触发额度刷新」这条语义
const refreshCalls = [];
credits.refreshAccount = async (id) => {
  refreshCalls.push(id);
  return {};
};

// 收集器注入空 handle：只拿 { 命令 → handler }，与桌面 IPC / 管理服务同一份实现
const commands = commandTable.collect({});
const run = (args) => {
  const fn = commands.get("proxy_account_import_text");
  return fn ? fn(null, args) : Promise.resolve({ ok: false, message: "命令不存在：proxy_account_import_text" });
};

async function main() {
  console.log("=== 1 命令存在与形态门控 ===");
  ok("proxy_account_import_text 在命令表里", commands.has("proxy_account_import_text"));
  ok('modeOf("proxy_account_import_text", "browser") === "write"', commandTable.modeOf("proxy_account_import_text", "browser") === "write", commandTable.modeOf("proxy_account_import_text", "browser"));
  ok("browser 形态无 deny 文案（浏览器可用）", commandTable.denyReason("proxy_account_import_text", "browser") == null);
  const preloadSrc = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  ok("preload 白名单已同步 proxy_account_import_text", /"proxy_account_import_text"/.test(preloadSrc));

  console.log("");
  console.log("=== 2 合法账号 JSON 导入（断言 1：added=1）===");
  const one = { channel: "trae", uid: "u1", name: "号1", token: "tk-1" };
  const r1 = await run({ channel: "trae", text: JSON.stringify(one) });
  ok("ok=true 且 added=1", r1.ok === true && r1.added === 1, JSON.stringify(r1));
  ok("dup=0 / invalid=0", r1.dup === 0 && r1.invalid === 0, JSON.stringify(r1));
  ok("汇总消息含「成功导入 1 个账号」", /成功导入 1 个账号/.test(r1.message || ""), r1.message);
  {
    const rows = store.listAccounts();
    const hit = rows.find((a) => a.channel === "trae" && a.uid === "u1");
    ok("账号落库（channel=trae / uid=u1）", !!hit, JSON.stringify(rows.map((a) => ({ channel: a.channel, uid: a.uid }))));
    ok("导入后触发额度刷新", !!hit && refreshCalls.includes(hit.id), JSON.stringify(refreshCalls));
    const logs = oplog.list({ limit: 50 }).rows || [];
    ok(
      "操作日志新增一条（号池账号 · 文本导入）",
      logs.some((l) => l.op === "号池账号" && /文本导入/.test(l.message || "")),
      JSON.stringify(logs.slice(0, 3).map((l) => ({ op: l.op, message: l.message })))
    );
  }

  console.log("");
  console.log("=== 3 同 channel:uid 再导入计为 dup（断言 2）===");
  {
    const before = store.listAccounts().length;
    const r = await run({ channel: "trae", text: JSON.stringify(one) });
    ok("ok=true 且 added=0 / dup=1", r.ok === true && r.added === 0 && r.dup === 1, JSON.stringify(r));
    ok("汇总消息含「1 个同 UID 已存在跳过」", /1 个同 UID 已存在跳过/.test(r.message || ""), r.message);
    ok("号池条数不变（只新增不更新）", store.listAccounts().length === before, `${before} -> ${store.listAccounts().length}`);
  }

  console.log("");
  console.log("=== 4 元数据包被拒（断言 3：只有元数据）===");
  {
    const before = store.listAccounts().length;
    const meta = JSON.stringify({ format: "agenthub-accounts", exportedAt: "2026-10-27T00:00:00.000Z", channel: "trae", accounts: [{ id: "a1", channel: "trae", uid: "m1", name: "元数据号" }] });
    const r = await run({ channel: "trae", text: meta });
    ok("ok=false", r.ok === false, JSON.stringify(r));
    ok("提示指向「元数据」（文件本来就没有凭据）", /元数据/.test(r.message || ""), r.message);
    ok("提示给出可行动替代（凭据 JSON）", /凭据 JSON/.test(r.message || ""), r.message);
    ok("号池不变（元数据不入池）", store.listAccounts().length === before, `${before} -> ${store.listAccounts().length}`);
  }

  console.log("");
  console.log("=== 5 不存在的提供商回落 fallback（断言 4）===");
  {
    const fallback = store.CHANNELS[0].id;
    const r = await run({ channel: "ghost_provider", text: JSON.stringify({ channel: "ghost_provider", uid: "g1", name: "幽灵提供商号", token: "tk-g1" }) });
    ok("导入成功 added=1", r.ok === true && r.added === 1, JSON.stringify(r));
    const hit = store.listAccounts().find((a) => a.uid === "g1");
    ok(`回落到 fallback（${fallback}）`, !!hit && hit.channel === fallback, hit && hit.channel);
  }
  {
    // provider 不存在的账号（JSON 里的 channel 是已删除的自定义提供商）：归到当前选中渠道（既有行为）
    const r = await run({ channel: "trae", text: JSON.stringify({ channel: "gone_provider", uid: "g2", name: "自定义提供商号", token: "tk-g2" }) });
    ok("JSON 里未知渠道归当前选中渠道（先建提供商再导账号）", r.ok === true && r.added === 1 && !!store.listAccounts().find((a) => a.uid === "g2" && a.channel === "trae"), JSON.stringify(r));
  }

  console.log("");
  console.log("=== 6 空文本 / 非法 JSON / 缺 token 明确失败 ===");
  {
    const rEmpty = await run({ channel: "trae", text: "" });
    ok("空文本 ok=false 且提示可读", rEmpty.ok === false && !!rEmpty.message && /空/.test(rEmpty.message), JSON.stringify(rEmpty));
    const rBlank = await run({ channel: "trae", text: "   \n\t " });
    ok("纯空白同口径", rBlank.ok === false && !!rBlank.message, JSON.stringify(rBlank));
    const rBad = await run({ channel: "trae", text: "{not-json" });
    ok("非法 JSON ok=false 且提示含「JSON 解析失败」", rBad.ok === false && /JSON 解析失败/.test(rBad.message || ""), JSON.stringify(rBad));
    const rNoToken = await run({ channel: "trae", text: JSON.stringify([{ channel: "trae", uid: "x1" }]) });
    ok("缺 token ok=false 且提示含「缺 token」", rNoToken.ok === false && /缺 token/.test(rNoToken.message || ""), JSON.stringify(rNoToken));
  }

  console.log("");
  console.log("=== 7 前端入口与 Ruling 29 文案 ===");
  {
    const vue = fs.readFileSync(path.join(ROOT, "src", "views", "proxy", "ProxyAgentsView.vue"), "utf8");
    const ipcTs = fs.readFileSync(path.join(ROOT, "src", "api", "ipc.ts"), "utf8");
    ok("ipc.ts 封装 proxy_account_import_text", /proxy_account_import_text/.test(ipcTs));
    ok("前端有 input[type=file] 上传入口", /type="file"/.test(vue));
    ok("上传入口只接受 .json", /accept="[^"]*\.json/.test(vue));
    ok("前端调用 proxyAccountImportText（读文本后导入）", /proxyAccountImportText/.test(vue));
    ok("前端不自写解析入库（JSON.parse 不喂文件内容）", !/JSON\.parse\(\s*(await\s+)?file/i.test(vue));
    // 顺手项：文件头的 UTF-8 BOM（Windows 记事本 / 部分导出工具会写）必须在交给后端前剥掉，
    // 否则 JSON.parse 直接报错、用户只看到「解析失败」却看不出文件没问题
    ok("前端读文件后剥掉 UTF-8 BOM", /\.replace\(\/\^\\uFEFF\//.test(vue), "未找到 \\uFEFF 剥离");
    const deny = String(commandTable.denyReason("proxy_account_import_file", "browser"));
    ok("Ruling 29：browser 文案改指「选择 JSON 文件上传」", /选择 JSON 文件上传/.test(deny), deny);
    ok("Ruling 29：browser 文案不提前承诺 ZIP", !/zip/i.test(deny), deny);
    ok("Ruling 22 不回退：文案仍不自指「选择文件」", !deny.includes("选择文件"), deny);
  }

  console.log("");
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (bad.length) {
    console.log("失败项：");
    for (const b of bad) console.log("  - " + b);
  }
}

main()
  .catch((e) => {
    console.error("自测执行异常：", e);
    fail++;
  })
  .finally(() => {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* 沙箱残留不影响结论 */
    }
    process.exit(fail ? 1 : 0);
  });
