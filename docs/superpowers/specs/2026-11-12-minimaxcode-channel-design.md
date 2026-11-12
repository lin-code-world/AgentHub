# MiniMax Code 渠道接入方案（国内站）

- 日期：2026-11-12
- 分支：`api-gateway`
- 状态：待评审（第二版，已补齐评审提出的 5 个问题）
- 参考实现：`F0Rextasy/minimaxcode2api`、`Zhengyuuuui/minimax2api`、`yetone/magpie`
- 官方开源：`MiniMax-AI/minimax-code`（`packages/oauth-core` 为官方 OAuth 实现）

## 一、为什么做

网关已经接了十余家「账号制」渠道（Trae / Cline / Qoder / AutoClaw …），共同点是：登录一次拿凭据、
按号池调度、对外提供 OpenAI 与 Anthropic 两种接口。MiniMax Code（`agent.minimax.cn`）目前没有接入，
但它的形态与既有渠道完全一致，且入口已经可用：

- 官方 CLI / 桌面客户端的登录是 **OAuth 设备码 + PKCE**（`client_id=mcode-public`）；
- 对话上游是 **Anthropic Messages 协议**（`/mavis/api/v1/llm/v1/messages`），只要 `Authorization: Bearer`；
- 账号类接口（余额、签到）有独立实现，返回积分与 7 天签到面板；
- 模型目录可实时拉取（含上下文长度、最大输出、模态、思考开关）。

因此本次是「新增一个渠道」，不改调度主干、不改协议翻译主链路。

## 二、目标

1. 在没有安装 MiniMax Code 客户端的机器上（部署目标 `192.168.2.129`），可以：
   - 用网页设备码登录添加账号并自动入池；
   - 拉取该账号实际可用的模型目录（能力与上限以上游为准，不写死），并进入全站模型目录体系；
   - 查询积分余额并纳入既有定时刷新；
   - 查询 / 领取每日签到积分，纳入既有自动签到框架；
   - 参与号池调度：到期优先 / 余额优先 / 轮询、冷却、失败转移、并发限制全部复用现有逻辑。
2. 对话同时支持外部两种入口：`/v1/chat/completions`（OpenAI）与 `/v1/messages`（Anthropic）。
3. 凭据过期时自动续期并重试一次；续期不可恢复时如实标记「需重登」，不影响其它账号。

## 三、非目标

- **不做国际站（`agent.minimax.io` / `account.minimax.io`）**：用户明确只要国内站。代码按单区写，
  将来要加国际站按仓库既有双区惯例另开一个渠道 id。
- 不做自动注册、批量养号、代理池（参考仓库里有，与网关定位无关）。
- 不做图片 / 视频生成、Agent 会话（`/minimax-cloud/api/v1/session/*`）——只做直连模型 API。
- 不做「从本机客户端导入」：目标机器没装客户端；本机导入还会与客户端共用同一份 refresh token，互相踢。
- 不改造 mcode 客户端配置（即 magpie 的「接管 agent」方向），那是另一个产品形态。

## 四、反目标（这样算失败）

- 为拿模型数据而要求先装官方客户端。
- 余额 / 签到失败时把整条渠道判死（只影响该账号该项数据）。
- 续期逻辑并发执行，把一次性 refresh token 花两次，导致账号和客户端同时掉登录。
- 模型名被静默改写（上游大小写敏感，写错应 400 而不是猜一个）。
- 拉不到模型目录时编造模型名。

## 五、约束

- 网关核心 `electron/backend/proxy/`，全部 `.cjs`；渠道适配器按「一渠道一目录」存放并在
  `adapters.cjs` 尾部注册；必需方法 `cfg / models / chat / queryCredits`（启动期契约断言）。
- 渲染层 Vue 3 `<script setup lang="ts">`；渠道 id 类型、显示名要同步。
- 新增渠道要过：`tools/gateway-closure-check.cjs`、双表一致性（`consistencyReport`）、`npm run build`。
- 自测一律 `AGENTHUB_DATA_DIR` 指向临时目录，不读写真实用户数据。
- 新文件沿用仓库版权头注释块（与 `loomy/` 等较新渠道一致）。

## 六、已核实的事实（2026-11-12 实测，本机客户端 3.1.14 + 官方仓库 main）

### 6.1 登录（官方 `packages/oauth-core` 源码 + 实测）

| 项 | 值 |
| --- | --- |
| 设备码端点 | `POST https://account.minimax.cn/oauth2/device/code` |
| 换令牌端点 | `POST https://account.minimax.cn/oauth2/token` |
| 撤销端点 | `POST https://account.minimax.cn/oauth2/revoke` |
| 表单参数 | `client_id=mcode-public`、`scope=agent.default`、`audience=agent-backend`、`code_challenge` + `code_challenge_method=S256` |
| 轮询参数 | `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code`（**部分账号只回 `user_code`，此时用 `user_code` 轮询**）+ `code_verifier` |
| 刷新参数 | `grant_type=refresh_token` + `refresh_token` + `client_id` + `scope` + `audience` |
| 有效期 | 实测 `expires_in` ≈ 12 小时；access token **不是 JWT**（`mmoat_` 前缀的 opaque 串），refresh 前缀 `mmort_` |
| refresh 语义 | **一次性**：重复使用返回 `invalid_grant`（官方客户端用文件锁 + 单飞行保护） |

官方凭据落盘位置（仅作参考，本方案不读）：`~/.minimax/auth/prod/cn/mcode-public/auth.json`。

### 6.2 对话上游（实测 200）

```
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
authorization: Bearer <accessToken>
x-api-key: sk-xxx            ← 官方客户端塞的占位，非必需但一并带上
anthropic-version: 2023-06-01
content-type: application/json
```

- 标准 Anthropic Messages 请求体；`stream: true` 返回 Anthropic SSE。
- **不需要签名**（签名只用于账号类接口）。`x-mavis-*` 头可选。
- 未知模型上游自己会 400：`{"type":"error","error":{"type":"invalid_request_error","message":"invalid params, unknown model 'X' (2013)"}}`。

### 6.3 账号类接口（实测 200，需 Bearer + 双签名）

**基域分工**（必须分清，打错域名直接 404 / 401）：

| 基域 | 用途 |
| --- | --- |
| `https://agent.minimax.cn` | `user/info`、`get_membership_info`、`signin/*`、`models`、`messages` |
| `https://www.minimaxi.com` | `token_plan_credit`、`coding_plan/remains`（套餐类，本渠道不展示） |
| `https://account.minimax.cn` | 仅 OAuth |

**签名**（常量取自客户端 bundle，公开、非机密；`sign.cjs` 实现为纯函数）：

- `x-signature = md5(unix秒 + "I*7Cf%WZ#S&%1RlZJ&C2" + body)`
- `yy = md5(encodeURIComponent(签名路径与查询) + "_" + (body || "{}") + md5(毫秒时间戳) + "ooui")`
- 查询串顺序是契约（`yy` 对编码后的整串取摘要），固定为：
  `device_platform, biz_id, app_id, version_code, unix, timezone_offset, is_desktop, desktop_version,
  sys_language, lang, uuid, device_id, os_name, browser_name, device_memory, cpu_core_num,
  browser_language, browser_platform, user_id, screen_width, screen_height, client, region`
- 固定取值（实测可用）：`device_platform=web`、`biz_id=3`、`app_id=3001`、`version_code=22201`、
  `timezone_offset=28800`、`is_desktop=1`、`desktop_version=3.1.14`、`sys_language/lang=zh`、
  `os_name=Windows`、`browser_name=Chrome`、`device_memory=32`、`cpu_core_num=12`、
  `browser_language=zh-CN`、`browser_platform=Win32`、`screen_width=2048`、`screen_height=1152`、
  `client=desktop`、`region=en`。
- `uuid` / `device_id` 由网关按账号派生并持久化（同机多号不共享）；`user_id` 填 `realUserID`，
  **首次引导时为 `0`**（实测通过）。
- 账号类接口的 `body` 为空串时，`x-signature` 用空串、`yy` 用 `"{}"`（客户端 axios 口径）。

**接口清单**：

| 用途 | 请求 | 关键返回 |
| --- | --- | --- |
| 账号身份 | `GET agent.minimax.cn/v1/api/user/info`（`user_id=0` 可用） | `data.userInfo.realUserID`（余额接口必填，**不在任何令牌里**）、`name`、`phone` |
| 余额（积分） | `POST agent.minimax.cn/matrix/api/v1/commerce/get_membership_info`（body `{}`） | `op_credit_summary.total_remaining_amount = "400"`（**字符串**）、`free_remaining_amount`、`has_token_plan`、`plan_name` |
| 签到面板 | `GET agent.minimax.cn/minimax-cloud/api/v1/signin/status` | `data.days[]`（7 天；`status:3` = 已签，`is_today`） |
| 签到领取 | `POST agent.minimax.cn/minimax-cloud/api/v1/signin/claim`（body `{}`） | `claim_result=2` 表示今天已领（幂等），否则 `points` |
| 套餐积分 | `GET www.minimaxi.com/backend/account/token_plan_credit?business=Agent&device_platform=desktop` | `total_credits / used_credits / remaining_credits`（无套餐全 0） |
| 套餐配额 | `GET www.minimaxi.com/v1/api/openplatform/coding_plan/remains`（头 `X-Group-Id`） | 无套餐返回 `2062 no active token plan subscription` |

**错误体形状**（实测，决定分类器怎么写）：

- 账号接口 401：`{"error":"invalid access token"}`（**没有** `base_resp`）。
- 对话接口 401：`{"code":401,"message":"auth failed"}`。
- 业务包体（HTTP 200 但业务失败）：`{"base_resp":{"status_code":<非0>,"status_msg":"..."}}`。

实测结论（本机账号）：积分余额 **400**（免费赠送）；今日已签到（`status:3`），第 4/7 天各 1000 积分。

### 6.4 模型目录（实测 200）

```
GET https://agent.minimax.cn/mavis/api/v1/models?region=cn&buildEnv=prod
authorization: Bearer <accessToken>
```

返回 `providers[].config.models{}`，每个模型带：

- `limit.context`（实测 M3 / M3.1-Flash = 512000，另有可选 1000000）、`limit.output` = 128000；
- `modalities.input` = `["text","image","video"]`；
- `variants`（`thinking` / `none-thinking`）、`thinking_config`；
- `attachment`、`tool_call`、`reasoning`。

当前清单：`MiniMax-M3.1-Flash`、`MiniMax-M3`（旧名 `-Preview` 与 M2.7 系列已下线）。

## 七、方案选型

用户已选「A. 完整渠道」。三个候选与取舍：

- **A｜完整渠道（选定）**：OAuth 设备码登录 + 号池 + 实时目录 + 余额积分 + 每日签到。与既有渠道体验一致。
- B｜轻量渠道：只做登录 + 转发 + 目录，余额显示未知、不做签到。省掉签名模块（约三分之一改动），
  但号池排序拿不到余额、用户也少一项每日收益。→ 否决（余额与签到均实测可用）。
- C｜只做本机客户端导入：读 `~/.minimax/auth/...` 入池。最快，但目标机器没客户端，加号要手工拷贝，
  且与客户端共用 refresh token。→ 否决（不可用于部署目标）。

其余决策：

- **单区**：只做 `minimaxcode`（CN）。国际站不做。
- **协议翻译复用**：`zcodeAnthropic.toAnthropic()` + `createSseBridge()` 直接用（同为 Anthropic 上游、
  同为大写敏感模型名、同样需要 `max_tokens` 兜底）。
- **不做本机导入**：界面对 `local` 页签屏蔽 + 后端 `proxy_scan_import` 拒绝（两道门，与 ZCode 同口径）。
- **不展示套餐配额**：默认账号没有 Token Plan，`coding_plan/remains` 返回 2062 属正常态；余额一律以「积分」展示。
- **刷新与重试只在通用层做**：`server.cjs` 的 `attemptChat` 与 `credits.refreshAccount` 都是「401 → 刷新一次 →
  重试一次」，适配器内部**不再自己刷新**，避免双重刷新把一次性 refresh token 花两次。

## 八、分项设计

### 8.1 渠道注册

- `store.cjs` 的 `CHANNELS` 增加一行：`{ id: "minimaxcode", display: "MiniMax Code", domain: "agent.minimax.cn" }`。
  **不标 `costTier`**：套餐口径未实测，错标 free/low 会把付费渠道排前面。
- `rules.cjs` 的 `headers.json` 增加 `minimaxcode` 块：两个基域、各路径、默认 UA、`desktopVersion`、
  签名盐与后缀、固定指纹字段值（见 6.3）。
- `adapters.cjs` 尾部 `require("./minimaxcode/adapter.cjs")` 并挂进 `ADAPTERS`。

### 8.2 新目录 `electron/backend/proxy/minimaxcode/`

| 文件 | 职责 |
| --- | --- |
| `endpoints.cjs` | 基域与路径常量、默认 UA、desktop 指纹常量 |
| `sign.cjs` | `md5` / `encodeUriComponent` / `yy` / `xSignature` / `desktopQuery()`（顺序固定，纯函数） |
| `oauth.cjs` | 设备码申请、轮询、刷新（纯 HTTP，不碰账号库） |
| `identity.cjs` | `realUserID` 获取与缓存（缺则调 `/v1/api/user/info`）、账号指纹派生 |
| `models.cjs` | 目录拉取 + 归一 + 写 `catalog.json` 的 `minimaxcode` 段（与 `loomy/models.cjs` 同口径） |
| `credits.cjs` | `get_membership_info` → 积分 |
| `checkin.cjs` | 签到面板与领取 |
| `adapter.cjs` | 适配器契约实现（`cfg/models/fetchModels/chat/refreshToken/tokenExpiryMs/refreshWindowSec/queryCredits/checkin/checkinStatus/classifyError`） |

### 8.3 登录（`discovery.cjs`）

- 新增 `beginMinimaxCodeOAuth(channel, onDone)`，形态与 `beginClineOAuth` 一致：
  - 申请设备码 → 返回 `{ ok, url, mode: "device", userCode }`（前端已有「输码」形态）；
  - 轮询：`pending` 维持间隔、`slow_down` 每次 +2 秒（上限 30 秒）、`denied/expired` 结束；
  - 超时取上游 `expires_in`，不低于通用 3 分钟；
  - 会话一致性守卫（`oauthSession !== session` 即丢弃结果）照抄 Cline 的写法。
- **落库（`saveMinimaxCodeAccount`）**：
  1. 拿到令牌后**立即调一次 `/v1/api/user/info`**（签名 `user_id=0`，Bearer=新令牌），取 `realUserID` 与 `name`；
  2. `uid = realUserID`（拿不到时回落 `sha256(accessToken)` 前 16 位，并在 `meta` 标注 `uidFallback: true`）；
     `name = userInfo.name`（如 `MiniMax380993`）；
  3. 写入 `token=accessToken`、`refreshToken`、`expiresAt = now + expires_in*1000`、
     `meta: { realUserID, deviceId, uuid, loginEpoch, tokenExpiresAt }`；
  4. 同 `uid` 已存在则更新（保留其 `meta.deviceId/uuid`，不换指纹）。
- `beginOAuth()` 分发加一行；`isScanImportAllowed("minimaxcode")` 返回 false。

### 8.4 对话（`chat`）

```
OpenAI body ──zcodeAnthropic.toAnthropic(model, body, { defaultMaxTokens })──▶ Anthropic body
   │                                                                              │
   └ model 逐字（大小写敏感）；不在目录内 → 400 并给出可用清单                      ▼
                                                       POST {agentBase}/mavis/api/v1/llm/v1/messages
                                                          Authorization: Bearer <token>
   ◀── zcodeAnthropic.createSseBridge(emit) ◀── Anthropic SSE ──────────────────┘
```

- `defaultMaxTokens` 取该模型目录里的 `limit.output`（128000），取不到用 8192。
- `stream: true` 恒开，非流式由 `server.cjs` 聚合器兜。
- 上游非 2xx 时抛出带 `status` 的错误，**由 `attemptChat` 统一做「刷新一次 + 重试一次」**；适配器不自刷。
- 首字节预算用 `firstByteBudgetMs(payloadText)`。
- `classifyError`：401/403 → `auth`；HTTP 400 且 message 含 `unknown model` → `badRequest`（不罚号）；
  其余交给通用分类器（本家没有跨渠道共用的业务码，不要在通用层加）。

### 8.5 续期（本方案最需要小心的部分）

- `tokenExpiryMs(account, secrets)`：返回 `meta.tokenExpiresAt`（access token 是 opaque，`util.jwtDecode` 解不出来，
  **必须实现这个方法**；否则 `ensureFreshSecrets` 认为「无到期」永不预刷新）。
- `refreshWindowSec = 600`（10 分钟）。**不能用默认 86400**：token 只活 12 小时，24 小时窗口会让每一轮
  余额刷新（30 分钟一次）都触发一次预刷新，把一次性 refresh token 一轮轮花掉——这正是小浣熊渠道
  「与桌面端抢 refresh_token 互相作废」的踩坑形态。
- `refreshToken` 方法只做「用 refresh 换新令牌 → 成功即写回」（`store.updateAccount` 同时写
  `token / refreshToken / expiresAt` 与 `meta.tokenExpiresAt`）；失败返回 `{ ok:false, authError:true }`。
- 一次性 token 的额外保护（通用层已提供串行，这里只补防重复花费）：
  1. 适配器内维护「已花掉的 refreshToken 摘要」集合（进程内，上限 50 条），命中即直接返回
     `{ ok:false, authError:true, message: "凭据已轮换，请重新登录" }`，不再打上游；
  2. 刷新失败**不重试**（`invalid_grant` 说明这一枚已作废）；
  3. 成功写回后清掉该账号的「待刷新」标记。
- 界面如实提示：「同一账号若同时登录官方客户端，续期可能互相踢下线」。

### 8.6 余额（`queryCredits`）

1. 取 `realUserID`（账号 `meta.realUserID` 优先；缺失则调 `/v1/api/user/info`（`user_id=0`），成功即写回 `meta`）。
2. `POST /matrix/api/v1/commerce/get_membership_info`（desktop 查询串 + `yy` + `x-signature` + Bearer）。
3. 返回 `{ credits: Number(op_credit_summary.total_remaining_amount), expiresAt: 0 }`；`credits` 允许小数。
4. 失败语义：401 → `{ authError: true }`（通用层刷新重试与标 relogin 由 `credits.refreshAccount` 做）；
   其它 → `{ error: message }` 保留旧值。
5. `has_token_plan` / `plan_name` 只写日志与 `meta`，不上界面。

### 8.7 签到（`checkinStatus` / `checkin`）

- `checkinStatus`：`GET /minimax-cloud/api/v1/signin/status`（签名）→
  `{ ok, checkedIn: today.status === 3, credits, consecutiveDays: today.day_no, creditsEarnedToday: today.points, message }`。
- `checkin`：`POST /minimax-cloud/api/v1/signin/claim`（body `{}`，签名）→
  `claim_result === 2` 判 `already`（幂等，不算失败）；否则 `{ ok:true, already:false, reward: points }`；
  领取后回查一次面板并随结果返回（与 Trae 同口径）。
- 两种请求都走签到串编码（`URLSearchParams` 口径：空格变 `+`；签名时带 `op_ticket=undefined`，实际发送不带）。
- 失败语义：401 → `{ authError:true }`；其余 `{ ok:false, message }`。

### 8.8 模型目录

- `fetchModels(account, secrets, opts)`：`GET {agentBase}/mavis/api/v1/models?region=cn&buildEnv=prod`。
- 归一为仓库条目形状 `{ id, name, rate: null, capabilities, contextLength, maxOutputTokens }`：
  `limit.context` → `contextLength`、`limit.output` → `maxOutputTokens`、
  `modalities.input` 含 `image` → `capabilities.images`、`variants` 含 `thinking` 或 `reasoning` → `capabilities.reasoning`、
  `tool_call` → `capabilities.tools`。视频输入**先不声明**（网关入站不支持视频）。
- 落盘 `rules/catalog.json` 的 `minimaxcode` 段（`{ syncedAt, models }`），与 loomy / 其它渠道同口径——
  这样模型页、别名、智能路由、`mergedModels` 都能看到它们；**不另建独立文件**。
- `models()` 读 `catalog.json`；没拉过就是空数组，不编模型名。
- `mapModel` 原样透传（大小写敏感）；不在目录内则入口 400 并给出可用清单。

### 8.9 前端

| 位置 | 改动 |
| --- | --- |
| `src/types/index.ts` | `ProxyChannelId` 增加 `"minimaxcode"` |
| `src/views/proxy/format.ts` | `CHANNEL_NAMES` 增加 `minimaxcode: "MiniMax Code"`（余额单位默认「积分」、签到文案默认「签到」，无需另配） |
| `src/views/proxy/ProxyAgentsView.vue` | `addTabAllowed()`：`minimaxcode` 屏蔽 `local` 页签 |
| 登录面板 | 复用 `mode:"device"` 的「显示用户码 + 打开授权页」形态，文案说明「授权完成后无需跳回本机」 |

### 8.10 自测

新增 `tools/proxy-minimaxcode-selftest.cjs`（假上游，不出网）：

1. 设备码 → 轮询 `pending` → `slow_down` → 成功，断言表单参数与 PKCE；
2. 登录落库：`uid=realUserID`、`name`、`meta` 字段；
3. 对话：OpenAI body → Anthropic body（system 抽取、tool_result 合并、`max_tokens` 兜底），SSE 事件桥；
4. 续期：`tokenExpiryMs` + `refreshWindowSec=600` 的窗口判定；一次性 token 不重复花费；401 由通用层刷新一次；
5. 余额：`total_remaining_amount` 字符串 → 小数；
6. 签到：`status:3` 判已签；`claim_result:2` 判 already；
7. 模型目录：拉取 → 归一 → `catalog.json` 落盘 → `models()` 读到；
8. 签名：固定向量（给定 `unix`/`uuid`/`user_id` 与预期 md5）逐字比对。

回归：`node tools/gateway-closure-check.cjs`、`node tools/proxy-channels-selftest.cjs`、
`node scripts/dev-sink-golden.cjs`（不改调度，仍需确认无回归）、`npm run build`。

## 九、风险与未验证项

1. **一次性 refresh token**：与官方客户端共存时可能互相踢；网关侧已做串行 + 不重试 + 成功即写回 +
   已花集合，但同一账号两边同时刷新仍无解（如实提示，不静默）。
2. **账号类接口是私有口径**：签名常量与查询串顺序来自客户端 bundle，官方升级可能改；兜底是
   「余额/签到失败只影响该项，不影响对话」。
3. **`realUserID` 不在令牌里**：必须靠 `/v1/api/user/info` 补；该接口失败时余额不可查（对话不受影响），
   账号 uid 回落 token 摘要并在界面标注。
4. **多账号同机**：指纹按账号派生，但上游是否有设备级风控未实测；若出现 401/403 需按账号更换 `deviceId`。
5. **未实测项**：`claim` 真领一次（本次账号当天已签，未再消耗）；有 Token Plan 账号的套餐接口返回结构。
6. **模型上限口径**：`limit.context` 为 512000，另有 1000000 可选项；100 万档是否按请求参数切换未验证，
   第一版按 512000 上报。

## 十、留给实现者的决定

- 目录缓存的刷新间隔（建议跟随「手动拉取」+ 启动后一次；不新增定时器）。
- 余额刷新是否并入 `credits.startScheduler` 的 30 分钟节拍（建议并入，不新增调度）。
- 设置页是否加一行「同一账号勿与官方客户端同时使用」的说明文案（建议加一行提示，不加开关）。
- 指纹默认值（屏幕尺寸、`cpu_core_num` 等）是否按账号派生微扰，还是全机统一（建议统一，减少变量）。

## 十一、实现注记（2026-11-12 落地时的偏差）

1. **`meta.tokenExpiresAt` 改名为 `meta.accessExpiresAt`**：`store.cjs` 的 `stripSensitiveMeta` 用
   `/token|secret|password|apikey|api[-_]key|jwt|credential/i` 过滤 meta 键，`tokenExpiresAt` 命中
   `/token/` 且值未加密，会被静默丢弃（表现为 `tokenExpiryMs` 永远返回 0、预刷新永不触发）。
   实现与自测统一用 `accessExpiresAt`。
2. **`classifyError` 对未知模型 400 返回 `null`**：主干 `normalizeChannelCls` 不认 `badRequest` 这类
   自定义 kind，会落 `default` 兜底成固定 60 秒冷却；400 走通用分类器是 `fatal / switchable: false`
   （不罚号），语义正确。渠道级分类只保留 401/403 → `auth`。
3. **自测脚本沿用仓库既有 `pass/fail` 计数风格**（与 `tools/proxy-channels-selftest.cjs` 一致），
   未使用 `node:assert`。
4. **签到沿用余额的 desktop 指纹查询串**（含 `region=en`），实测 `signin/status` 与 `signin/claim`
   均返回 200；未复刻参考仓库里那套独立的签到查询串（字段更少、且未验证）。
5. **实测确认的额度事实**（本机 CN 账号）：`get_membership_info` 返回
   `op_credit_summary.total_remaining_amount = "400"`；`signin/status` 今日 `status: 3`（已签，400 积分）；
   `token_plan_credit` 返回 `remaining_credits: 0` 且带 `api_key`（`sk-cp-...`，该 key 直连模型 API 回
   401 `token is required`，不能当 Anthropic api-key 用）；`coding_plan/remains` 返回
   `2062 no active token plan subscription`。

