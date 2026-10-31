# ZCode 渠道完善（模型数据自更新 + 去本机依赖）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZCode 渠道在没有安装官方客户端的机器上也能用：模型能力数据自带一份（联网时按版本号自动更新到最新），并去掉「从本机软件导入」入口。

**Architecture:** 新增一个独立模块 `zcodeBuiltin.cjs` 负责「模型能力数据的三个来源（网关落盘副本 / 本机客户端目录 / 仓库内置副本）按 revision 取最新、远端拉取、原子落盘」，`zcodeLocal.cjs` 的元数据解析改为消费它；数据文件随软件打包，远端更新在 `index.cjs` 的 boot 里启动、stopTimers 里清理。

**Tech Stack:** Electron 主进程 CommonJS（`.cjs`）、Node 内置 `fetch`/`fs`/`crypto`、Vue 3 `<script setup lang="ts">`、仓库自研 `.cjs` 自测脚本（无测试框架）。

**Spec:** `docs/superpowers/specs/2026-10-31-zcode-channel-design.md`

## Global Constraints

- 仓库语言中文；提交信息用 conventional 前缀（`feat(proxy): …` / `fix(proxy): …`），全部在 `api-gateway` 分支上做。
- 格式化以根目录 `.prettierrc` 为准（printWidth 999、双引号、分号、2 空格缩进、LF）；改动文件提交前跑 `npm run format:check`。
- 网关核心位于 `electron/backend/proxy/`，全部 `.cjs`（CommonJS）。
- **本方案不新增 IPC 命令**（用户已定：模型数据版本/来源不上界面），因此不涉及 `ipc.cjs` / `preload.cjs` / `src/api/ipc.ts` / `commandTable.cjs` 的四处联动。
- 自测脚本必须沙箱化，不读写真实用户数据：`AGENTHUB_DATA_DIR`（`config.dataDir()` 已支持）、`ZCODE_V2_DIR`（zcode 数据目录）、`APPDATA`。
- 自测跑法（系统 Node 没有 `node:sqlite`，必须用仓库自带 Electron 的 Node）：
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/<脚本>.cjs`
- 类型门禁：`npm run build`（= `vue-tsc --noEmit` + `vite build`）。
- 调度核心不改动，但仍要跑 `node scripts/dev-sink-golden.cjs` 确认无回归。
- 远端接口参数按 spec 固定：`GET {clientConfigsUrl}?app_version={appVersion}&platform={platform}`，**不带鉴权头**、不跟随重定向（`redirect: "error"`）、总超时 20 秒、正文上限 10MB。
- 数据有效性判据：`schemaVersion === 1`、`revision` 为正整数、`config.modelConfigRules.modelRules` 为数组；任一不满足即判定该来源不可用。

## Review Focus

以下输入/失败模式最容易咬到用户，每条都在对应任务里加了测试：

1. **远端返回比现有更旧的配置**（CDN 回退、灰度回滚）→ 必须拒绝覆盖，否则模型能力整体倒退。
2. **远端响应畸形**（`code !== 0`、缺 `builtin_provider_config_json`、下载体不是合法 release、URL 带用户名密码）→ 保留现有数据、不抛错到用户。
3. **三个来源 revision 相同**→ 选择结果必须稳定（不来回切换），否则同一台机器两次请求的模型能力可能不同。
4. **全新机器（无客户端、无落盘副本）**→ 必须用仓库内置副本，模型能力与官方客户端一致（不能退化成 131072/8192 的硬编码默认值）。
5. **内置副本缺失或损坏**（打包漏文件、文件被改坏）→ 不崩溃，退回现有嗅探/保守默认，并留下诊断线索。
6. **绕过界面直接调 `proxy_scan_import` 导入 zcode 候选** → 后端拒绝（只关界面不算完成）。
7. **登录时传了一个无效的 provider 值**（大小写不符、带空格、空串，或干脆没传）→ 必须回落到默认的 Z.ai 并正常打开授权页，不得抛错、不得登录到错误的一家。

---

### Task 1: 新增 `zcodeBuiltin.cjs` 纯函数层（来源选择 + 校验 + 映射）

**Files:**
- Create: `electron/backend/proxy/zcodeBuiltin.cjs`
- Create: `tools/proxy-zcode-builtin-selftest.cjs`

**Interfaces:**
- Produces（后续任务依赖这些精确签名）：
  - `validateRelease(json) -> { ok: true, release: { revision: number, schemaVersion: 1, modelRules: ModelRule[] } } | { ok: false, reason: string }`，其中 `ModelRule = { re: string, fmt: object|null, contextWindow: number|undefined, maxOutputTokens: number|undefined }`（形状与现有 `zcodeLocal.readClientModelRules()` 完全一致）
  - `pickLatestRelease(sources: Array<{ origin: "stored"|"client"|"builtin", revision: number, raw: object }>) -> { origin, revision, raw } | null`（按 `revision` 取最大；相同时按 `stored > client > builtin` 取胜出者）
  - `buildClientConfigsUrl(clientConfigsUrl, appVersion, platform) -> string`
  - `resolveModelRules(deps) -> Promise<{ rules: ModelRule[], origin: string, revision: number } | null>`，`deps = { storedFile, clientDirs: string[], builtinFile }`（本任务里 `clientDirs` 由调用方传入，便于自测传 fixture 目录）
  - `cachedModelRules() -> ModelRule[]`（进程内缓存：返回最近一次成功解析的规则；尚无数据或最近一次解析失败时返回 `[]`，供同步的 `resolveModelMeta()` 消费）

- [ ] **Step 1: 写失败测试**（`tools/proxy-zcode-builtin-selftest.cjs`）

用现有 `tools/proxy-channels-selftest.cjs` 的 `eq/ok` 计数风格（`pass`/`fail`，末尾 `process.exit(fail ? 1 : 0)`），至少覆盖：

```js
// 合成样本：revision 43 的合法 release
const rel = (rev) => ({ schemaVersion: 1, revision: rev, config: { modelConfigRules: { modelRules: [{ modelMatch: ".*glm-5\\.3", config: { properties: { contextWindow: 1000000 }, optionSpecs: { maxOutputTokens: { max: 128000 } } } }] } } });

eq(validateRelease(rel(43)).ok, true, "合法 release 通过校验");
eq(validateRelease({ schemaVersion: 2, revision: 1, config: {} }).ok, false, "schemaVersion 非 1 拒绝");
eq(validateRelease({ schemaVersion: 1, revision: 0, config: {} }).ok, false, "revision 非正整数拒绝");
eq(validateRelease({ schemaVersion: 1, revision: 2, config: {} }).ok, false, "modelRules 非数组拒绝");

// 来源选择：取 revision 最大
eq(pickLatestRelease([{ origin: "stored", revision: 40, raw: rel(40) }, { origin: "builtin", revision: 43, raw: rel(43) }]).revision, 43, "取最大 revision");
// 同 revision 稳定性
eq(pickLatestRelease([{ origin: "builtin", revision: 43, raw: rel(43) }, { origin: "stored", revision: 43, raw: rel(43) }]).origin, "stored", "同 revision 优先 stored");
// 空输入
eq(pickLatestRelease([]), null, "无来源返回 null");

// 规则映射：形状与 zcodeLocal 现有口径一致（逐属性覆盖）
const rules = validateRelease(rel(43)).release.modelRules;
eq(rules[0].contextWindow, 1000000, "contextWindow 映射");
eq(rules[0].maxOutputTokens, 128000, "maxOutputTokens 映射");

// URL 构造
ok(buildClientConfigsUrl("https://zcode.z.ai/api/v1/client/configs", "4.1.10", "win32-x64").includes("app_version=4.1.10"), "URL 带 app_version");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-builtin-selftest.cjs`
Expected: 失败（`Cannot find module '../electron/backend/proxy/zcodeBuiltin.cjs'`）

- [ ] **Step 3: 实现纯函数**（`zcodeBuiltin.cjs`）

要点：
- 文件头保留仓库惯例的版权声明块（与同目录既有 `.cjs` 一致），文件内注释中文。
- `validateRelease` 的规则映射**直接复用现有** `zcodeLocal.readClientModelRules()` 里的字段取值口径（`config.modelConfigRules.modelRules` → `{ modelMatch, config.properties, config.optionSpecs.maxOutputTokens.max }`），保证行为等价。
- `pickLatestRelease` 的排序：先按 `revision` 降序，再按 `stored(0) < client(1) < builtin(2)` 升序。
- 纯函数，不读文件、不发请求。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: 全部通过、退出码 0

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/zcodeBuiltin.cjs tools/proxy-zcode-builtin-selftest.cjs
git commit -m "feat(proxy): ZCode 模型能力数据来源选择与校验（纯函数层）"
```

---

### Task 2: 把官方内置配置副本放进仓库

**Files:**
- Create: `scripts/dev-zcode-builtin-fetch.cjs`
- Create: `electron/backend/proxy/assets/zcode-builtin.json`
- Modify: `.prettierignore`（若无该文件则新建，加一行 `electron/backend/proxy/assets/`）
- Test: `tools/proxy-zcode-builtin-selftest.cjs`（追加断言）

**Interfaces:**
- Consumes: Task 1 的 `validateRelease`、`buildClientConfigsUrl`
- Produces: 内置副本文件 `electron/backend/proxy/assets/zcode-builtin.json`（合法 release，`revision` 为拉取时的值）

- [ ] **Step 1: 写一次性拉取脚本**（`scripts/dev-zcode-builtin-fetch.cjs`）

行为（中文注释说明用途：官方渠道更新后手动跑一次、把结果提交）：
1. `GET {clientConfigsUrl}?app_version=4.1.10&platform=win32-x64`（无鉴权头、`redirect: "error"`、20 秒超时）；
2. 取 `data.configs.builtin_provider_config_json`，`GET` 该地址；
3. `validateRelease` 通过后写入 `electron/backend/proxy/assets/zcode-builtin.json`（紧凑 JSON，不缩进，避免无谓体积）；
4. 打印 `revision` 与字节数；失败时非零退出并说明原因。

- [ ] **Step 2: 跑一次生成内置副本**

Run: `node scripts/dev-zcode-builtin-fetch.cjs`
Expected: 打印形如 `已写入 revision=43（137906 字节）`，文件出现在 `electron/backend/proxy/assets/`。

（spec 实测基线：`revision=43`、`schemaVersion=1`、137906 字节。）

- [ ] **Step 3: 追加测试断言内置副本可用**

```js
const builtin = JSON.parse(fs.readFileSync(path.join(__dirname, "../electron/backend/proxy/assets/zcode-builtin.json"), "utf8"));
eq(validateRelease(builtin).ok, true, "仓库内置副本通过校验");
ok(builtin.revision >= 43, "内置副本 revision 不低于实测基线 43");
```

- [ ] **Step 4: 跑测试 + 类型门禁**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-builtin-selftest.cjs`
Expected: 通过
Run: `npm run build`
Expected: 无类型错误

- [ ] **Step 5: 确认打包会把该文件带进安装包**

检查 `package.json` 的 electron-builder `files` 配置包含 `electron/**/*`（已核实包含），无需改动；若实现时发现被 `!` 规则排除，则显式加白名单。

- [ ] **Step 6: 提交**

```bash
git add scripts/dev-zcode-builtin-fetch.cjs electron/backend/proxy/assets/zcode-builtin.json .prettierignore tools/proxy-zcode-builtin-selftest.cjs
git commit -m "feat(proxy): 内置一份 ZCode 官方模型能力配置（含一次性拉取脚本）"
```

---

### Task 3: `resolveModelMeta` 改为消费三来源数据

**Files:**
- Modify: `electron/backend/proxy/zcodeLocal.cjs:955-1031`（`findClientBuiltin` / `readClientModelRules` / `resolveModelMeta`）
- Modify: `electron/backend/proxy/zcodeBuiltin.cjs`（补 `resolveModelRules` 的文件 IO 分支）
- Test: `tools/proxy-zcode-selftest.cjs`（追加断言）

**Interfaces:**
- Consumes: Task 1 的 `validateRelease` / `pickLatestRelease`；Task 2 的内置副本
- Produces: `zcodeLocal.resolveModelMeta(modelId)` 行为不变（返回 `{ inputFormat, contextWindow, maxOutputTokens } | null`），但数据源变为三来源取最新；`zcodeBuiltin.resolveModelRules(deps)` 落地实现

- [ ] **Step 1: 写失败测试**

在 `tools/proxy-zcode-selftest.cjs` 追加（该脚本已沙箱 `ZCODE_V2_DIR` / `APPDATA`，可直接用）：

```js
// 全新机器：没有客户端目录、没有落盘副本 → 必须用仓库内置副本，拿到真实能力（不是 131072/8192 默认值）
const meta = zcodeLocal.resolveModelMeta("GLM-5.3");
eq(meta && meta.contextWindow, 1000000, "GLM-5.3 上下文来自内置副本（1000000）");
eq(meta && meta.maxOutputTokens, 128000, "GLM-5.3 输出上限来自内置副本（128000）");
eq(meta && meta.inputFormat && meta.inputFormat.supportsImage, false, "GLM-5.3 不支持图片");

const flash = zcodeLocal.resolveModelMeta("GLM-5.3-Flash");
eq(flash && flash.inputFormat && flash.inputFormat.supportsImage, true, "GLM-5.3-Flash 支持图片");

// 内置副本损坏 / 不存在：不抛错，返回 null（调用方退回嗅探与保守默认）
const bad = zcodeBuiltin.resolveModelRules({ storedFile: path.join(SANDBOX, "no-such.json"), clientDirs: [], builtinFile: path.join(SANDBOX, "broken.json") });
eq(await bad, null, "无可用来源时返回 null 而不抛");
fs.writeFileSync(path.join(SANDBOX, "broken.json"), "{ 不是合法 JSON");
const bad2 = zcodeBuiltin.resolveModelRules({ storedFile: path.join(SANDBOX, "no-such.json"), clientDirs: [], builtinFile: path.join(SANDBOX, "broken.json") });
eq(await bad2, null, "损坏的内置副本返回 null 而不抛");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-selftest.cjs`
Expected: 断言失败（沙箱里没有客户端目录，当前实现返回 `null`）

- [ ] **Step 3: 实现 `resolveModelRules` 的文件 IO 与优先级**

要点：
- `storedFile` = `path.join(config.dataDir(), "proxy", "zcode-builtin.json")`。
- `clientDirs` = 现有 `zcodeLocal.findClientBuiltin()` 的搜索根 `path.join(v2Dir(), "runtime", "provider")`（沿用现有深度 4 的递归找 `zcode-builtin.json` 规则）。
- `builtinFile` = `path.join(__dirname, "assets", "zcode-builtin.json")`。
- 三个来源各自 `validateRelease` 后交给 `pickLatestRelease`；全部不可用返回 `null`。
- 保留按文件 mtime 的缓存（现有 `_capCache` 的做法），并在 `storedFile` 变化时失效。
- 解析失败（文件损坏 / JSON 非法）只跳过该来源，不抛错。

- [ ] **Step 4: 改 `zcodeLocal.cjs` 让它消费新模块**

要点：
- `readClientModelRules()` 改为调用 `zcodeBuiltin.resolveModelRules(...)`（异步）；同步的 `resolveModelMeta()` 若无法改成异步，则在模块内维护一份进程内缓存：`zcodeBuiltin` 提供一个同步读缓存的入口（如 `cachedModelRules()`），由启动时的更新流程与 `resolveModelRules` 填充。
- `resolveModelMeta()` 的逐属性覆盖逻辑**保持原样**（那是实测得出的语义：通用规则给窗口/上限、专用规则只补能力，见现有注释）。
- 保持 `resolveModelInputFormat()` 的兼容导出不变。

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 2
Expected: 新增断言全部通过，既有断言无回归

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/zcodeBuiltin.cjs electron/backend/proxy/zcodeLocal.cjs tools/proxy-zcode-selftest.cjs
git commit -m "fix(proxy): ZCode 模型能力改读三来源最新一份，无客户端机器不再退化成默认值"
```

---

### Task 4: 远端更新（拉取、校验、原子落盘、定时）

**Files:**
- Modify: `electron/backend/proxy/zcodeBuiltin.cjs`（补 `fetchRemoteRelease` / `writeStoredRelease` / `startUpdater` / `stopUpdater`）
- Modify: `electron/backend/proxy/index.cjs`（boot 启动、`stopTimers` 清理）
- Test: `tools/proxy-zcode-builtin-selftest.cjs`（追加断言，用假 fetch）

**Interfaces:**
- Consumes: Task 1 的纯函数
- Produces:
  - `fetchRemoteRelease({ clientConfigsUrl, appVersion, platform, fetchImpl, timeoutMs }) -> Promise<object|null>`（失败/畸形一律返回 `null`，不抛）
  - `writeStoredRelease(file, release, otherRevisions: number[]) -> boolean`（仅当 `release.revision` 大于所有现有来源的最大值时才写，返回是否写入）
  - `startUpdater({ getConfig, fetchImpl }) -> void` / `stopUpdater() -> void`

- [ ] **Step 1: 写失败测试**（假 fetch，不联网）

```js
// ① code !== 0 → null
// ② 缺 builtin_provider_config_json → null
// ③ 下载体畸形（schemaVersion=2）→ null
// ④ 正常两跳 → 返回 release
// ⑤ URL 带用户名密码 → null（不请求）
// ⑥ writeStoredRelease：新 revision 更小 → 返回 false 且文件未变
// ⑦ writeStoredRelease：新 revision 更大 → 返回 true 且文件内容为新
```

（每条都写成 `ok(...)` 断言，`fetchImpl` 用返回合成 `Response` 的桩函数。）

- [ ] **Step 2: 跑测试确认失败**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-builtin-selftest.cjs`
Expected: 失败（函数不存在）

- [ ] **Step 3: 实现远端拉取与落盘**

要点：
- 两跳请求都用 `AbortSignal.timeout(20000)`；`credentials: "omit"`、`redirect: "error"`；正文读取前判 `content-length`/累计字节，超过 10MB 放弃。
- 落盘用现有 `zcodeLocal.atomicWriteJson()` 口径（临时文件 + rename），并确保父目录 `path.join(config.dataDir(), "proxy")` 存在。
- 未捕获异常一律转成 `null` + 诊断（`console.warn("[zcode] …")`，与 `zcodeOfficialSystem` 的告警风格一致）。

- [ ] **Step 4: 实现 `startUpdater` / `stopUpdater`**

要点：
- 启动后延迟约 10 秒执行首次拉取；成功间隔 1 小时；失败退避 15 分钟起、每次翻倍、上限 6 小时（用 `setTimeout` 链，不用固定 `setInterval`，便于动态改间隔）。
- 同一进程内串行：一次只有一个在途请求。
- 每次成功后调用 `zcodeLocal.resetPlanCache()`（或等价的缓存失效入口），保证下一次解析用新数据。
- `stopUpdater()` 清掉定时器与在途 AbortController。

- [ ] **Step 5: 接入 `index.cjs` 生命周期**

- `boot()`（`index.cjs:517`）里在 `credits.startScheduler(...)` 附近启动：`zcodeBuiltin.startUpdater({ getConfig: () => rules.get("headers.json").zcode })`。
- `stopTimers()`（`index.cjs:548`）里调用 `zcodeBuiltin.stopUpdater()`。
- 注意 `rules.get("headers.json").zcode` 已含 `clientConfigsUrl` / `appVersion` / `platform`（`rules.cjs:326-353`），不要新造配置项。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-builtin-selftest.cjs`
Expected: 通过
Run: `node scripts/dev-sink-golden.cjs`
Expected: 黄金字节等值通过（未改调度）

- [ ] **Step 7: 提交**

```bash
git add electron/backend/proxy/zcodeBuiltin.cjs electron/backend/proxy/index.cjs tools/proxy-zcode-builtin-selftest.cjs
git commit -m "feat(proxy): ZCode 模型配置联网自动更新（按 revision 取新、失败保留旧数据）"
```

---

### Task 5: ZCode 添加入口改造（去掉「从本机软件导入」+ 登录可选 Z.ai / BigModel）

**Files:**
- Modify: `src/views/proxy/ProxyAgentsView.vue`（`addTabAllowed()` 约 219-231 行；ZCode 的 OAuth 面板加「Z.ai / BigModel」二选一）
- Modify: `electron/backend/proxy/discovery.cjs`（`scanAll()` 596-597；新增 `isScanImportAllowed()`；`beginZcodeOAuth()` 约 1764 行接收 provider；`exchangeZcodeAuthCode()` 约 1893 行接收 provider；`submitCallbackUrl()`）
- Modify: `electron/backend/proxy/index.cjs`（`proxy_scan_import` 约 1122 行；`proxy_oauth_begin` 约 1137 行透传 `zcodeProvider`；`proxy_oauth_submit_callback` 约 1231 行透传）
- Modify: `electron/backend/proxy/adapters.cjs`（`refreshToken()` 文案，约 4316 行）
- Modify: `electron/backend/proxy/zcodeSwitch.cjs`（「未找到本机 ZCode 登录文件…」提示，约 151 行）
- Modify: `src/api/ipc.ts`（`proxyOauthBegin` 约 233 行 / `proxyOauthSubmitCallback` 约 258 行 增加可选 `zcodeProvider` 参数）
- Test: 新建 `tools/proxy-zcode-scan-removed-selftest.cjs`

**Interfaces:**
- Consumes: `discovery.beginOAuth(channel, onDone, helpers, opts)` 的既有 `opts` 参数通道
- Produces:
  - `discovery.isScanImportAllowed(channel) -> boolean`（`zcode` 返回 `false`，其余渠道保持现状）
  - `discovery.scanAll()` 结果不再含 `channel === "zcode"`
  - 登录通道新增参数 `zcodeProvider: "zai" | "bigmodel"`（缺省 `"zai"`；非法值回落配置默认 `rules.zcode.oauthProvider`）
  - **不新增 IPC 命令**：`proxy_oauth_begin` / `proxy_oauth_submit_callback` 均为既有命令，`preload.cjs` 白名单不用改

- [ ] **Step 1: 写失败测试**

```js
const discovery = require("../electron/backend/proxy/discovery.cjs");
eq(discovery.isScanImportAllowed("zcode"), false, "zcode 不允许本机扫描导入");
eq(discovery.isScanImportAllowed("trae"), true, "trae 保持允许");
ok(!discovery.scanAll().some((c) => c.channel === "zcode"), "扫描汇总不含 zcode 候选");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-scan-removed-selftest.cjs`
Expected: 失败（`isScanImportAllowed` 未定义）

- [ ] **Step 3: 实现后端改动（下线本机导入）**

- `discovery.cjs`：新增导出 `isScanImportAllowed(channel)`；`scanAll()` 摘除 `scanZcode()`（`scanZcode` 函数体与导出按实现者判断保留或删除，两者行为等价）。
- `index.cjs` 的 `proxy_scan_import`：调用 `discovery.isScanImportAllowed(channel || candidate.channel)`，不允许时返回失败并给出理由（参考现有 `OAUTH_ONLY_MESSAGE` 的写法，`index.cjs:171`）。

- [ ] **Step 4: 实现登录可选 Z.ai / BigModel**

要点：
- `discovery.beginZcodeOAuth(channel, onDone, opts)`：`const provider = ["zai","bigmodel"].includes(String(opts && opts.provider)) ? String(opts.provider) : String(c.oauthProvider || "zai")`；把选中的 provider 记进 OAuth 会话，供兜底回调取用。
- `beginOAuth()` 把 `opts` 透传给 `beginZcodeOAuth`。
- `index.cjs` 的 `proxy_oauth_begin` 从入参取 `zcodeProvider` 放进 `beginOAuth` 的 `opts`。**不要复用 `vendor`**——那是 AutoClaw 国际版的 zai/google 语义，两者含义不同。
- 粘贴深链兜底：`exchangeZcodeAuthCode(code, state, provider)` 与 `submitCallbackUrl(url, channel, provider)` 接收 provider；`index.cjs` 的 `proxy_oauth_submit_callback` 从入参取 `zcodeProvider` 传下去；无入参时按会话里记的 provider，再退回配置默认（否则 BigModel 的深链会按 Z.ai 兑换而失败）。
- `src/api/ipc.ts`：`proxyOauthBegin(channel, zcodeProvider?)`、`proxyOauthSubmitCallback(channel, url, zcodeProvider?)`——保持既有调用点不传第二个参数也能工作。
- **不做**"两家都试"的自动回退：会把账号与额度的归属搞乱。

- [ ] **Step 5: 改界面与文案**

- `ProxyAgentsView.vue` 的 `addTabAllowed()`：加一条 `if (channel === "zcode" && key === "local") return false;`（`local` 页签不出现；oauth / file / paste 保留）。
- 同文件 ZCode 的 OAuth 面板加「Z.ai / BigModel」二选一（默认 Z.ai），选择随登录与兜底提交一起传；面板文案说明"BigModel 的账号请选 BigModel"。
- `adapters.cjs` 的 `refreshToken()` 文案改为「ZCode 凭据长期有效（无自动刷新端点）；凭证失效时请重新 OAuth 登录或粘贴凭据导入」。
- `zcodeSwitch.cjs` 的凭据缺失提示改为不再引导安装客户端（该能力在无客户端机器上已被 Task 6 禁用）。

- [ ] **Step 6: 跑测试 + 类型门禁**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-scan-removed-selftest.cjs`
Expected: 通过
Run: `npm run build`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/views/proxy/ProxyAgentsView.vue src/api/ipc.ts electron/backend/proxy/discovery.cjs electron/backend/proxy/index.cjs electron/backend/proxy/adapters.cjs electron/backend/proxy/zcodeSwitch.cjs tools/proxy-zcode-scan-removed-selftest.cjs
git commit -m "feat(proxy): ZCode 去掉「从本机软件导入」并支持登录选择 Z.ai/BigModel"
```

---

### Task 6: 无客户端环境下的界面降级 + 全量回归

**Files:**
- Modify: `src/views/proxy/ProxyAgentsView.vue`（`ideSupported()` 954-962 及其调用点；`claimGate` / `deviceGate` / `restoreGate` / `rollbackGate` 240-250）
- Test: 人工核对 + `npm run build` + 既有自测全跑

**Interfaces:**
- Consumes: `proxy_ide_status` 返回的 `channels.zcode.installed`（`ideswitch.cjs` 已有）

- [ ] **Step 1: 界面处置**

在 `ProxyAgentsView.vue` 里让 ZCode 的这四类入口在「本机没有客户端」时禁用并给出明确理由（沿用现有 `denyState(...)` + tooltip 的写法）：

| 入口 | 无客户端时的表现 |
| --- | --- |
| 切号（写为本机登录态，走 `ideSupported`） | 禁用 + 「需要本机安装并登录 ZCode 客户端」 |
| 领取模式（`proxy_zcode_claim_mode`） | 禁用 + 同上 |
| 恢复本机指纹 / 切号回滚 | 禁用 + 同上 |
| 指纹诊断 / 指纹修复 | **保持可用**（指纹是网关自己的数据），但提示里不再指引「去官方客户端领取」 |

判定依据统一用 `ideStatus.value.zcodeInstalled !== false`（现有 `ideSupported()` 对 zcode 的口径），不要新造探测。

- [ ] **Step 2: 人工核对（装了客户端的机器行为不变）**

在本机（装了 ZCode）打开号池页，确认：四个入口仍可用、文案与改动前一致；把界面切到「无客户端」的判定分支（可临时改 `ideStatus` 桩数据）确认禁用与提示正确。

- [ ] **Step 3: 全量回归**

```bash
npm run build
node scripts/dev-sink-golden.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-selftest.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-channels-selftest.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-channel-defer-selftest.cjs
```
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/views/proxy/ProxyAgentsView.vue
git commit -m "feat(proxy): ZCode 无客户端环境下的界面降级（切号/领取模式禁用并说明）"
```

---

## 真机验证（不属于代码任务，交付前必做）

在目标机器（`192.168.2.129`，无 ZCode 客户端）上确认三件事，任一项不通过都要回到 spec 重新讨论：

1. **授权页登录能走通**：打开添加账号 → OAuth 登录 → 浏览器完成授权 → 无需本机客户端，账号自动入池（依赖服务端轮询；若浏览器停在 `zcode://` 页面，用「粘贴导入」兜底）。
2. **模型目录不是默认值**：连续添加两个账号后拉取模型目录，确认 GLM-5.3 的上下文为 1000000、输出上限 128000（若显示 131072/8192 说明内置副本没生效）。
3. **余额能更新**：账号行能看到额度，等待一个刷新周期（默认 30 分钟）或手动刷新后数值有更新。
4. **签到链路可用**：手动点一次「签到」能返回明确结果（有可领奖励 → 弹人工过码窗口；无可领 → 如实提示「当前没有可领取的奖励活动」）。这一步不会消耗领取资格，可以放心点；真有可领奖励且需要过码时，如实记录"需人工完成"即可。

## 交付前检查

- [ ] 两个自测脚本都在 `api-gateway` 分支且能跑通
- [ ] `npm run format:check` 对本次改动文件通过
- [ ] `docs/superpowers/specs/2026-10-31-zcode-channel-design.md` 与本计划一并提交（用户已定：实施后一起提交）
- [ ] spec 第九节的三个风险项在真机验证里逐条确认或如实记录未通过
