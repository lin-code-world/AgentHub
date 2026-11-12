# MiniMax Code 渠道实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「MiniMax Code（国内站）」渠道：设备码登录入池、Anthropic 上游对话转发、积分余额、每日签到、模型目录，全部复用既有调度与签到框架。

**Architecture:** 一渠道一目录 `electron/backend/proxy/minimaxcode/`，逐文件拆成端点常量、签名、OAuth、身份、目录、余额、签到、适配器；适配器只做编排与协议转换（翻译复用 `zcodeAnthropic.cjs`），刷新与重试交给通用层（`attemptChat` / `credits.refreshAccount`）。渠道注册沿用「`CHANNELS` 一行 + `ADAPTERS` 挂载 + `headers.json` 一块 + `discovery` 一个分支」。

**Tech Stack:** Node.js CommonJS（`.cjs`）、Electron 主进程、Vue 3 `<script setup lang="ts">`、`node:https` 既有 `httpJson` / `fetchStream` / `pumpSse`、better-sqlite3 号池库。

**Spec:** `docs/superpowers/specs/2026-11-12-minimaxcode-channel-design.md`

## Global Constraints

- 渠道 id `minimaxcode`，显示名「MiniMax Code」，只做国内站（`agent.minimax.cn` / `account.minimax.cn` / `www.minimaxi.com`）。
- 必需适配器方法：`cfg / models / chat / queryCredits`（`assertAdapterContract` 启动期断言，缺一即抛错）。
- 新文件带仓库版权头注释块（照 `loomy/*.cjs` 的文件头）。
- 代码 2 空格缩进、LF、UTF-8、双引号、分号、printWidth 999（`.prettierrc`）。
- 自测一律 `AGENTHUB_DATA_DIR` 指向临时目录，不出网、不读写真实用户数据。
- 一律中文注释与中文报错文案；不新增第三方依赖。
- 不改 `pool.cjs` / `server.cjs` 主干；渠道私有逻辑只能落在 `minimaxcode/` 目录里。
- access token 是 opaque（`mmoat_` 前缀），**不得**用 `util.jwtDecode` 推到期。

## Review Focus

1. **只回 `user_code` 的登录变体**：部分账号的 `oauth2/device/code` 不返回 `device_code`，此时轮询必须改用 `user_code` 作凭据，否则登录卡死。
2. **opaque token 的预刷新**：不实现 `tokenExpiryMs` 时 `ensureFreshSecrets` 认为「无到期」永不预刷新；实现了但用默认 24 小时窗口，会把每轮余额刷新都变成一次续期，花光一次性 refresh token。
3. **同一 refreshToken 并发刷新**：两个并发 401 同时进入刷新时，只能发生一次上游请求；第二次必须复用结果或直接返回失败，不能二次花费。
4. **模型目录拉取失败/为空**：必须保留上一份清单、如实报错，绝不写入空清单或编造模型名。
5. **两种 401 错误体**：对话上游是 `{"code":401,"message":"auth failed"}`，账号接口是 `{"error":"invalid access token"}`；分类器必须都判成 auth，不能把账号接口的 401 漏成普通错误。
6. **签到当天已领**：`claim_result === 2` 必须判为成功（幂等），否则界面每天都报失败。

---

### Task 1: 渠道骨架与注册

**Files:**
- Modify: `electron/backend/proxy/store.cjs`（`CHANNELS` 数组，约 172-218 行）
- Modify: `electron/backend/proxy/rules.cjs`（`"headers.json"` 块尾部，约 509 行后）
- Create: `electron/backend/proxy/minimaxcode/adapter.cjs`
- Modify: `electron/backend/proxy/adapters.cjs`（文件尾部的渠道 `require` 区与 `ADAPTERS` 挂载）

**Interfaces:**
- Produces: `require("./minimaxcode/adapter.cjs")` → `makeMinimaxCode(deps)`，`deps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs }`；返回对象至少含 `id`、`cfg()`、`models()`、`chat()`、`queryCredits()`（本任务先给最小实现：`models()` 返回 `[]`，其余抛 `new Error("尚未实现")`）。
- Consumes: `adapters.cjs` 里既有的 `catalogMap`、`fetchStream`、`firstByteBudgetMs`、`getPendingCaptcha` 等（照 `loomy/adapter.cjs` 的 `makeLoomy(deps)` 形态注入）。

- [ ] **Step 1: 写失败测试（双表一致性）**

在 `tools/proxy-minimaxcode-selftest.cjs` 新建文件，先只写第一节：

```js
const assert = require("node:assert/strict");
const path = require("node:path");
process.env.AGENTHUB_DATA_DIR = path.join(process.env.TEMP, "agenthub-minimaxcode-selftest");
const store = require("../electron/backend/proxy/store.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");

function testRegistry() {
  const row = store.CHANNELS.find((c) => c.id === "minimaxcode");
  assert.ok(row, "CHANNELS 里应有 minimaxcode");
  assert.equal(row.display, "MiniMax Code");
  assert.equal(row.domain, "agent.minimax.cn");
  assert.equal(row.costTier, undefined, "不要标 costTier");
  const report = adapters.consistencyReport();
  assert.deepEqual(report.channelsWithoutAdapter, []);
  assert.deepEqual(report.adaptersWithoutChannel, []);
  assert.equal(typeof adapters.get("minimaxcode").cfg, "function");
}

testRegistry();
console.log("ok - 渠道注册");
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `AssertionError`（CHANNELS 里找不到 minimaxcode）

- [ ] **Step 3: 注册渠道与最小适配器**

`store.cjs` 的 `CHANNELS` 追加（国内站单区，不标 costTier）：

```js
// MiniMax Code（agent.minimax.cn）：官方 CLI / 客户端同一套 OAuth（client_id=mcode-public），
// 对话上游是 Anthropic Messages（/mavis/api/v1/llm/v1/messages），只需 Bearer；
// 余额与签到另需 yy + x-signature 双签名（常量取自客户端 bundle）。只做国内站。
{ id: "minimaxcode", display: "MiniMax Code", domain: "agent.minimax.cn" },
```

`rules.cjs` 的 `"headers.json"` 末尾追加（键名与取值均照 spec 6.3）：

```js
minimaxcode: {
  accountBase: "https://account.minimax.cn",
  agentBase: "https://agent.minimax.cn",
  platformBase: "https://www.minimaxi.com",
  messagesPath: "/mavis/api/v1/llm/v1/messages",
  modelsPath: "/mavis/api/v1/models?region=cn&buildEnv=prod",
  userInfoPath: "/v1/api/user/info",
  membershipPath: "/matrix/api/v1/commerce/get_membership_info",
  signinStatusPath: "/minimax-cloud/api/v1/signin/status",
  signinClaimPath: "/minimax-cloud/api/v1/signin/claim",
  clientId: "mcode-public",
  scope: "agent.default",
  audience: "agent-backend",
  desktopVersion: "3.1.14",
  userAgent: "MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMax/3.1.14 Chrome/148.0.7778.280 Safari/537.36",
  signSalt: "I*7Cf%WZ#S&%1RlZJ&C2",
  signSuffix: "ooui",
  screenWidth: 2048,
  screenHeight: 1152,
  deviceMemory: 32,
  cpuCoreNum: 12,
},
```

`minimaxcode/adapter.cjs` 照 `loomy/adapter.cjs` 的结构（文件头 + `makeMinimaxCode(deps)` + `module.exports = makeMinimaxCode;`），本任务只给：`id: "minimaxcode"`、`cfg()`、`models() { return []; }`、`chat`/`queryCredits` 抛未实现错误。

`adapters.cjs` 尾部渠道 `require` 区加一行 `const minimaxcode = require("./minimaxcode/adapter.cjs");`，并在 `ADAPTERS` 对象里挂 `minimaxcode: minimaxcode({ fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs })`（位置与 loomy 一致）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 渠道注册`

- [ ] **Step 5: 跑一致性回归**

Run: `node tools/gateway-closure-check.cjs`
Expected: 通过（下限 109），无「引用指向已删文件」报错

同时 `grep -n "loomy" tools/proxy-channels-selftest.cjs scripts/fixtures/test-catalog.json` 看既有渠道的自测注册断言形态：
若那里是「逐渠道列举」而非「遍历 `store.CHANNELS`」，把 `minimaxcode` 按同样形态补进去（AGENTS 约定：tools 自测要补注册断言）。
若该渠道在该文件里需要模型条目，按 `minimaxcode/models.cjs` 的归一形状补 `MiniMax-M3.1-Flash` / `MiniMax-M3` 两条。

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/store.cjs electron/backend/proxy/rules.cjs electron/backend/proxy/adapters.cjs electron/backend/proxy/minimaxcode/adapter.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): 注册 MiniMax Code 渠道骨架"
```

---

### Task 2: 签名模块（`sign.cjs`）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/sign.cjs`
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testSign()` 一节）

**Interfaces:**
- Produces:
  - `md5(value: string): string`
  - `encodeUriComponent(value: string): string`（JS 口径：保留 `A-Za-z0-9-_.!~*'()`，其余按 UTF-8 逐字节 `%XX`）
  - `formEncode(value: string): string`（同上，空格变 `+`）
  - `xSignature(unixSec: number, body: string): string`
  - `yy(signPathQuery: string, body: string, unixMs: number): string`
  - `desktopQuery({ unixMs, userId, deviceId, uuid, cfg }): string`（22 个字段，顺序固定，空值跳过）
  - `accountHeaders({ cfg, token, body, unixMs, pathQuery }): Record<string, string>`

- [ ] **Step 1: 写失败测试（固定向量）**

```js
function testSign() {
  const sign = require("../electron/backend/proxy/minimaxcode/sign.cjs");
  // encodeURIComponent 口径：空格、!*'() 与中文
  assert.equal(sign.encodeUriComponent("a b!~*'()中"), "a%20b!~*'()%E4%B8%AD");
  assert.equal(sign.formEncode("a b"), "a+b");
  // 固定向量：同一组输入必须逐字复现（算法来自客户端 bundle，改动即失配）
  assert.equal(sign.xSignature(1700000000, "{}"), require("node:crypto").createHash("md5").update("1700000000I*7Cf%WZ#S&%1RlZJ&C2{}").digest("hex"));
  const q = sign.desktopQuery({ unixMs: 1700000000000, userId: "123", deviceId: "d1", uuid: "u1", cfg: { desktopVersion: "3.1.14", screenWidth: 2048, screenHeight: 1152, deviceMemory: 32, cpuCoreNum: 12 } });
  assert.equal(q.split("&").map((p) => p.split("=")[0]).join(","), "device_platform,biz_id,app_id,version_code,unix,timezone_offset,is_desktop,desktop_version,sys_language,lang,uuid,device_id,os_name,browser_name,device_memory,cpu_core_num,browser_language,browser_platform,user_id,screen_width,screen_height,client,region");
  assert.ok(q.includes("user_id=123"));
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../sign.cjs`

- [ ] **Step 3: 实现 `sign.cjs`**

按 spec 6.3 的公式与字段顺序实现，全部纯函数、无 IO；`desktopQuery` 的字段与取值见 spec。`accountHeaders` 返回 `accept / content-type / origin / referer / user-agent / authorization / x-timestamp / x-signature / yy`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 渠道注册` 与 `ok - 签名`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/sign.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): 补 MiniMax Code 签名与指纹查询串"
```

---

### Task 3: OAuth 模块（`oauth.cjs`）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/oauth.cjs`
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testOAuth()`，用假上游）

**Interfaces:**
- Produces:
  - `pkce(): { verifier: string, challenge: string }`
  - `requestDeviceCode(challenge: string, cfg: object): Promise<{ ok: true, deviceCode, userCode, verificationUri, expiresIn, interval, pollByUser } | { ok: false, message }>`
  - `pollToken({ deviceCode, pollByUser, verifier }, cfg): Promise<{ kind: "pending"|"slowDown"|"confirmed"|"failed", tokens?: { accessToken, refreshToken, expiresAt }, message?: string }>`
  - `refresh({ refreshToken, cfg }): Promise<{ ok: true, accessToken, refreshToken, expiresAt } | { ok: false, authError: boolean, message: string }>`

- [ ] **Step 1: 写失败测试（含只有 user_code 的变体）**

假上游用 `node:http` 起在回环随机端口，`cfg.accountBase` 指向它。断言：

```js
// ① 设备码：请求体含 client_id/scope/audience/code_challenge/code_challenge_method=S256
// ② 只回 user_code（无 device_code）时，pollByUser === true，轮询体里是 user_code 而不是 device_code
// ③ pending → slowDown → confirmed 三态
// ④ refresh 成功后返回新的 access/refresh；invalid_grant 时 { ok:false, authError:true }
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../oauth.cjs`

- [ ] **Step 3: 实现 `oauth.cjs`**

四个函数都走 `application/x-www-form-urlencoded`；端点取 `cfg.accountBase + "/oauth2/device/code" | "/oauth2/token"`。`pollToken` 按 spec 6.1 解析 `status: pending|slow_down|denied|expired` 与令牌字段；`refresh` 解析 `access_token / refresh_token / expires_in`（缺 `expires_in` 按 12 小时）。失败区分 `invalid_grant`（`authError: true`）与网络错误（`authError: false`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - OAuth`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/oauth.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): 加 MiniMax Code 设备码登录与刷新"
```

---

### Task 4: 身份与指纹（`identity.cjs`）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/identity.cjs`
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testIdentity()`）

**Interfaces:**
- Produces:
  - `deviceIdentity(account): { deviceId: string, uuid: string }`（`meta.deviceId/uuid` 优先；缺失时由 `sha256(uid || id)` 派生稳定值，不写库）
  - `fetchUserInfo({ token, cfg, deviceId, uuid, httpJson }): Promise<{ ok: true, realUserID: string, name: string } | { ok: false, authError?: boolean, message: string }>`（签名 `user_id=0`）
  - `ensureRealUserID({ account, secrets, cfg, httpJson, save }): Promise<string>`（`meta.realUserID` 命中直接返回；否则调用 `fetchUserInfo` 并 `save({ realUserID })`）

- [ ] **Step 1: 写失败测试**

```js
// ① 同一 uid 两次调用 deviceIdentity 得到完全相同的 deviceId/uuid（稳定）
// ② 两个不同 uid 得到不同 deviceId（不共享指纹）
// ③ fetchUserInfo 解析 data.userInfo.realUserID / name
// ④ 401 时返回 { ok:false, authError:true }
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../identity.cjs`

- [ ] **Step 3: 实现 `identity.cjs`**

`deviceIdentity` 用 `crypto.createHash("sha256").update(seed)` 派生成 32 位十六进制 `deviceId` 与 UUID 形态 `uuid`（把摘要按 8-4-4-4-12 切段）。`fetchUserInfo` 用 `sign.accountHeaders` + `sign.desktopQuery({ userId: "0" })`，`httpJson` GET，解析 `data.userInfo`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 身份`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/identity.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): 加 MiniMax Code 账号身份与设备指纹"
```

---

### Task 5: 登录接入（`discovery.cjs`）

**Files:**
- Modify: `electron/backend/proxy/discovery.cjs`（`beginOAuth` 分发处约 3287-3317 行；新增 `beginMinimaxCodeOAuth` 与 `saveMinimaxCodeAccount`，放在 `beginClineOAuth` 之后约 1673 行处；`isScanImportAllowed` 约 606 行）
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testLogin()`）

**Interfaces:**
- Consumes: Task 3 的 `requestDeviceCode` / `pollToken`；Task 4 的 `fetchUserInfo`。
- Produces:
  - `beginMinimaxCodeOAuth(channel, onDone): Promise<{ ok: boolean, url?: string, mode?: "device", userCode?: string, message?: string }>`
  - `saveMinimaxCodeAccount(channel, grant): { id: string, uid: string }`（`uid = realUserID`，拿不到时回落 `sha256(accessToken)` 前 16 位并写 `meta.uidFallback = true`）
  - `isScanImportAllowed("minimaxcode") === false`

- [ ] **Step 1: 写失败测试**

```js
// ① beginOAuth("minimaxcode", ...) 返回 { ok:true, mode:"device", url, userCode }
// ② 轮询全部 pending 后（假上游第 2 次回 confirmed）onDone 收到 ok:true
// ③ 落库账号 token 为 accessToken、refreshToken 非空、expiresAt > now
// ④ meta 里 realUserID / deviceId / uuid / tokenExpiresAt 都存在
// ⑤ 同 uid 二次登录不新增账号（listAccounts("minimaxcode").length 不变）
// ⑥ isScanImportAllowed("minimaxcode") === false
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `TypeError: discovery.beginOAuth is not a function` 或返回 `ok:false` 且 message 提到未知渠道

- [ ] **Step 3: 实现登录流程**

照 `beginClineOAuth` 的会话结构（`mode: "device"`、`state: deviceCode`、timer 轮询、`finishOAuth`、会话一致性守卫）。落库前调一次 `fetchUserInfo` 拿 `realUserID`/`name`；同 uid 已存在时 `store.updateAccount`（保留原 `meta.deviceId/uuid`）。`beginOAuth` 分发加 `if (ch === "minimaxcode") return beginMinimaxCodeOAuth(ch, onDone);`；`isScanImportAllowed` 改为渠道黑名单集合，含 `"zcode"` 与 `"minimaxcode"`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 登录`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/discovery.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): MiniMax Code 设备码登录入池"
```

---

### Task 6: 模型目录（`models.cjs` + 适配器两个方法）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/models.cjs`
- Modify: `electron/backend/proxy/minimaxcode/adapter.cjs`（`models()` / `modelEntries()` / `fetchModels()` / `mapModel()`）
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testModels()`）

**Interfaces:**
- Produces:
  - `parseModels(payload): Array<{ id, name, rate: null, capabilities: { images, reasoning, tools }, contextLength, maxOutputTokens }>`
  - `list(rulesDir, channel = "minimaxcode"): string[]`
  - `entries(rulesDir, channel = "minimaxcode"): object[]`
  - `refresh({ token, cfg }, rulesDir, channel, force): Promise<{ ok: true, count, unchanged? } | { ok: false, message }>`
  - `resolveId(rulesDir, channel, requested): string | null`
- `adapter.fetchModels(account, secrets, opts)` → `{ ok: true, models } | { ok: false, message }`（形状与 `loomy` 一致，供 `proxy_models_sync` 使用）

- [ ] **Step 1: 写失败测试**

```js
// ① parseModels 从 providers[].config.models{} 归一：MiniMax-M3.1-Flash → contextLength 512000 / maxOutputTokens 128000 / images=true / reasoning=true
// ② refresh 成功写入 catalog.json 的 minimaxcode 段（{ syncedAt, models }），list() 读到两个模型
// ③ refresh 返回空 models 时 { ok:false }，且 catalog.json 原有内容不变（Review Focus 4）
// ④ resolveId 大小写敏感：MiniMax-M3 命中，minimax-m3 返回 null
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../models.cjs`

- [ ] **Step 3: 实现目录模块并接进适配器**

`refresh` 走 `httpJson` GET `cfg.agentBase + cfg.modelsPath`（带 `authorization: Bearer`）；解析失败或空清单**直接返回失败且不写文件**；成功时整段覆盖 `catalog.json` 的 `minimaxcode`（读-改-写，与 `loomy/models.cjs` 同口径）。`adapter.models()` 读 `list(rules.rulesDir(), "minimaxcode")`；`mapModel` 原样返回。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 模型目录`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/models.cjs electron/backend/proxy/minimaxcode/adapter.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): MiniMax Code 模型目录拉取与落盘"
```

---

### Task 7: 对话转发（`chat` + 续期）

**Files:**
- Modify: `electron/backend/proxy/minimaxcode/adapter.cjs`（`chat`、`refreshToken`、`tokenExpiryMs`、`refreshWindowSec`、`classifyError`）
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testChat()`、`testRefresh()`）

**Interfaces:**
- Consumes: `zcodeAnthropic.toAnthropic(model, body, { defaultMaxTokens })` 与 `zcodeAnthropic.createSseBridge(emit)`（`electron/backend/proxy/zcodeAnthropic.cjs`）；`deps.fetchStream` / `deps.firstByteBudgetMs`。
- Produces:
  - `chat({ account, secrets, model, body, emit, meta }): Promise<{ status: 200, planLimit: false }>`
  - `refreshToken(account, secrets): Promise<{ ok: true, token, refreshToken } | { ok: false, authError: boolean, message: string }>`
  - `tokenExpiryMs(account, secrets): number`（`meta.tokenExpiresAt`）
  - `refreshWindowSec = 600`
  - `classifyError(e): { kind: "auth", switchable: false } | { kind: "badRequest", switchable: false } | null`

- [ ] **Step 1: 写失败测试（含两种 401 错误体）**

```js
// ① chat：OpenAI body（含 system + tool 消息）→ 上游收到的 Anthropic body 有顶层 system、tool_result 合并、max_tokens=128000
// ② 模型不在目录内 → 抛出 status 400 且 message 含可用清单
// ③ 上游 401 {"code":401,"message":"auth failed"} → 适配器抛出 e.status === 401（交由通用层刷新）
// ④ classifyError 对账号接口 401 形态 {"error":"invalid access token"} 也返回 { kind:"auth" }
// ⑤ tokenExpiryMs 读 meta.tokenExpiresAt；refreshWindowSec === 600
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `chat 尚未实现` 或断言失败

- [ ] **Step 3: 实现对话与续期**

`chat`：逐字校验模型 → `toAnthropic` → `fetchStream` POST `cfg.agentBase + cfg.messagesPath`（头见 spec 6.2）→ `createSseBridge(emit)` 逐事件 `emit`；非 2xx 抛出 `Object.assign(new Error(msg), { status })`（**不在适配器内刷新**）。`refreshToken`：用 Task 3 的 `refresh`，成功 `{ ok:true, token, refreshToken }`，失败按 `authError` 区分；维护进程内「已花 refreshToken 摘要」`Set`（上限 50），命中直接 `{ ok:false, authError:true }`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 对话` 与 `ok - 续期`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/adapter.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): MiniMax Code 对话转发与续期"
```

---

### Task 8: 余额（`credits.cjs` + `queryCredits`）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/credits.cjs`
- Modify: `electron/backend/proxy/minimaxcode/adapter.cjs`（`queryCredits`）
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testCredits()`）

**Interfaces:**
- Produces: `query({ token, userId, deviceId, uuid, cfg, httpJson }): Promise<{ ok: true, credits: number, hasTokenPlan: boolean, planName: string } | { ok: false, authError?: true, error?: string, message: string }>`
- `adapter.queryCredits(account, secrets)` → `{ credits, expiresAt: 0 } | { authError: true, message } | { error: string }`（**不在适配器内刷新**）

- [ ] **Step 1: 写失败测试**

```js
// ① total_remaining_amount "400" → credits 400（数字），expiresAt 0
// ② 小数 "1492.125" 原样保留
// ③ 401 {"error":"invalid access token"} → { authError: true }
// ④ 200 但 base_resp.status_code=401 → 也判 authError
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../credits.cjs`

- [ ] **Step 3: 实现余额查询**

`query` 先 `identity.ensureRealUserID` 取 `user_id`，再 POST `membershipPath`（`sign.accountHeaders` + `desktopQuery`），解析 `op_credit_summary`；`base_resp.status_code` 非 0 时按 401 语义映射。`adapter.queryCredits` 只做「取 secrets → 调 query → 翻译返回形状」。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 余额`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/credits.cjs electron/backend/proxy/minimaxcode/adapter.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): MiniMax Code 积分余额查询"
```

---

### Task 9: 签到（`checkin.cjs` + 适配器两个方法）

**Files:**
- Create: `electron/backend/proxy/minimaxcode/checkin.cjs`
- Modify: `electron/backend/proxy/minimaxcode/adapter.cjs`（`checkinStatus` / `checkin`）
- Test: `tools/proxy-minimaxcode-selftest.cjs`（追加 `testCheckin()`）

**Interfaces:**
- Produces:
  - `status({ token, userId, deviceId, uuid, cfg, httpJson }): Promise<{ ok: true, checkedIn, credits, consecutiveDays, creditsEarnedToday, message } | { ok: false, authError?: true, message }>`
  - `claim({ ... }): Promise<{ ok: true, already: boolean, reward: number, status?: object, message: string } | { ok: false, authError?: true, message }>`
- `adapter.checkinStatus` / `adapter.checkin` 直接转发上述结果（字段与 `adapters.cjs` 顶部契约一致）。

- [ ] **Step 1: 写失败测试**

```js
// ① status: today.status===3 → checkedIn true、consecutiveDays=1、creditsEarnedToday=400
// ② claim_result:2 → { ok:true, already:true }（Review Focus 6）
// ③ claim_result:0 且 points:400 → { ok:true, already:false, reward:400 }，并回查一次面板
// ④ 401 → authError
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `Cannot find module .../checkin.cjs`

- [ ] **Step 3: 实现签到**

`status` GET `signinStatusPath`（签名），解析 `data.days` 里 `is_today` 的那天；`claim` POST `signinClaimPath`（body `{}`），按 `claim_result` 判 already/成功，成功后回查一次 `status` 并随结果返回。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-minimaxcode-selftest.cjs`
Expected: `ok - 签到`

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/minimaxcode/checkin.cjs electron/backend/proxy/minimaxcode/adapter.cjs tools/proxy-minimaxcode-selftest.cjs
git commit -m "feat(gateway): MiniMax Code 每日签到"
```

---

### Task 10: 前端接入

**Files:**
- Modify: `src/types/index.ts`（`ProxyChannelId`，约 120 行）
- Modify: `src/views/proxy/format.ts`（`CHANNEL_NAMES`，约 193 行）
- Modify: `src/views/proxy/ProxyAgentsView.vue`（`addTabAllowed`，约 234 行）

**Interfaces:**
- Produces: 前端类型 `ProxyChannelId` 含 `"minimaxcode"`；`channelName("minimaxcode") === "MiniMax Code"`；新增账号弹窗对该渠道不出现 `local` 页签。

- [ ] **Step 1: 改类型与显示名**

`src/types/index.ts` 的联合类型追加 `| "minimaxcode"`；`format.ts` 的 `CHANNEL_NAMES` 追加 `minimaxcode: "MiniMax Code",`。

- [ ] **Step 2: 屏蔽「从本机软件导入」页签**

`ProxyAgentsView.vue` 的 `addTabAllowed()` 增加：

```ts
if (channel === "minimaxcode" && key === "local") return false;
```

（与既有 `zcode` 那一行同位置、同写法，保留其下方通用分支。）

- [ ] **Step 3: 类型门禁**

Run: `npm run build`
Expected: `vue-tsc --noEmit` 与 `vite build` 均成功（无类型错误）

- [ ] **Step 4: 提交**

```bash
git add src/types/index.ts src/views/proxy/format.ts src/views/proxy/ProxyAgentsView.vue
git commit -m "feat(ui): 前端接入 MiniMax Code 渠道"
```

---

### Task 11: 收尾回归与文档

**Files:**
- Test: `tools/proxy-minimaxcode-selftest.cjs`（补 `main()` 汇总与退出码）
- Modify: `docs/superpowers/specs/2026-11-12-minimaxcode-channel-design.md`（若实现中与设计有偏差，补一节「实现注记」）

- [ ] **Step 1: 自测脚本收口**

`main()` 顺序执行全部小节，任一失败 `process.exitCode = 1`，全部通过打印 `全部通过`。

- [ ] **Step 2: 跑全量回归**

Run:
```bash
node tools/proxy-minimaxcode-selftest.cjs
node tools/gateway-closure-check.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-channels-selftest.cjs
node scripts/dev-sink-golden.cjs
npm run build
```
Expected: 全部通过；`dev-sink-golden` 无字节/顺序差异（本方案未改调度）

若 `tools/proxy-channels-selftest.cjs` 因新增渠道而失败（常见形态：断言渠道数、逐渠道列举、双表一致性），
按既有写法把 `minimaxcode` 补进断言（Task 1 Step 5 已先做过一次定位与补齐）；不要靠删断言让它变绿。

- [ ] **Step 3: 补分支说明（如需）**

若实现与设计有偏差（例如签名字段、指纹取值），在设计文档末尾追加「实现注记」，写清偏差与原因。仓库 `docs/` 被 `.gitignore` 忽略，需要入库时用 `git add -f`。

- [ ] **Step 4: 提交**

```bash
git add tools/proxy-minimaxcode-selftest.cjs
git commit -m "test(gateway): MiniMax Code 渠道自测收口"
```

---

## 实施顺序与依赖

```
Task 1（骨架）
  └─ Task 2（签名） ──┬─ Task 4（身份）─ Task 5（登录）
                      │                      │
  Task 3（OAuth）─────┘                      │
  Task 6（目录） 独立（依赖 1）               │
  Task 7（对话） 依赖 2、6 ───────────────────┤
  Task 8（余额） 依赖 2、4 ───────────────────┤
  Task 9（签到） 依赖 2、4 ───────────────────┤
  Task 10（前端） 独立                       │
  Task 11（回归） 最后 ──────────────────────┘
```

## 风险提示（执行时注意）

- 每次改 `electron/backend/proxy/` 下的文件后跑一次 `node tools/gateway-closure-check.cjs`（防止新增 `require` 指向不存在的文件）。
- Task 7 的 `fetchStream` 头里**不要**加 `accept-encoding: identity`（既有 `fetchStream` 已处理），否则流式解析可能出错。
- 所有上游调用都要带超时；余额/签到的 `httpJson` 沿用既有默认超时即可。
- 真实联调（需要用户配合扫码）放在 Task 11 之后再单独做，不在本计划的自动化范围内。
