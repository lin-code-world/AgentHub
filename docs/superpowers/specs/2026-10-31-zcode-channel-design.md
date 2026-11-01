# ZCode 渠道完善方案（B 方案 + 模型数据自更新）

- 日期：2026-10-31
- 分支：`api-gateway`
- 状态：待评审（本文档经评审人读过后可能有一轮补充问题）

## 一、为什么做

网关目前的 ZCode 渠道是从上游工程继承来的实现，它默认「这台电脑装过 ZCode 官方客户端」：模型能力、官方人设提示词、账号登录态都从本机客户端文件里读。

实际使用场景变了：最终发布的 exe 会放到一台**没有装 ZCode 客户端**的 Windows 机器（`192.168.2.129`）上，在那台机器上添加**多个** ZCode 账号对外提供反代服务。因此：

- 不能依赖「读取本机客户端登录态」来加账号（该机器上没有）；
- 不能依赖本机客户端文件来获得模型能力数据（否则会退化成写死的默认值，与客户端不一致）；
- 切号、借用设备指纹在官方客户端里领取周末套餐这类能力，在那台机器上天然无意义。

## 二、目标

1. 在**没有安装 ZCode 客户端**的机器上，ZCode 渠道的下列能力可用且与官方客户端口径一致：
   - 添加账号（官方授权页登录 / 粘贴导入）；
   - 拉取模型目录（模型清单按账号实际可用，能力元数据与官方客户端一致）；
   - 查询积分余额与套餐额度，并支持定时自动刷新；
   - 领取奖励（签到）的查询与领取链路，支持按渠道定时自动执行。
2. 模型能力数据**不依赖本机客户端**：软件自带一份保证离线可用，联网时自动更新到官方最新。
3. 本机上用不到的 ZCode 能力（切号、领取模式、指纹诊断/修复）在界面上如实标注前置条件，不静默失败。
4. 不再提供「从本机软件导入」这一入口（ZCode 渠道）。

## 三、非目标

- **不做凭据自动续期**（已验证：ZCode 的 `zcodejwttoken` 与 `oauth:*:access_token` 都不带有效期字段，官方客户端也没有续期实现，凭证失效只能重新登录/重新导入）。
- 不改动 ZCode 的对话协议翻译（`zcodeAnthropic.cjs`）、计费与调度主干。
- 不改变其它渠道的任何行为。
- 不做跨机传号（凭据导出/导入之外的同步能力）。

## 四、反目标（这样算失败）

- 在没有客户端的机器上加了账号却拿不到模型目录，或模型能力显示成写死的默认值。
- 为了拿模型数据而要求用户先装官方客户端。
- 更新模型数据失败时把已有数据弄坏（应保持上一份可用的）。
- 「从本机软件导入」入口去掉后，后端仍能被调用绕过（只关界面不算完成）。

## 五、约束

- 仓库语言中文；`.prettierrc`（printWidth 999、双引号、分号、2 空格）约束渲染层与脚本格式。
- 网关核心在 `electron/backend/proxy/`，全部 `.cjs`；渲染层在 `src/`（Vue 3 `<script setup lang="ts">`）。
- 新增 IPC 命令要三处同改：`ipc.cjs` / `preload.cjs` / `src/api/ipc.ts`（浏览器形态还涉及 `commandTable.cjs` 的门控分类）。
- 动网关调度核心前先录 `scripts/dev-sink-golden.cjs` 基线；本方案不改调度，但仍需跑既有回归确认无回归。
- 沙箱约定：自测脚本用 `AGENTHUB_DATA_DIR` 指向临时目录，不读写真实用户数据。

## 六、已核实的事实（本次实测，2026-10-31）

用本机已登录账号实测（只读，未执行领取）：

| 项 | 结果 |
| --- | --- |
| `GET /api/v1/zcode-plan/billing/balance` | HTTP 200，`code=0`，返回 1 条额度（`remaining_units` 合计 5e8），`capabilities` 含 `model:glm-5.3-flash` |
| `GET /api/v1/zcode-plan/billing/preview` | HTTP 200，`code=0`，`plans=[]`（当前无可领奖励活动） |
| `GET /api/v1/client/configs` | HTTP 200，`data.configs.builtin_provider_config_json` = `https://cdn-zcode.z.ai/...` |
| 下载该 URL | HTTP 200，`revision=43`、`schemaVersion=1`、137906 字节 |
| 与客户端本地那份比对 | `~/.zcode/v2/runtime/provider/windows-x86_64/3.16.3/endpoint-*/zcode-builtin.json` 同为 `revision=43`，字节数一致（本地为带缩进格式，263424 字节） |
| 模型能力解析（复刻现有 `resolveModelMeta`） | GLM-5.3 → 上下文 1000000 / 最大输出 128000 / 不支持图片；GLM-5.3-Flash → 支持图片·视频·PDF |
| `client/configs` 的 `captcha` | `{ enabled: true, sceneId: "11xygtvd", prefix: "no8xfe", region: "cn", skip_model_request: true }` |

结论：**在无客户端的机器上，模型数据与余额都能拿到；领取的「查询」通，「领取」动作本身未验证（见风险）。**

官方口径要点（来自官方开源仓库 `https://github.com/zai-org/ZCode` 的源码与文档，2026-10-31 按 main 分支查阅；本机客户端为 3.16.3，仓库最新为 3.17.1）：

- 客户端模型事实来源 = **内置模型配置（builtin provider/model config）+ 个人覆盖**；旧的 `models.dev` 目录已退役，不作为兜底。
- 运行时拉取路径：`GET {origin}/api/v1/client/configs?app_version=&platform=` → 取 `builtin_provider_config_json` → `GET` 该地址 → 得到内置配置。请求不带鉴权（`credentials: omit`）、不跟随重定向、总预算 20 秒、正文上限 10MB、有 schema 校验。
- 刷新策略：租约 + 下次可刷新时间 + 失败退避；成功间隔约 1 小时。
- 无自动续期（`refreshToken` 交换不存在）；`zcodejwttoken` 若带 `exp` 且已过期则要求重新登录。

## 七、方案选型

模型数据来源给过三个方案（用户已选 C）：

- **A｜只打包一份**：软件自带，换版本靠发版更新。稳定离线可用，但官方上新模型后要等我们更新。→ 否决（用户要能自动跟随官方）。
- **B｜只运行时拉**：不打包，全靠联网。离线或官方接口变更时没有可用数据。→ 否决（没有兜底）。
- **C｜打包 + 运行时更新（选定）**：自带一份保证任何时候都能用；联网时按官方口径拉最新并落盘；拉取失败保留上一份可用数据。

其余决策：

- **模型清单口径**：按「账号实际能用什么」取（`billing/balance` 的 `capabilities`），不改成客户端的内置全量清单。（用户明确要求；客户端内置清单含 202 个跨厂商模型，与单个账号的可用集无关。）
- **去掉「从本机软件导入」**：界面入口与后端扫描/导入一并关（见 8.1）。
- **续期**：不做（见非目标）。
- **实测领取动作**：不做（会消耗本周领取资格且必卡人工过码，无法自动化验证，见风险）。

## 八、分项设计

### 8.1 添加账号（ZCode）

保留两种途径，去掉一种：

| 途径 | 处置 |
| --- | --- |
| OAuth 登录（官方授权页 + 服务端轮询） | 保留，作为主路径 |
| 粘贴导入（`zcode://zai-auth/callback?code=…` 深链 / 凭据 JSON） | 保留，作为无浏览器交互机器上的主路径 |
| 从本机软件导入（扫描 `~/.zcode/v2/credentials.json` 与 account-profiles） | **去掉** |

改动点：

- 渲染层 `src/views/proxy/ProxyAgentsView.vue` 的 `addTabAllowed()`：对 `zcode` 渠道返回 `key !== "local"`（`local` 页签不出现）。同时确认 `METHOD_TABS` 过滤后只剩 oauth / file / paste。
- 后端 `electron/backend/proxy/discovery.cjs` 的 `scanZcode()`：从 `scanAll()` 的汇总里摘除；`scanZcode` 函数本身可保留（不影响其它功能）或删除，由实现者定（二者行为等价，删除更干净）。
- 后端导入入口 `electron/backend/proxy/index.cjs` 的 `proxy_scan_import`：拒绝对 `channel === "zcode"` 的扫描候选导入（与界面口径一致，防绕过；参考 MonkeyCode 的 `OAUTH_ONLY` 思路）。
- 注意 `index.cjs` 的 `normalizeZcodeSnapshot()`（整份 credentials 快照导入）**要保留**——它是「粘贴导入」的一种形态，与「扫描本机」无关。
- 顺带改文案：去掉本机导入后，引导语不能再指向它。现有两处要改——`adapters.cjs` 的 `refreshToken()`（现文案「凭证失效时请重新 OAuth 登录或从本机软件导入」）与 `zcodeSwitch.cjs` 的失败提示（现文案「未找到本机 ZCode 登录文件（~/.zcode/v2/credentials.json），请先安装并登录一次 ZCode 客户端」），统一改为「重新 OAuth 登录，或粘贴凭据导入」。

### 8.2 账号登录

现状已满足：`beginZcodeOAuth()`（`oauth/cli/init` → `oauth/cli/poll` 轮询；深链为主要兼容路径）+ `exchangeZcodeAuthCode()`（粘贴深链兜底）+ `activateZcodeAccount()`（登录后自动建 coding-plan API Key）。

需要补充/确认：

- 无客户端的机器上，浏览器里的 `zcode://` 回调没有处理程序。**必须依赖服务端 poll 翻 `ready`** 这条路（现有实现的 poll 路径就是为此设计的）。方案：登录面板文案明确写「授权完成后无需跳回本机，本机自动轮询完成入池」，并在 poll 超时后给出「把地址栏整段粘到下方」的兜底引导（现有 `OAUTH_HELP.zcode.desc` 已基本如此，微调即可）。
- 多账号：逐次执行 OAuth 即可，无客户端环境下每个账号的设备指纹按 UID 派生（`resolveAccountDeviceMid()` 的已有逻辑），不共享指纹。

### 8.3 模型目录（本方案的主要改动）

分三层：

**① 数据来源与优先级（按 revision 取最新）**

```
读模型能力元数据（resolveModelMeta）的三个来源：
  ├─ 网关自己的落盘副本 <dataDir>/proxy/zcode-builtin.json   （联网更新得到）
  ├─ 本机客户端目录 ~/.zcode/v2/runtime/provider/**/zcode-builtin.json （兼容旧行为：装了客户端时）
  └─ 仓库内置副本 electron/backend/proxy/assets/zcode-builtin.json （随软件发布，永远可用）
```

- 选择规则：三个来源中 `revision` 最大者胜出（`revision` 相同时优先「网关落盘 → 客户端目录 → 内置」，避免同版本在两个来源之间来回切换）；读不出 `revision` 的来源按不可用处理。
- **不能**写成「按固定顺序取第一个存在的来源」：装了客户端、且客户端已升到更高 revision 的机器上，固定顺序会让更旧的落盘副本抢占，模型能力整体倒退。
- 客户端目录那份**只读不改**（保留既有行为，装了客户端的用户仍能用到官方客户端已经下载的版本）。

**② 仓库内置副本**

- 内容 = 官方 `builtin_provider_config_json` 下载结果（当前 `revision=43`，`schemaVersion=1`）。
- 放置位置由实现者定（建议 `electron/backend/proxy/assets/zcode-builtin.json`），需确认 `package.json` 的 `build.files` / electron-builder 配置把该文件打进 asar。
- 更新方式：随版本发布更新，不自动改写（写不进 asar）。

**③ 运行时更新**

- 触发：应用启动后延迟若干秒执行一次；此后按固定间隔尝试（建议与官方一致：成功约 1 小时一次；失败退避：15 分钟起、上限 6 小时）。
- 请求：完全复刻官方口径——`GET {clientConfigsUrl}?app_version={c.appVersion}&platform={c.platform}`，**不带鉴权头**、不跟随重定向、总超时 20 秒、正文上限 10MB。
- 校验：`code === 0`；`data.configs.builtin_provider_config_json` 为 http(s) 且无用户名密码；下载结果 `schemaVersion === 1`、`revision` 为正整数、`config.modelConfigRules.modelRules` 为数组。任一不满足 → 放弃本次，保留现有数据。
- 落盘：原子写入 `<dataDir>/proxy/zcode-builtin.json`；仅当新 `revision` **大于**「三个来源中现有最大的 revision」时才覆盖（否则保留已有的更新那份，避免把更新的数据写旧）。
- 失败语义：静默保留上一份（记一条诊断日志，不打扰用户）。**不新增界面展示**——用户已明确选定：模型数据的版本与来源不上界面，改动保持最小；诊断只走日志。
- 并发：同一进程内串行（一次只有一个在途请求）；不需要跨进程文件锁（单实例桌面应用）。

**④ 模型清单（保持现状口径）**

- `adapters.zcode.fetchModels()` 继续从 `billing/balance` 的 `balances[].capabilities` 里取 `model:*`（账号实际可用集）。
- 取到 id 后，用上面的数据源解析元数据（上下文窗口 / 最大输出 / 图片·视频·PDF 支持），替换当前 `zcodeLocal.resolveModelMeta()` 的数据来源。
- 取不到元数据时的兜底与现在一致（嗅探 + 保守默认），但要有诊断输出（哪几个模型没有元数据）。

**⑤ 实现落点建议**

- `zcodeLocal.cjs` 的 `findClientBuiltin()` / `readClientModelRules()` / `resolveModelMeta()` 改造为「多来源查找 + 选定一份」；新增一个模块（如 `zcodeBuiltin.cjs`）负责来源优先级、内置副本、远端更新与落盘，避免把网络逻辑塞进 `zcodeLocal.cjs`。
- `zcodeBuiltin.json` 解析逻辑（`((config||{}).modelConfigRules||{}).modelRules` → `{ re, fmt, contextWindow, maxOutputTokens }`）保持现有形状，便于自测用同一份 fixture 断言。

### 8.4 官方人设提示词（对话必需）—— 本项不做，结论已实测

`start-plan` 上游要求 `system` 以官方提示词开头，否则返回 405/3012。现状：优先从本机客户端 bundle（`zcode.cjs`）按内容锚点提取，失败回落内置常量（1253 字，采自官方 3.14.4）。

实测结论（2026-10-31）：

- 官方开源仓库里**定位不到逐字同款**：`apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts` 是 `You are ZCode, an interactive agent`（少了 "coding"），`identity.ts` 是通用句 `You are an agent working with the user toward their goals…` —— 说明客户端里那段文案是**打包期产品化替换**生成的，仓库里只有未产品化的模板。
- 但内置常量**没有过时**：从本机 3.16.3 客户端的 `resources/glm/zcode.cjs` 按现有锚点提取出来的文本，与内置常量**逐字相同**（都是 1253 字）。

因此本项**不做**：保留「本机 bundle 优先 + 内置常量兜底」的现有实现。无客户端的机器上用内置常量，与客户端当前版本的文案一致。

附带发现（可选小修，不属于本方案必做）：现有 `bundleCandidates()` 只覆盖默认安装目录（`%LOCALAPPDATA%\Programs\ZCode`、`%ProgramFiles%\ZCode`、`~/.zcode/cli/zcode.cjs`）；本机装在 `D:\work\ZCode` 时提取不到（实测走了内置常量兜底）。将来若要支持自定义安装目录，需补候选路径或读注册表——与本次场景无关。

**2026-11-01 修订（上面的结论已被推翻，已按新实测重做）**

在真实客户端环境里复测后发现，问题不止一个，而且是叠加的：

1. **版本号必须是真实存在过的客户端版本**。`rules.zcode.appVersion` 当时填的是 `4.1.10`——上游没有这个版本，模型请求一律 `405 + code 3012 unusual activity`。控制面（余额 / 签到 / 客户端配置）对两种版本都回 200，**所以这个字段错了从余额上完全看不出来**，这也是它长期没被发现的原因。实测：只把版本号从 `3.16.3` 改回 `4.1.10`，其它一字不动，200 立刻变 3012。
2. **上游对 `system` 做的是内容指纹校验，不是「前缀匹配」**：
   - 只发一段 1253 字（当时的做法）→ 3012
   - 官方那两段拼成一个字符串 → 3012
   - 官方**两段数组**（42 + 3101 字）→ 200
   - 官方三段 + 第 4 段 → 3012（**整个 system 最多 3 段**）
3. 官方第 3 段（Desktop Context 之后的 7563 字正文）实测**非必需**；而且**第 3 段的位置可以放下游应用自己的 system**，放到 3 万字仍然通过。

因此改为：`system = [官方第 0 段, 官方第 1 段, 下游应用自己 system（合并成一块）]`。官方两段的原文从客户端 `model-io` 会话记录采集，落在 `assets/zcode-official-system.json`（带 `sourceClientVersion`）。原先"从客户端 bundle 按锚点提取前缀"的实现只能拼出 1253 字、已过不了校验，已删除；内置的 1253 字常量只保留作 assets 缺失时的兜底并会告警。

采集脚本：`scripts/dev-zcode-system-capture.cjs`——客户端升级后如果再现 3012，先核对 `appVersion`，再重跑这个脚本。

**运行时自动跟随（2026-11-01 追加）**：装了客户端的机器不必再手动跑脚本。`zcodeOfficialSystem.cjs` 每次解析时会检查客户端会话记录的 mtime，比自己缓存的新就地重采并落盘到 `<数据目录>/proxy/zcode-official-system.json`；读取优先级为 **客户端实时采集 → 落盘副本 → 打包 assets → 1253 字兜底**。客户端版本的读取同理：`adapters` 的 LLM 面头组改用客户端 runtime 目录里的真实版本，探测不到才回落配置值。于是客户端升级后提示词与版本号一起跟上；只有像目标机器那种**没装客户端**的环境才依赖打包内置那份。

实测：走网关真实 `chat()` 链路（start-plan + `glm-5.3-flash`）返回 200 并正常出话。

### 8.5 签到（领取奖励）

现状已满足链路：`checkinStatus()`（`billing/preview`）→ `checkin()`（验证码判定 → `billing/claim`）；自动签到按渠道配置（`checkinAutoRules`，每分钟 tick，默认关）。

本方案只做两件事：

1. 确认无客户端环境下链路完整（`checkinStatus` / `checkin` 都不读本机文件；`X-Device-Mid` 用账号派生指纹）。
2. 界面文案与提示保持如实：领取需要人工过码时弹独立验证窗（现有 `solveCaptcha` 能力），无图形环境如实标记为需人工。

不改 `claim` 的上游请求形态，不新增「制造活跃」类上报（沿用当前实现，与合规口径一致）。

### 8.6 积分余额与额度刷新

现状已满足：`queryCredits()`（`billing/balance` + `billing/current` 合并，coding-plan 另走 `monitorQuotaUrl`）+ `credits.startScheduler(creditsRefreshMin)`（默认 30 分钟）+ 手动刷新按钮。

本方案不改逻辑，仅确认无客户端环境下 `queryCredits` 不读本机文件（已确认：只依赖凭据与端点）。

### 8.7 无客户端环境下的界面降级

以下能力依赖本机 ZCode 客户端，在无客户端机器上要「可见但明确前置条件」，不静默失败：

| 能力 | 界面处置 |
| --- | --- |
| 切号（写为本机登录态） | 禁用并提示「需要本机安装并登录 ZCode 客户端」 |
| 领取模式（借本机指纹到官方客户端领套餐） | 同上 |
| 指纹诊断 / 指纹修复 | 无客户端时仍可用（指纹是网关自己的数据），但提示中不再指向「官方客户端里领取」 |
| 切号回滚 / 恢复本机指纹 | 无客户端时无意义，禁用并提示 |

判定方式：沿用现有 `proxy_ide_status` 的 `zcodeInstalled`（`~/.zcode/v2/credentials.json` 是否存在）。注意：**只有当「没有客户端」时才禁用**，装了客户端的用户行为不变。

## 九、风险与未验证项

1. **「领取」动作未真实验证**：`billing/claim` 会消耗本周领取资格且强制人工过码，本次没做。方案按官方口径实现，失败路径（1004 指纹已消耗 / 3007 验证码 / 1005 已领取）按现有映射处理。
2. **OAuth 在无客户端机器上的可用性**：依赖服务端 poll 翻转 `ready`。若官方调整中转页行为，登录会退化到「必须粘贴深链」。需要一次真机验证（在 129 那台机器上跑一次登录）。
3. **模型数据接口是私有口径**：`client/configs` + CDN 不是公开承诺的接口，官方可能改动。兜底是内置副本 + 失败保留旧数据；接口失效时功能退化为「用内置那份」，不会崩。
4. **官方人设提示词的版本漂移**：内置常量更新后仍可能随官方升级而过时；失效表现是上游 405/3012。诊断入口（`officialSystemPrefixSource()`）要保留并在界面上可见。
5. **多个账号共用一台机器**：设备指纹按 UID 派生（现有逻辑），但领取资格是「账号本周未领 ∧ 指纹本周未被消耗」——同机多号并发领取的相互影响未实测。

## 十、留给实现者的决定

- 内置副本与更新逻辑放哪个模块、文件叫什么名字（建议 `zcodeBuiltin.cjs` + `assets/zcode-builtin.json`）。
- 更新间隔与退避的具体数值（建议对齐官方：成功 1 小时、失败 15 分钟起、上限 6 小时）。
- 「从本机软件导入」后端是删掉 `scanZcode` 还是保留函数仅摘除汇总。
- 是否需要一次性手工把内置副本刷新到最新 revision（发版前用一条脚本从官方拉一次）。
