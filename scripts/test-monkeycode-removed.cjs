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
// MonkeyCode 渠道移除守卫：适配器目录、渠道表、规则段、登录流程、前端元数据、图标与离线自测
// 一律不得再出现，防止该渠道日后被无声地重新引入（与 test-remote-removed / test-poolsync-removed 同口径）。
// 运行：node scripts/test-monkeycode-removed.cjs
// 沙箱：AGENTHUB_DATA_DIR 指向临时目录，绝不读写真实用户数据。
//
// 两处刻意的扫描例外（裁定见 docs/superpowers/plans/2026-11-01-monkeycode-channel-removal.md）：
//   ① 本脚本自身的文件名与内容必然含该渠道名，按文件名排除；
//   ② store.cjs 的「已下线渠道数据清理」必须引用这两个渠道 id（否则清不掉旧库残留），
//      故它不参与字符串扫描；它的渠道表口径由 `store.CHANNELS` 那条断言单独覆盖。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-monkeycode-removed-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${extra ? " —— " + extra : ""}`);
  }
}

const CN = "monkeycode";
const INTL = "monkeycode_intl";

// ===== 断言 1：适配器目录已删除 =====
ok(!fs.existsSync(path.join(ROOT, "electron/backend/proxy/monkeycode")), "适配器目录 electron/backend/proxy/monkeycode/ 已删除");

// ===== 断言 2：require 该适配器抛 MODULE_NOT_FOUND =====
{
  let code = "";
  let msg = "";
  try {
    require(path.join(ROOT, "electron/backend/proxy/monkeycode/adapter.cjs"));
  } catch (e) {
    code = (e && e.code) || "";
    msg = (e && e.message) || String(e);
  }
  ok(code === "MODULE_NOT_FOUND", "require monkeycode/adapter.cjs 抛 MODULE_NOT_FOUND", `实际 code=${code || "(无)"} ${String(msg).slice(0, 120)}`);
}

// ===== 断言 3：渠道表不含该渠道 =====
{
  const store = require(path.join(ROOT, "electron/backend/proxy/store.cjs"));
  const ids = (store.CHANNELS || []).map((c) => c.id);
  ok(!ids.includes(CN) && !ids.includes(INTL), "store.CHANNELS 不含该渠道", ids.join(","));
}

// ===== 断言 4：适配器注册表取不到（注册键 + 对外查询两道）=====
{
  const adapters = require(path.join(ROOT, "electron/backend/proxy/adapters.cjs"));
  ok(!(CN in adapters.ADAPTERS) && !(INTL in adapters.ADAPTERS), "ADAPTERS 注册表不含该渠道");
  ok(adapters.get(CN) === null && adapters.get(INTL) === null, "adapters.get() 对两个渠道返回 null");
}

// ===== 断言 5：离线自测脚本已删除 =====
ok(!fs.existsSync(path.join(ROOT, "tools/proxy-monkeycode-selftest.cjs")), "tools/proxy-monkeycode-selftest.cjs 已删除");

// ===== 断言 6：源码字符串扫描（扫描面见顶部例外说明）=====
const SCAN_DIRS = ["src", "tools", "scripts", "electron"];
const SCAN_FILES = ["README.md", "AGENTS.md"];
const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".git", ".superpowers"]);
// 例外②（见文件头）：store.cjs 必须引用已下线渠道 id 做库存清理，故不参与字符串扫描；
// 它的渠道表口径由 `store.CHANNELS` 断言单独覆盖。**只有这一个文件例外**——其余 electron/ 全量扫描。
const SKIP_FILES = new Set(["electron/backend/proxy/store.cjs"]);
const SELF = path.resolve(__filename);
const hits = [];
function scanFile(abs) {
  if (path.resolve(abs) === SELF) return;
  if (SKIP_FILES.has(path.relative(ROOT, abs).replace(/\\/g, "/"))) return;
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return; // 二进制 / 不可读文件与字符串断言无关
  }
  if (!text.toLowerCase().includes(CN)) return;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.toLowerCase().includes(CN)) hits.push(`${path.relative(ROOT, abs).replace(/\\/g, "/")}:${i + 1}`);
  });
}
function scanDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      scanDir(`${rel}/${entry.name}`);
    } else {
      scanFile(path.join(ROOT, `${rel}/${entry.name}`));
    }
  }
}
for (const d of SCAN_DIRS) scanDir(d);
for (const f of SCAN_FILES) scanFile(path.join(ROOT, f));
ok(hits.length === 0, "源码中不存在该渠道的残留引用", hits.slice(0, 10).join(", ") + (hits.length > 10 ? ` … 共 ${hits.length} 处` : ""));

// ===== 断言 7：渠道图标已删除 =====
ok(!fs.existsSync(path.join(ROOT, "src/assets/channels/monkeycode.png")), "src/assets/channels/monkeycode.png 已删除");

// ===== 断言 8：rules 默认配置无该渠道段 =====
{
  const rules = require(path.join(ROOT, "electron/backend/proxy/rules.cjs"));
  const defaults = (rules.get && rules.get("headers.json")) || {};
  ok(!Object.prototype.hasOwnProperty.call(defaults, CN) && !Object.prototype.hasOwnProperty.call(defaults, INTL), "headers.json 默认值不含该渠道段", Object.keys(defaults).join(","));
}

// ===== 断言 9：已下线渠道的库存清理（升级路径的真实行为，而非只看代码里有这段）=====
{
  const storePath = path.join(ROOT, "electron/backend/proxy/store.cjs");
  const store = require(storePath);
  const dbFile = path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db");
  // 人为写入该渠道的残留：账号行走 store 自己的写入路径，渠道行直接写表（模拟旧库形态）
  store.addAccount({ channel: CN, uid: "cleanup-test", name: "cleanup-test", token: "x", refreshToken: "", source: "test", expiresAt: 0 });
  {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(dbFile);
    raw.exec("PRAGMA busy_timeout=5000");
    raw.prepare("INSERT OR IGNORE INTO agents (id, display, domain, pool_strategy, updated_at) VALUES (?,?,?,?,?)").run(CN, "removed-channel", "removed.example", "expire_first", Date.now());
    raw.close();
  }
  const seededAccounts = store.listAccounts(CN).length;
  const seededAgent = store.listAgents().some((r) => r.id === CN);
  ok(seededAccounts === 1 && seededAgent, "前置：已写入该渠道的残留账号行与渠道行", `accounts=${seededAccounts} agent=${seededAgent}`);
  store.purgeRemovedChannels();
  ok(store.listAccounts(CN).length === 0, "清理后残留账号行已删除");
  ok(!store.listAgents().some((r) => r.id === CN), "清理后残留渠道行已删除");
}

console.log("");
console.log(`MonkeyCode 移除守卫：${pass} 通过 / ${failed} 失败`);
// 先关掉沙箱库连接：SQLite 文件被占用时 rmSync 删不掉，会在系统临时目录里堆沙箱目录
try {
  require(path.join(ROOT, "electron/backend/proxy/store.cjs")).close();
} catch {
  /* 未加载或已关闭 */
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 沙箱残留不影响结论 */
}
process.exit(failed ? 1 : 0);
