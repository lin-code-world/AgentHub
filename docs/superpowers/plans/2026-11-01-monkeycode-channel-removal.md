# 移除 MonkeyCode 渠道 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 把 MonkeyCode 渠道（国内版 `monkeycode` + 国际版 `monkeycode_intl`）从反代网关整体移除，不留任何残余引用，并用一个"移除守卫"脚本钉住，防止日后回流。

**Architecture:** 本工程的渠道在五个地方登记：①适配器注册表 `adapters.cjs`；②渠道表 `store.cjs` 的 `CHANNELS`（种子进 `agents` 表）；③默认规则段 `rules.cjs`；④登录流程 `discovery.cjs`；⑤前端渠道元数据（类型联合 / 显示名 / 图标 / 页签门控）。移除 = 逐处下线 + 一段幂等的数据清理（把 `agents` / `accounts` 里该渠道的孤儿行删掉）+ 守卫脚本 + 构建/闭包/黄金闸验证。

**Tech Stack:** Electron 主进程（CommonJS `.cjs`）、Vue 3 + TS 渲染层、node:sqlite、无测试框架（仓库内 `.cjs` 自测脚本）。

**Spec:** 无独立设计文档。背景与实测证据见下方「背景」节；渠道协议口径原记录在 `AGENTS.md` 的「MonkeyCode 渠道」段，本次一并删除。

## 背景（为什么移除）

2026-11-01 对线上实例（192.168.2.129）实测确认：该渠道每次请求新建一个云端任务容器，容器需约 8 秒预热，而网关在 WebSocket 连上后 0.8 秒内就把首条输入发出；上游随即关闭任务流，网关判定为"上游瞬时错误"并在同账号立即重发建任务，此时上一个任务仍在 pending，上游按任务并发上限拒绝（业务码 `10811`）。上游任务记录显示这些任务**从未进入执行阶段**（只有 `user-input` + `auto-approve` 两条，无 `task-started`）。结论：该渠道在本工程的使用方式下不可用，决定整体下线。

## Global Constraints

- **不提交**：本次改动全部完成后交由用户审阅，由用户决定何时提交；执行期间不执行 `git commit`。
- 代码风格按根目录 `.prettierrc`（printWidth 999 不拆行、双引号、带分号、2 空格缩进、LF）；改完跑 `npm run format:check` 校验本计划涉及的文件。
- **保留版权头**：被修改的上游源文件头部「版权与授权声明，禁止删除」注释块不得清理。
- 仓库语言为中文：新增注释、守卫脚本输出、文档一律简体中文。
- 移除后**不得残留** `monkeycode` / `monkeycode_intl` 字符串（`docs/superpowers/` 下的历史记录文件、以及 `usage_requests` / `oplog` 的历史数据除外）。
- 修改 `electron/backend/proxy` 调度核心后必须跑黄金闸 `node scripts/dev-sink-golden.cjs`。
- 沙箱约定：所有自测脚本运行时把 `AGENTHUB_DATA_DIR` 指向临时目录，不得读写真实用户数据。

## Review Focus

以下五类是移除渠道时最可能让用户踩坑的输入/场景，每条都在对应任务里挂验证：

1. **旧版本升级上来的数据库**：库里仍留着 `agents` 两行与 `accounts` 里那个账号 —— 清不掉会导致界面残留"看得见但用不了"的孤儿渠道（Task 4）。
2. **浏览器控制台记住的上次浏览渠道**：前端若把渠道 id 存在本地状态/URL，删掉后打开页面可能取不到显示名或白屏（Task 3 的显示兜底验证）。
3. **用户手上的旧凭据 JSON**：以前导入会被提示"请用 OAuth 登录"，删掉该闸后提示语必须仍然合理，不能变成"未知渠道"这类费解文案（Task 2 的导入路径验证）。
4. **固定渠道 / 路由配置指向了该渠道**：用户配置里若写死了 `monkeycode`，删掉后请求会走到未知渠道分支（Task 6 用黄金闸 + 一次真实转发路径确认不崩）。
5. **模型目录 `catalog.json` 里的残留段**：模型管理页可能显示孤儿模型（Task 4）。

---

### Task 1: 移除守卫脚本（先写，跑成红）

**Files:**
- Create: `scripts/test-monkeycode-removed.cjs`
- 参考样式：`scripts/test-remote-removed.cjs`（同目录，含版权头、沙箱、`ok()` 断言风格）

**Interfaces:**
- Produces: 可执行脚本 `node scripts/test-monkeycode-removed.cjs`，退出码 0 = 全部断言通过。后续每个 Task 都用它判定"删干净了没有"。

- [ ] **Step 1: 写守卫脚本**

断言（每条一个 `ok()`）：
1. `electron/backend/proxy/monkeycode/` 目录不存在。
2. `require("../electron/backend/proxy/monkeycode/adapter.cjs")` 抛 `MODULE_NOT_FOUND`。
3. `store.CHANNELS` 里不含 `monkeycode` / `monkeycode_intl`（在 `AGENTHUB_DATA_DIR` 临时目录下 `require` store）。
4. `adapters.get("monkeycode") === null` 且 `adapters.get("monkeycode_intl") === null`。
5. `tools/proxy-monkeycode-selftest.cjs` 不存在。
6. 源码目录扫描（排除 `node_modules` / `dist` / `release` / `docs/superpowers`）：`src/`、`electron/`、`tools/`、`scripts/`、`README.md`、`AGENTS.md` 里不存在 `monkeycode`（不区分大小写）。
7. `src/assets/channels/monkeycode.png` 不存在。
8. `rules.cjs` 的默认配置里不存在 `monkeycode` 段。

脚本结构与 `scripts/test-remote-removed.cjs` 一致：顶部版权头、`AGENTHUB_DATA_DIR` 指向 `fs.mkdtempSync` 临时目录、结尾打印 `通过 / 失败` 并以 `process.exit(failed ? 1 : 0)` 收尾。

- [ ] **Step 2: 跑一次，确认是红的**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 多数断言 FAIL（代码还在），退出码 1。

---

### Task 2: 后端下线

**Files:**
- Delete: `electron/backend/proxy/monkeycode/`（整目录，12 个 `.cjs`）
- Modify: `electron/backend/proxy/adapters.cjs:4664-4672`
- Modify: `electron/backend/proxy/store.cjs:217-221`
- Modify: `electron/backend/proxy/rules.cjs:507-514`
- Modify: `electron/backend/proxy/discovery.cjs:41-43` / `3274-3362` / `3374-3375` / `3817-3819`
- Modify: `electron/backend/proxy/index.cjs:138-143` / `171-173` / `1280` / `1293-1296` / `1302` / `1309` / `1312` / `1322`

**Interfaces:**
- Consumes: Task 1 的守卫脚本（判定后端部分转绿）。
- Produces: `adapters.get("monkeycode*")` 返回 `null`；`store.CHANNELS` 不含该渠道；`discovery.beginOAuth` 不再有该分支。

- [ ] **Step 1: 删适配器目录与注册**

删 `electron/backend/proxy/monkeycode/` 整个目录。删 `adapters.cjs` 的 `// ===== MonkeyCode 双站（国内版 / 国际版）=====` 注释块与 `require` + 两行 `ADAPTERS.monkeycode*` 赋值（4664-4672）。

- [ ] **Step 2: 删渠道表条目**

删 `store.cjs` 中 `CHANNELS` 数组里的两行条目及其上方 3 行注释（217-221）。注意 `BUILTIN_IDS` 由 `CHANNELS` 派生（227 行），无需另改。

- [ ] **Step 3: 删默认规则段**

删 `rules.cjs` 中 `headers.json` 默认值里的 `// ===== MonkeyCode 双站…` 注释块与 `monkeycode: {},` / `monkeycode_intl: {},`（507-514）。

- [ ] **Step 4: 删登录流程**

`discovery.cjs`：删 41-43 三行 `require`（`mcRegion` / `mcCredentials` / `mcEndpoints`）；删 3274-3362 整段（`saveMonkeyCodeAccount` + `beginMonkeyCodeOAuth`）；删 3374-3375 两行分发判断；删 3817-3819 三行导出。

- [ ] **Step 5: 删"只许弹窗登录"的后端闸**

`index.cjs`：
- 删 `parseAccountsJson` 里 138-143 的 `oauth-only` 分支；
- 删 171-173 的 `OAUTH_ONLY_MESSAGE` 常量；
- 删 1280 声明里的 `oauthOnly` 计数、1293-1296 的 `oauth-only` 分支、1302 的 `OAUTH_ONLY_MESSAGE` 判定、1309 的文案拼接、1312 返回对象里的 `oauthOnly` 字段、1322 的 `reason === "oauth-only"` 判定。
- 保留 `metadata-only` 相关的既有逻辑不动。

- [ ] **Step 6: 跑守卫，确认后端部分转绿**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 断言 1/2/3/4/8 通过；前端与文档相关断言仍 FAIL。

- [ ] **Step 7: 跑后端相关自测，确认没删坏**

Run（逐个）：
```
node tools/gateway-closure-check.cjs
node tools/command-table-selftest.cjs
node tools/admin-deny-ui-selftest.cjs
```
Expected: 闭包自检只报"文件数低于下限"（Task 5 会下调下限），不得报"闭包存在缺失文件"；另两个全绿。

---

### Task 3: 前端下线

**Files:**
- Modify: `src/types/index.ts:117`
- Modify: `src/views/proxy/format.ts:16` / `212-213`
- Modify: `src/views/proxy/channelIcons.ts:34-35` / `54-55`
- Modify: `src/views/proxy/ProxyAgentsView.vue:235-237`
- Modify: `src/views/proxy/ProxyModelsView.vue:96`
- Delete: `src/assets/channels/monkeycode.png`

**Interfaces:**
- Consumes: Task 1 守卫脚本。
- Produces: `ProxyChannelId` 联合类型不含该 id；`CHANNEL_NAMES` / `CHANNEL_ICONS` 无该键。

- [ ] **Step 1: 删类型与显示名**

`src/types/index.ts:117`：从 `ProxyChannelId` 联合类型里去掉 `"monkeycode"` 与 `"monkeycode_intl"`。
`src/views/proxy/format.ts`：删 212-213 两行映射；16 行的举例注释把 `MonkeyCode` 换成仍在册的渠道（如 `Loomy`），保持"厘→积分"那条说明成立。

- [ ] **Step 2: 删图标 import 与映射 + 删图标文件**

`channelIcons.ts`：删 34-35（注释 + import）与 54-55（两行映射）；删除文件 `src/assets/channels/monkeycode.png`。

- [ ] **Step 3: 删页签门控分支**

`ProxyAgentsView.vue`：删 235-237（注释 + `if (channel === "monkeycode" || channel === "monkeycode_intl") return key === "oauth";`）。

- [ ] **Step 4: 改举例注释**

`ProxyModelsView.vue:96`：把举例里的 `MonkeyCode` 换成仍在册的渠道（如 `Loomy`），该注释讲的是"同名模型来自不同渠道"的归属规则，换成哪个在册渠道都不影响语义。

- [ ] **Step 5: 跑守卫，确认前端部分转绿**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 只剩文档/自测相关断言 FAIL（Task 5 处理）。

- [ ] **Step 6: 验证未知渠道 id 的显示兜底**

读 `src/views/proxy/format.ts` 的 `channelName`（`CHANNEL_NAMES[id] || id || "-"`）与 `channelIcons.ts` 的 `channelInitial`，确认删掉映射后传入未知渠道 id 会退回显示 id 本身、不会抛错。桌面端启动一次号池页，确认不会因为本地状态里残留的 `monkeycode` 渠道 id 而白屏。
Expected: 页面正常渲染，渠道名退回显示原始 id。

- [ ] **Step 7: 前端类型门禁**

Run: `npm run build`
Expected: `vue-tsc --noEmit` 无错误、`vite build` 成功。
（若 `build` 失败并指向已删的图标或类型，说明该文件还有残余引用，回上一步补删。）

---

### Task 4: 数据库与模型目录的数据清理

**Files:**
- Modify: `electron/backend/proxy/store.cjs`（在 `open()` 的在线迁移段之后追加一段幂等清理）
- Modify: `scripts/test-monkeycode-removed.cjs`（新增断言）

**Interfaces:**
- Consumes: Task 2 的 `CHANNELS` 变更。
- Produces: 升级到新版本后，旧库里的 `agents` 两行与 `accounts` 里该渠道的账号被自动删除。

**决策依据（用户已问）：** 旧的 `agents` / `accounts` 行**不会**因为删代码而消失（`agents` 用 `INSERT OR IGNORE` 播种，只增不删）。留着会导致界面上出现"看得见但用不了"的孤儿渠道。故在 `open()` 里做一次性幂等清理。

- [ ] **Step 1: 写清理逻辑**

在 `store.cjs` 的 `open()` 内、既有在线迁移（`ALTER TABLE …` 那几段）之后追加：

```js
// 已下线渠道的数据清理（幂等）：MonkeyCode 双站整体移除后，旧库里残留的
// agents 行与 accounts 行会让号池页出现"看得见但用不了"的孤儿渠道，这里一并删掉。
{
  const gone = ["monkeycode", "monkeycode_intl"];
  const delAgents = db.prepare("DELETE FROM agents WHERE id = ?");
  const delAccounts = db.prepare("DELETE FROM accounts WHERE channel = ?");
  for (const id of gone) {
    delAgents.run(id);
    delAccounts.run(id);
  }
}
```

- [ ] **Step 2: 加守卫断言（先造出残留数据再验证被清掉）**

在 `scripts/test-monkeycode-removed.cjs` 增加一条：在临时库里先 `INSERT` 一行 `agents(id="monkeycode", …)` 与一行 `accounts(channel="monkeycode", …)`，重新 `open()` 后再查，两行都必须已不存在。

- [ ] **Step 3: 跑守卫**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 该条断言通过。

- [ ] **Step 4: 清理模型目录残留段**

确认 `rules/catalog.json` 默认值里是否存在该渠道段；存在则删（`electron/backend/proxy/rules.cjs` 的 `catalog.json` 默认对象内，字段名与渠道 id 同名）。若默认值里本就没有，跳过此步并在计划执行记录里注明。

- [ ] **Step 5: 通知用户备份窗口**

在完成报告中提醒：该清理**会删除账号凭据且不可恢复**；如需保留，请在更新版本前用号池页的「导出凭据」先导出一份 JSON。（本次不代为操作远端。）

---

### Task 5: 自测、文档与闭包下限收尾

**Files:**
- Delete: `tools/proxy-monkeycode-selftest.cjs`
- Modify: `tools/gateway-closure-check.cjs:35`（`MIN` 默认值）
- Modify: `AGENTS.md`（「MonkeyCode 渠道：参考来源与已核实口径」整段）
- Modify: `README.md:97-98`（两行渠道表格）

**Interfaces:**
- Consumes: Task 2-4 的删除结果。
- Produces: 守卫脚本全绿；闭包自检通过。

- [ ] **Step 1: 删自测脚本**

删 `tools/proxy-monkeycode-selftest.cjs`。

- [ ] **Step 2: 下调闭包文件数下限**

Run: `node tools/gateway-closure-check.cjs`
把它输出的实际闭包文件数填进 `tools/gateway-closure-check.cjs:35` 的 `MIN` 默认值（原 109），并在该行注释里说明下调原因（本次移除该渠道 12 个文件）。不得把 `MIN` 设成低于实际值。

- [ ] **Step 3: 删文档段落**

`AGENTS.md`：删掉「## MonkeyCode 渠道：参考来源与已核实口径」整节（含"三处外部实现对照"与 8 条"已核实、不要改回去"的口径）。
`README.md`：删掉 97-98 两行渠道表格行。

- [ ] **Step 4: 跑守卫，确认全绿**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 全部通过，退出码 0。

- [ ] **Step 5: 格式校验**

Run: `npm run format:check`
Expected: 本计划改动的文件无格式问题（存量文件不在本次收编范围内）。

---

### Task 6: 全量验证

**Files:** 无改动，仅执行验证。

- [ ] **Step 1: 构建门禁**

Run: `npm run build`
Expected: 类型检查 + 前端构建均通过。

- [ ] **Step 2: 网关核心闸**

Run:
```
node scripts/dev-sink-golden.cjs
node tools/gateway-closure-check.cjs
node tools/admin-server-selftest.cjs
node tools/admin-crypto-selftest.cjs
node tools/admin-crypto-browser-selftest.cjs
node tools/web-ui-state-selftest.cjs
node tools/command-table-selftest.cjs
node tools/admin-deny-ui-selftest.cjs
```
Expected: 全绿。黄金闸若报差异，逐一核对是否只是"渠道表少了两项"引起的合法变化（选号顺序/冷却决策不应改变）。

- [ ] **Step 3: 三协议回归闸**

Run:
```
node scripts/dev-anthropic-in-test.cjs
node scripts/dev-responses-in-test.cjs
```
Expected: 全绿。

- [ ] **Step 4: 移除守卫（最终）**

Run: `node scripts/test-monkeycode-removed.cjs`
Expected: 全绿。

- [ ] **Step 5: 整理交付说明（不提交）**

把改动文件清单、验证命令与结果、以及"远程实例如何升级 + 数据会自动清理"的操作说明写成一段交付说明给用户（含 Task 4 Step 5 的备份提醒）。不执行任何 `git commit`。
