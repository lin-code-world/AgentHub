/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 合并模型目录「单来源且渠道无账号 → 自动关闭」自测
// 用法：node tools/model-accountless-selftest.cjs
//
// 锁四件事：
//   ① 纯判定只认「sources.length === 1 且该渠道账号数为 0」；
//   ② 首次判定写入 disabledModels 固化，新增账号不自动开，删光账号重新判为无账号；
//   ③ 手动把 id 从 disabledModels 移除后，无账号状态下会被重新固化；
//   ④ 自定义提供商：无 Key 关闭、加 Key 后仍关闭、删光 Key 后重新判为无账号。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-model-accountless-"));
process.env.AGENTHUB_DATA_DIR = tmp;

let pass = 0, fail = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  fail++; fails.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  const config = require("../electron/backend/config.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const provider = require("../electron/backend/proxy/provider.cjs");
  const modelAutoDisable = require("../electron/backend/proxy/modelAutoDisable.cjs");

  const proxyDir = path.resolve(store.proxyDir()).toLowerCase();
  if (!proxyDir.startsWith(path.resolve(tmp).toLowerCase())) {
    console.error("拒绝运行：数据目录不在沙箱内（" + proxyDir + "）");
    process.exit(2);
  }
  store.open();
  rules.init();

  console.log("\n[1] 纯判定");
  const ids = modelAutoDisable.accountlessIds(
    [
      { id: "solo-nobody", sources: ["trae"] },
      { id: "solo-someone", sources: ["zcode"] },
      { id: "multi-one-empty", sources: ["trae", "zcode"] },
      { id: "no-source", sources: [] },
    ],
    { trae: 0, zcode: 2 },
  );
  check("单源无账号进入 accountless", ids.has("solo-nobody"));
  check("单源有账号不进入", !ids.has("solo-someone"));
  check("多源即使其中一个无账号也不进入", !ids.has("multi-one-empty"));
  check("无来源不进入", !ids.has("no-source"));
  check("保留原始大小写", modelAutoDisable.accountlessIds([{ id: "Foo-Bar", sources: ["trae"] }], {}).has("Foo-Bar"));

  console.log("\n[2] 内置渠道：首次固化 / 新增账号 / 删光账号");
  const first = modelAutoDisable.sync();
  const soloByChannel = new Map();
  for (const m of first.models) {
    if (m.sources.length !== 1) continue;
    const ch = m.sources[0];
    if (!soloByChannel.has(ch)) soloByChannel.set(ch, []);
    soloByChannel.get(ch).push(m.id);
  }
  const counts = modelAutoDisable.accountCounts();
  const channel = [...soloByChannel.keys()].find((ch) => !counts[ch]);
  check("存在一个无账号且有单源模型的内置渠道", !!channel);
  const soloIds = channel ? soloByChannel.get(channel) : [];
  check("无账号时全部单源模型被列入 accountless", soloIds.length > 0 && soloIds.every((id) => first.accountless.has(id)));
  check("无账号时写入 disabledModels", soloIds.every((id) => first.disabledModels.includes(id)));
  check("首次 sync 发生写盘", first.changed === true);

  const accId = store.addAccount({ channel, name: "自测账号", token: "sk-selftest" });
  const second = modelAutoDisable.sync();
  check("新增账号后不再判为 accountless", soloIds.every((id) => !second.accountless.has(id)));
  check("新增账号后仍保持关闭", soloIds.every((id) => second.disabledModels.includes(id)));
  check("新增账号后无新写盘", second.changed === false);

  store.removeAccount(accId);
  const third = modelAutoDisable.sync();
  check("删光账号后重新判为 accountless", soloIds.every((id) => third.accountless.has(id)));
  check("删光账号后无新写盘（已在黑名单）", third.changed === false);

  console.log("\n[3] 手动移除后重新固化");
  const disk = config.loadConfig();
  disk.proxy.disabledModels = (disk.proxy.disabledModels || []).filter((id) => !soloIds.includes(id));
  config.saveConfig(disk);
  const fourth = modelAutoDisable.sync();
  check("无账号状态下手动移除会被重新加入", soloIds.every((id) => fourth.disabledModels.includes(id)));
  check("重新加入发生写盘", fourth.changed === true);

  console.log("\n[4] 自定义提供商（Key 即账号）");
  const created = provider.create({ id: "selfrel", display: "自测中转", baseUrl: "http://127.0.0.1:9/v1", models: ["solo-x"] });
  check("创建提供商", created.ok === true, created.message);
  const pid = created.ok ? created.provider.id : "";
  const pmodel = `${pid}/solo-x`;
  const noKey = modelAutoDisable.sync();
  check("无 Key 时提供商的单源模型关闭", noKey.accountless.has(pmodel) && noKey.disabledModels.includes(pmodel));
  const key = provider.addKey(pid, { key: "sk-selftest-provider" });
  check("提供商加 Key", key.ok === true, key.message);
  const withKey = modelAutoDisable.sync();
  check("加 Key 后不再判为无账号", !withKey.accountless.has(pmodel));
  check("加 Key 后仍保持关闭", withKey.disabledModels.includes(pmodel));
  provider.removeKey(key.id);
  const keyGone = modelAutoDisable.sync();
  check("删光 Key 后重新判为无账号", keyGone.accountless.has(pmodel));
  check("删光 Key 后仍在黑名单", keyGone.disabledModels.includes(pmodel));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) {
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0); // sqlite 连接与模块级定时器会让事件循环常驻，跑完显式退出
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
