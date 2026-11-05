# AGENTS.md

AgentApiGateway：Windows 桌面应用（Electron + Vue 3 + TS），反代网关（多渠道 AI 上游的反向代理与号池管理）。本仓库 fork
自上游 https://github.com/HUIdada1/AgentHub.git（origin 为 lin-code-world/AgentHub），已移除上游的技能仓库 / 用量统计 /
记忆中枢三大板块，只保留反代网关。仓库语言为中文：提交信息、注释、文档一律简体中文，提交信息用
conventional 前缀（`feat(gateway): …` / `fix(proxy): …`）。

## 沟通方式（最高优先）

仓库主人不了解这个工程的技术内容：回复一律用白话文，从产品角度描述——讲清楚做了什么、为什么做、对使用有什么影响；不出现技术术语，确需引用文件名 / 报错信息等原文时，先用一句白话解释它是什么再给原文。

## 分支策略

- `main` 是上游工程的**镜像分支**，只用来跟上游同步，不在它上面修改代码（不编辑、不提交）。
- 同步目标：本地 `main` 与 fork 的 `main`（`origin` = `lin-code-world/AgentHub`）都要与上游
  `HUIdada1/AgentHub`（`upstream`）的 `main` 保持一致；方向以上游为准——从 `upstream` 拉取，再把 `main`
  推回 `origin`，让三方一致。
- 修改代码一律在 `api-gateway` 分支上操作。

## 源文件版权头

上游源文件头部带「版权与授权声明，禁止删除」注释块（`vite.config.ts`、`electron/main.cjs`、`electron/preload.cjs`、
`src/App.vue` 等普遍存在）：编辑这些文件时保留头部声明，不要当无关注释清理。

## 架构

- `electron/` 主进程，全部 `.cjs`（CommonJS）：`main.cjs` 应用入口；`preload.cjs` IPC 白名单桥；`backend/proxy/`
  反代网关核心；`backend/config.cjs` 全局配置；`backend/admin.cjs` 管理服务（局域网网页控制台的 HTTP 入口）；
  `backend/commandTable.cjs` 命令表与形态门控；`backend/adminCrypto.cjs` 会话协商与请求加解密。
- `src/` 渲染层（Vue 3 `<script setup lang="ts">`）：`views/proxy/` 网关页面，`api/ipc.ts` 统一 IPC 封装。
- 平台适配层 `electron/backend/proxy/platform/index.cjs`：按运行环境分发到 Electron 或纯 Node 实现。网关核心模块**禁止直接
  `require("electron")`**，只许 require 本文件（否则纯 Node 自测跑不起来）；必需方法有启动期契约断言，`electron.cjs` /
  `node.cjs` 缺一即 require 阶段就炸。`ELECTRON_RUN_AS_NODE` 按纯 Node 处理。
- 渠道适配器两种存放：trae / raccoon / modelscope / lobster / zcode 内联在 `proxy/adapters.cjs`（约 5000 行）；较新渠道
  （catpaw / autoclaw / cline / loomy / accio / codearts）一渠道一个目录（`proxy/<渠道>/adapter.cjs` 等），在
  `adapters.cjs` 尾部 require 挂进 `ADAPTERS`。新增渠道按子目录方式做。

## 管理服务与浏览器会话（桌面网页控制台）

- `backend/admin.cjs`：Express，端口 = 反代端口 + 1，监听地址与反代 `bind` 一致（`start({ port, bind, commandTable, staticDir })`；
  只有显式 `"127.0.0.1"` 算仅本机，其余一律按 `0.0.0.0` 处理）——选「仅本机」时管理页也只有本机能访问。
  `/api/rpc` 转发到与桌面 IPC 同一份命令表（`backend/commandTable.cjs` 的 `collect()`），不碰反代调度、选号、冷却、计费。
- 令牌与会话：单一管理令牌（`backend/config.cjs` 加密落盘，桌面「设置 · 局域网访问」查看 / 修改，≥16 位不可清空）；登录走 ECDH
  P-256 协商派生 12 小时会话密钥（`backend/adminCrypto.cjs` 与 `src/api/adminCrypto.ts` 协议逐字对齐，改动两边一起改），请求 /
  响应 / SSE 全密文，时间窗 + 随机数防重放；会话存浏览器 localStorage，令牌只在登录瞬间参与签名、不落浏览器；改令牌即全部会话失效。
- 命令门控：`commandTable.cjs` 的 `modeOf(cmd)` / `denyReason(cmd)`；deny 表只有 `DENY_BROWSER` 一张（浏览器不可用命令 +
  桌面专用命令：令牌读写 / 目录 / 整份配置）。新增 deny 命令直接加进这张表。注意 `proxy_scan` 同时在 `READ` 集合（界面分类）但浏览器必须拒——deny 优先。

## 网关核心

- `electron/backend/proxy/` 是唯一的网关核心实现，桌面窗口与局域网网页控制台共用同一份调度、选号、冷却与计费。
- 只有一种运行形态，凭据以 safeStorage 加密落盘；跨机传号走凭据 JSON 导出 / 导入（号池 WebDAV/S3 同步已移除）。

## 渠道路由特殊判断走插件

- 任何「只针对某个渠道」的路由偏好（如某渠道余额构成、某渠道临时让位等）**不得**在 `pool.cjs` / `server.cjs` 主干里写 `if (channel === "xxx")`，一律做成独立插件，便于添加与移除。
- 注册表 `electron/backend/proxy/routePolicies.cjs`：集中 `require` 各插件，按渠道匹配、取最大档位；插件抛错按 0 兜底，不能让插件异常影响请求。
- 插件位置 `electron/backend/proxy/<渠道>/routePolicy.cjs`，导出 `{ id, channel, accountRank(acc) }`（注册表只读 `channel` 与 `accountRank`，`id` 仅作标识）。`accountRank` 只回答「该账号是否该排后面」（0 = 正常，>0 = 靠后），必须是纯函数：不查库、不发请求、无副作用；判断不了（字段缺失等）一律返回 0。
- 主干只实现两个通用能力：① `pickAccount` 按档位分层（档位内仍用原到期优先 / 余额优先 / 轮询策略）；② 渠道让位——实际首选渠道的所有**可用**账号（在线、有凭据、余额未耗尽、未到期）档位均 >0 时，把它挪到候选队尾并保留末位（其他渠道全失败仍可回落到它）。显式边界不参与让位：API Key 绑定渠道、固定渠道策略命中、单模型指定命中（见 `server.cjs` 的 `isExplicitRoute`）。
- 添加渠道特殊路由：新建插件文件 + 注册表加一行；移除：删文件 + 删注册表一行。主干零改动，行为自动回到默认。
- 职责边界：余额解析、到期时间修正等**数据层**知识留在渠道适配器 / 余额模块，不进路由插件；插件只表达排序偏好。

## 新增 IPC 命令要改三处

`electron/backend/ipc.cjs`（注册）→ `electron/preload.cjs`（白名单）→ `src/api/ipc.ts`（封装），三者一一对应，漏一处命令不通。渲染层调用统一走
`src/api/ipc.ts`：Vue 响应式 Proxy 直接过 `ipcRenderer.invoke` 会抛 "An object could not be cloned"，那里已统一 `toPlain`
脱壳。命令表 `commandTable.collect()` 会自动收集 `ipc.cjs` 与 `proxy/index.cjs` 的注册，浏览器端自动可用；但 preload 白名单仍要手改，
并决定它在 `READ` / `DENY_BROWSER` 的分类与前端置灰（浏览器端配置读写走 `proxy_config_get` / `proxy_config_save`，不用整份 `load_config` / `save_config`）。

## 前端约定

- 代码格式化以根目录 `.prettierrc` 为准（printWidth 999 保持长行不拆、双引号、带分号、2 空格缩进、LF）：新写/修改的代码在提交前按它对齐，可用 `npm run format:check` 校验、`npm run format` 格式化；存量代码不做全量对齐，被 IDE 重排的文件以 prettier 口径收编。`.prettierignore` 排除了 markdown、构建产物与 `scripts/fixtures/`。
- `vite.config.ts` 里 unplugin-vue-components 设了 `dirs: []`：本地组件必须显式 import（自动注册已刻意关闭，避免同名静默换实现）；Element
  Plus 的 `<el-*>` 走 resolver 自动按需引入。生成的声明文件 `src/components.d.ts` **入库**：组件增删会让它变化，要随代码一起提交，否则类型门禁失真。
- Vite dev 端口 1420 `strictPort`，与 `electron/main.cjs` 的加载地址绑定，改动会断桌面开发。
- 浏览器形态的请求统一走 `src/api/web-transport.ts` 与 `events.ts`，只走桌面管理服务的 ECDH 加密通道。
  不要在页面里直接 fetch，否则会绕过鉴权、重试与错误收口。

## 运行时数据目录与开发开关

- 数据目录固定在 `%APPDATA%\AgentHub`：`main.cjs` 顶部先 `app.setName("AgentHub")` 再钉死 userData（package.json 的 name 是
  `agent-api-gateway`，不要按它猜目录名）；`config.cjs` 的 `dataDir()` 在纯 Node 下回落到同一路径，脚本直跑与主进程读同一份配置。
  `AGENTHUB_DATA_DIR` 环境变量优先级最高——跑核心自测时把它指向临时目录做沙箱，自测脚本不得读写真实用户数据。
- `AGENTHUB_DEV_SKIP_SERVICES=1 npm run dev`：只改前端时跳过反代网关与管理服务的启动（仅未打包生效）。
- `AGENTHUB_ALLOW_MULTI=1`：跳过单实例锁并把 userData 隔离到 `AgentHub-dev`，可与安装版并存调试。

## 验证（无测试框架，全部是仓库内 .cjs 自测脚本）

- `npm run build` = `vue-tsc --noEmit` + `vite build`，是唯一类型门禁；仓库无 eslint 配置，格式化由 prettier 负责（见前端约定）。
- `node scripts/dev-sink-golden.cjs` 是网关调度核心的「黄金字节等值」闸（响应字节 / 冷却决策 / 选号顺序 / 流水与基线逐字相等）。动
  `electron/backend/proxy` 调度核心：改前 `--write` 录基线（`scripts/fixtures/gateway-sink-baseline.json`），改后比对。三协议回归闸另见
  `scripts/dev-anthropic-in-test.cjs`、`scripts/dev-responses-in-test.cjs`。
- 需要 Electron 运行时的脚本用仓库自带二进制跑：
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs`（全链路含假上游）。
- 管理服务 / 浏览器控制台相关自测：`node tools/admin-server-selftest.cjs`（管理服务骨架与轻量状态）、`node tools/admin-crypto-selftest.cjs` 与 `node tools/admin-crypto-browser-selftest.cjs`（ECDH 两端协议与连接状态机）、`node tools/admin-deny-ui-selftest.cjs`（浏览器门控与置灰）、`node tools/web-ui-state-selftest.cjs`（网页端事件接线与空态）、`node tools/command-table-selftest.cjs`（命令表与 deny 真源）；删除守卫：`node scripts/test-poolsync-removed.cjs`、`node scripts/test-remote-removed.cjs`、`node scripts/test-monkeycode-removed.cjs`；其余自测见 `tools/` 与 `scripts/`（配置读写、导入、事件节流、日志增量、端口校验、渠道专项等）。
- 网关核心依赖闭包自检：`node tools/gateway-closure-check.cjs`（下限 109，防引用指向已删文件）。
- 渠道路由插件自测：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-channel-defer-selftest.cjs`（队列让位 / 截断、显式边界门控、账号分档与渠道让位）；余额 `known` 口径与插件判据另见 `tools/proxy-channels-selftest.cjs`。
- 测试模型清单 `scripts/fixtures/test-catalog.json`：自测要用的模型目录数据（模型目录已不在代码里内置，没拉取过就是空的）。**动上游渠道代码时要同步检查它**——条目字段可能随渠道变动（如 autoclaw 的 routeId、catpaw 要的上游数字 modelType），漏改会让对应自测失真或直接失败。

## 环境与发布

- **部署目标（渠道反代逻辑的硬约束）**：本地调通后 `npm run electron:build` 打包成 exe，装到
  `192.168.2.129` 那台远程 Windows 上运行。**那台机器没有安装任何渠道对应的桌面客户端**，所以渠道
  相关代码不得依赖本机客户端文件：号池切号 / 从本机客户端读登录态 / 从客户端 bundle 提取提示词或模型
  元数据 / 依赖客户端进程的这些能力，在目标环境里一律不可用。需要的这类数据只有两条路——随包内置到
  `electron/backend/proxy/assets/`，或者运行时从上游拉取并落盘到数据目录（`config.dataDir()`），
  读不到时必须能降级且如实告警，不能因此让请求失败或让账号被误判。
- **Qoder 渠道对上述约束的例外走「打包预提取」**：其请求签名依赖客户端内置 wasm，构建前先跑
  `scripts/stage-qoder-signer.cjs`（已嵌进 `electron:build` / `electron:pack`）：本机装了 Qoder 客户端就现场提取签名器烘进
  `build/qoder-signer/`（gitignore，约 33MB），随包进 `resources/`；本机没装则回退 `AGENTHUB_QODER_SIGNER_SRC` 或
  `%APPDATA%\AgentApiGateway\proxy\qoder-signer` 的现成缓存，两者都没有直接失败不静默。跨机传 Qoder 号用 Go 写的导出工具
  `tools/qoder-export/`（Windows 专用，编译产物 `qoder-export.exe` 已入库随包）。
- 调试远程实例：网关暴露 `GET /status` 调试接口（返回各渠道号池 / 健康降级 / 今日统计等内部状态，排查问题用）。
  默认开放但需带管理令牌（`Authorization: Bearer <令牌>` 或 `x-admin-token: <令牌>`，令牌 = 「设置 · 局域网访问」复制的那个），
  不带或带错令牌返回 401。远程实例要把「绑定地址」设为局域网开放（0.0.0.0）其他电脑才连得上；
  令牌明文走 HTTP（无 TLS），仅在可信局域网内使用，别暴露到公网。
- 已部署的调试远程实例：管理页 `http://192.168.2.129:39528/`，反代端口 `39527`，管理令牌
  `3ab5925d5c3c958f2997e646f1cc4f0aa00d34ec405ad5e8`（`GET /status` 用它，见上一条）。
- 本地打包 exe：`npm run electron:build`（签名器烘入 + 类型检查 + 前端构建 + electron-builder）→ `release/` 下出
  `AgentApiGateway-Setup-x.y.z.exe`（NSIS 安装版，`win.target` 只配了 nsis），版本号取 package.json 的 `version`；
  `npm run electron:pack` 只出未打包目录（`--dir`）。
- `.npmrc` 指向 npmmirror 的 Electron 与 electron-builder 二进制镜像；二进制下载失败（镜像未同步）时临时移除 `.npmrc` 重试。
- 本分支**没有 GitHub Actions 工作流**（`.github/workflows` 已整体移除，只剩 ISSUE_TEMPLATE）：发版完全在本地做，不要假设 CI 会打包或发布。

## 文档与变更记录（注意 docs/ 不入库）

- `.gitignore` 里有 `docs/` 全局忽略：仓库里现存的几份记录（如 `docs/superpowers/sessions/2026-10-28-proxy-webconsole-changes.md`
  网页控制台改造记录、`docs/superpowers/specs/` 设计稿）是被跟踪的特例；**在 docs/ 下新建文件默认不会出现在 git status 里**，
  需要入库时得 `git add -f`，或写到会被跟踪的位置。
- 2026-10 以来的要点：桌面 exe 内置网页控制台（管理服务 + ECDH 会话，见上文两节）；号池同步（WebDAV/S3）、远程实例、
  MonkeyCode 渠道已整体移除（有守卫脚本）；装饰动画已删除，只保留功能性 loading 与 transition；号池倒计时 5 秒；
  开发时只改前端可用 `AGENTHUB_DEV_SKIP_SERVICES=1`。发版前仍需：真机双机验收、`npm run electron:pack` 后确认 asar 静态资源可加载。
