# AGENTS.md

AgentApiGateway：Windows 桌面应用（Electron + Vue 3 + TS），反代网关（多渠道 AI 上游的反向代理与号池管理）。本仓库 fork
自上游 https://github.com/HUIdada1/AgentHub.git（origin 为 lin-code-world/AgentHub），已移除上游的技能仓库 / 用量统计 /
记忆中枢三大板块，只保留反代网关。仓库语言为中文：提交信息、注释、文档一律简体中文，提交信息用
conventional 前缀（`feat(gateway): …` / `fix(proxy): …`）。

## 分支策略

- `main` 分支只用来跟上游工程（HUIdada1/AgentHub）同步，不在它上面修改代码。
- 修改代码一律在 `api-gateway` 分支上操作。

## 源文件版权头

上游源文件头部带「版权与授权声明，禁止删除」注释块（`vite.config.ts`、`electron/main.cjs`、`electron/preload.cjs`、
`src/App.vue`、`gateway/` 等普遍存在）：编辑这些文件时保留头部声明，不要当无关注释清理。

## 架构

- `electron/` 主进程，全部 `.cjs`（CommonJS）：`main.cjs` 应用入口；`preload.cjs` IPC 白名单桥；`backend/proxy/`
  反代网关核心；`backend/config.cjs` 全局配置；`backend/admin.cjs` 管理服务（局域网网页控制台的 HTTP 入口）。
- `src/` 渲染层（Vue 3 `<script setup lang="ts">`）：`views/proxy/` 网关页面，`api/ipc.ts` 统一 IPC 封装。
- `gateway/` Docker headless 形态：独立 package.json（依赖 `node:sqlite`，需 Node >= 22.5）。入口 `gateway/src/index.cjs` 复用
  `proxy/index.cjs` 的 `boot()`，只处理形态差异（监听覆盖、管理 REST API、停机序列）。

## 管理服务与浏览器会话（桌面网页控制台）

- `backend/admin.cjs`：Express，监听 0.0.0.0，端口 = 反代端口 + 1（`start({ port, commandTable, staticDir })` 传的是反代端口）。
  `/api/rpc` 转发到与桌面 IPC 同一份命令表（`backend/commandTable.cjs` 的 `collect()`），不碰反代调度、选号、冷却、计费。
- 令牌与会话：单一管理令牌（`backend/config.cjs` 加密落盘，桌面「设置 · 局域网访问」查看 / 修改，≥16 位不可清空）；登录走 ECDH
  P-256 协商派生 12 小时会话密钥（`backend/adminCrypto.cjs` 与 `src/api/adminCrypto.ts` 协议逐字对齐，改动两边一起改），请求 /
  响应 / SSE 全密文，时间窗 + 随机数防重放；会话存浏览器 localStorage，令牌只在登录瞬间参与签名、不落浏览器；改令牌即全部会话失效。
- 命令形态门控：`commandTable.cjs` 的 `modeOf/denyReason(cmd, form)`，`form` 分 `container` / `browser`；deny 文案两表
  `DENY`（容器）与 `DENY_BROWSER`（浏览器），`DENY` 同键必须在 `DENY_BROWSER` 有文案（加载期 fail-fast），`DENY_BROWSER` 另含
  桌面专用命令（令牌读写 / 目录 / 整份配置）。改 deny 集合两表一起改。

## 双形态共享网关核心

- `electron/backend/proxy/` 同时服务桌面版与 Docker 版（Dockerfile 直接 COPY 整个 `electron/backend`）。改 proxy 会同时影响两个形态。
- 两形态数据目录互不相通：桌面凭据是 safeStorage 密文，容器解不开；两形态间没有自动传号通道（号池
  WebDAV/S3 同步已移除），灌号走凭据 JSON 导入。部署细节见
  `gateway/README.md`。

## 新增 IPC 命令要改三处

`electron/backend/ipc.cjs`（注册）→ `electron/preload.cjs`（白名单）→ `src/api/ipc.ts`（封装），三者一一对应，漏一处命令不通。渲染层调用统一走
`src/api/ipc.ts`：Vue 响应式 Proxy 直接过 `ipcRenderer.invoke` 会抛 "An object could not be cloned"，那里已统一 `toPlain`
脱壳。

## 前端约定

- 代码格式化以根目录 `.prettierrc` 为准（printWidth 999 保持长行不拆、双引号、带分号、2 空格缩进、LF）：新写/修改的代码在提交前按它对齐，可用 `npm run format:check` 校验、`npm run format` 格式化；存量代码不做全量对齐，被 IDE 重排的文件以 prettier 口径收编。
- `vite.config.ts` 里 unplugin-vue-components 设了 `dirs: []`：本地组件必须显式 import（自动注册已刻意关闭，避免同名静默换实现）；Element
  Plus 的 `<el-*>` 走 resolver 自动按需引入。
- Vite dev 端口 1420 `strictPort`，与 `electron/main.cjs` 的加载地址绑定，改动会断桌面开发。
- `npm run dev:web` 纯浏览器预览走 `src/api/mock.ts`（配置落 localStorage，未覆盖的命令返回 null 让页面降级）。

## 验证（无测试框架，全部是仓库内 .cjs 自测脚本）

- `npm run build` = `vue-tsc --noEmit` + `vite build`，是唯一类型门禁；仓库无 eslint 配置，格式化由 prettier 负责（见前端约定）。
- `node scripts/dev-sink-golden.cjs` 是网关调度核心的「黄金字节等值」闸（响应字节 / 冷却决策 / 选号顺序 / 流水与基线逐字相等）。动
  `backend/proxy` 调度核心：改前 `--write` 录基线（`scripts/fixtures/gateway-sink-baseline.json`），改后比对。三协议回归闸另见
  `scripts/dev-anthropic-in-test.cjs`、`scripts/dev-responses-in-test.cjs`。
- 需要 Electron 运行时的脚本用仓库自带二进制跑：
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs`（全链路含假上游）。
- Docker 形态闭包自检：`node tools/gateway-closure-check.cjs`（下限 107，防 COPY 缩水）。
- 沙箱约定：跑核心自测时把 `AGENTHUB_DATA_DIR` 指向临时目录；自测脚本不得读写真实用户数据。

## 环境与发布

- 本地打包 exe：`npm run electron:build`（类型检查 + 前端构建 + electron-builder）→ `release/` 下出
  `AgentApiGateway-Setup-x.y.z.exe`（NSIS 安装版，`win.target` 只配了 nsis），版本号取 package.json 的 `version`；
  `npm run electron:pack` 只出未打包目录（`--dir`）。
- `.npmrc` 指向 npmmirror 的 Electron 与 electron-builder 二进制镜像；二进制下载失败（镜像未同步）时临时移除 `.npmrc` 重试。
- Docker 构建的 context 是仓库根：排除规则在根 `.dockerignore`，`gateway/` 下同名文件对它无效。
- `release.yml` 面向上游 HUIdada1/AgentHub 手动触发：版本必须严格高于最新 tag 且 tag 不可复用，`build/release-notes.md`
  必须非空。fork 上发版流程走不通。
