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
// 账号导入格式自测（issue #143）
// 运行：node scripts/test-account-import-formats.cjs
// 重点：桌面端「导出选中账号」是元数据包（无 token），必须给出可行动错误；
//       带 token 的裸数组 / {accounts:[]} 包装仍能正常解析。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-import-formats-"));
process.env.AGENTHUB_DATA_DIR = TMP;

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 300)}` : "");
  }
}

try {
  const proxy = require("../electron/backend/proxy/index.cjs");
  const parse = proxy.parseAccountsJson;

  console.log("\n[1] 桌面端元数据导出（format=agenthub-accounts，无 token）");
  {
    const metadata = JSON.stringify({
      format: "agenthub-accounts",
      exportedAt: "2026-10-18T00:00:00.000Z",
      channel: "modelscope",
      accounts: [
        { id: "a1", channel: "modelscope", uid: "u1", name: "号1", note: "", source: "paste", status: "ok" },
        { id: "a2", channel: "modelscope", uid: "u2", name: "号2", note: "", source: "paste", status: "ok" },
      ],
    });
    const r = parse(metadata, "modelscope");
    ok(r.reason === "metadata-only", "识别为元数据包（不再按缺 token 报错）", r);
    ok(r.list.length === 0 && r.invalid === 2, "不产出任何可导入账号，并如实计数", r);
    ok(/元数据/.test(proxy.METADATA_ONLY_MESSAGE) && /凭据 JSON/.test(proxy.METADATA_ONLY_MESSAGE) && /api\/accounts\/import/.test(proxy.METADATA_ONLY_MESSAGE), "提示文案指向凭据 JSON / 管理 API", proxy.METADATA_ONLY_MESSAGE);
  }

  console.log("\n[2] 带 token 的裸数组 / {accounts:[]} 包装仍正常");
  {
    const one = { channel: "modelscope", uid: "u1", name: "号1", token: "ms-token" };
    const a = parse(JSON.stringify([one]), "modelscope");
    ok(a.list.length === 1 && a.list[0].token === "ms-token" && !a.reason, "裸数组解析成功", a);
    const b = parse(JSON.stringify({ channel: "modelscope", accounts: [one] }), "modelscope");
    ok(b.list.length === 1 && b.list[0].uid === "u1" && !b.reason, "{accounts:[]} 包装解析成功", b);
  }

  console.log("\n[3] 缺 token / 非法 JSON 的既有语义不变");
  {
    const missing = parse(JSON.stringify([{ channel: "modelscope", uid: "u1" }]), "modelscope");
    ok(missing.list.length === 0 && missing.invalid === 1 && !missing.reason, "缺 token 仍按无效记录计数", missing);
    let err = "";
    try { parse("{not-json", "modelscope"); } catch (e) { err = e.message; }
    ok(/JSON 解析失败/.test(err), "非法 JSON 仍抛出可读错误", err);
  }

  console.log("\n[4] 记录自带渠道名认不出 → 整批拒绝（不再静默改判到界面当前渠道）");
  {
    const ghost = parse(JSON.stringify([{ channel: "ghost_offline", uid: "x1", token: "tk" }]), "loomy");
    ok(Array.isArray(ghost.unknownChannels) && ghost.unknownChannels.includes("ghost_offline"), "如实回报无法识别的渠道名", ghost);
    ok(ghost.list.length === 0, "不产出任何可导入账号（整批拒绝）", ghost);
    const mix = parse(JSON.stringify([{ channel: "loomy", uid: "ok1", token: "tk" }, { channel: "ghost_x", uid: "bad1", token: "tk" }]), "loomy");
    ok(mix.list.length === 0 && mix.unknownChannels.includes("ghost_x"), "混合文件（一半能认）同样整批拒绝", mix);
    const dedup = parse(JSON.stringify([{ channel: "ghost_x", uid: "d1", token: "tk" }, { channel: "ghost_x", uid: "d2", token: "tk" }]), "loomy");
    ok(Array.isArray(dedup.unknownChannels) && dedup.unknownChannels.length === 1, "同一个认不出的渠道名只报一次", dedup);
    const noChannel = parse(JSON.stringify({ uid: "n1", name: "无渠道名", token: "tk" }), "loomy");
    ok(noChannel.list.length === 1 && noChannel.list[0].channel === "loomy" && !noChannel.unknownChannels, "文件未写渠道名 → 仍按界面选中渠道（既有路径不变）", noChannel);
    const known = parse(JSON.stringify({ channel: "modelscope", uid: "m1", token: "ms-token" }), "loomy");
    ok(known.list.length === 1 && known.list[0].channel === "modelscope" && !known.unknownChannels, "文件写了且在册的渠道名 → 按写的来（既有路径不变）", known);
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 账号导入格式自测：${pass} 项通过，${failed} 项失败`);
} finally {
  // 先关掉沙箱库连接：proxy/index.cjs 读配置时会惰性打开 stats.db，句柄不关时
  // Windows 上删目录会报 EPERM/EBUSY（断言全过也会因此判失败）。关闭失败不影响结论。
  try { require("../electron/backend/proxy/store.cjs").close(); } catch { /* 未加载或已关闭 */ }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 沙箱残留不影响结论，不得因此掩盖断言失败 */
  }
}
process.exit(failed ? 1 : 0);
