/**
 * 明日实测（Qoder 多账号签到是否成立）：用 qoder-export 导出文件里的
 * 「账号 + 该机器设备身份」，从**本机**各领一次每日 100 Credits。
 *
 * 判定核心：同一台机器、用各自（不同）的设备身份，两个账号是否都能领到。
 *   · 都能领到 → 方案成立
 *   · 只有一个能领到 → 上游按机器/人去重，换身份不够
 *
 * 用法：
 *   node tools/qoder-export/checkin-verify.cjs <导出文件> [<导出文件> ...]
 *   node tools/qoder-export/checkin-verify.cjs --dry <文件...>   # 只看可领状态，不领取
 *
 * ⚠️ 加 --dry 时是纯只读（只查活动列表）；不加时会真的 POST 领取。
 * 每日窗口 10:00(UTC+8) 刷新；窗口未开/已领过时如实报告。
 */
"use strict";
const fs = require("node:fs");

const API = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns";

function osKernel(osStr) {
  const m = /Version ([\d.]+)/.exec(String(osStr || ""));
  return m ? m[1] : "";
}

function buildHeaders(j, r) {
  const dev = r.device || {};
  return {
    Authorization: `Bearer ${r.account.token}`,
    Accept: "application/json",
    "User-Agent": "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": r.clientVersion || "0.5.3",
    "Cosy-MachineId": r.machineId || "",
    "Cosy-MachineOS": osKernel(j.machine && j.machine.os),
    "Cosy-MachineHostname": (j.machine && j.machine.hostname) || "",
    "Cosy-MachineToken": dev.machineToken || "",
    "Cosy-MachineType": dev.machineType || "",
    "Cosy-MachineCode": dev.machineCode || "",
  };
}

async function runOne(j, r, dry) {
  const name = r.account.name;
  const machine = j.machine && j.machine.hostname;
  const hdrs = buildHeaders(j, r);
  let list;
  try {
    const resp = await fetch(`${API}?forceRefresh=true`, { method: "GET", headers: hdrs });
    list = { status: resp.status, data: await resp.json().catch(() => null) };
  } catch (e) {
    return { name, machine, error: String(e) };
  }
  if (list.status === 401 || list.status === 403) return { name, machine, authError: true, status: list.status };
  if (!list.data) return { name, machine, error: `HTTP ${list.status}` };

  const rows = Array.isArray(list.data.campaigns) ? list.data.campaigns : [];
  const nowSec = Math.floor(Date.now() / 1000);
  // 与适配器同口径：只领**窗口内**的活动（startAt ≤ 现在 < endAt）；窗口没开就不领，避免误报"领取失败"
  const inWindow = (c) => {
    const a = Number(c.startAt);
    const b = Number(c.endAt);
    return (!a || nowSec >= a) && (!b || nowSec < b);
  };
  const benefit = rows.filter((c) => c && c.actionType === "CLAIM_BENEFIT" && c.campaignId);
  const claimable = benefit.filter((c) => c.claimStatus === "CLAIMABLE" && inWindow(c));
  const pending = benefit.filter((c) => c.claimStatus === "CLAIMABLE" && !inWindow(c));
  const claimed = benefit.filter((c) => c.claimStatus === "CLAIMED");
  const out = {
    name, machine,
    identity: (r.device && r.device.machineToken || "").slice(0, 18) + "…",
    claimableCount: claimable.length,
    notOpenYet: pending.length > 0,
    alreadyClaimedToday: claimed.length > 0,
  };
  if (dry || !claimable.length) return out;

  out.claims = [];
  for (const c of claimable) {
    try {
      const resp = await fetch(`${API}/${encodeURIComponent(c.campaignId)}/claim`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await resp.json().catch(() => null);
      out.claims.push({
        status: resp.status,
        result: (data && (data.status || data.result)) || "",
        replayed: data && data.replayed === true,
        amount: data && data.benefit && data.benefit.amount,
      });
    } catch (e) {
      out.claims.push({ error: String(e) });
    }
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.log("用法：node tools/qoder-export/checkin-verify.cjs [--dry] <导出文件> [...]");
    process.exit(1);
  }
  console.log(dry ? "== 只读模式（--dry）：只查状态，不领取 ==\n" : "== 实测模式：会真的领取当日额度 ==\n");
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.log(`[${f}] 读取失败: ${e.message}`); continue; }
    for (const r of (j.results || [])) {
      const out = await runOne(j, r, dry);
      console.log(JSON.stringify(out, null, 2));
    }
  }
  console.log("\n（同一台机器 + 各自身份：若两个账号都出现了领取成功，方案成立；只有一个成功则上游按机器去重。）");
})();
