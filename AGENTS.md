# AGENTS.md

AgentHub：Windows 桌面应用（Electron + Vue 3 + TS），反代网关（多渠道 AI 上游的反向代理与号池管理）。本仓库 fork
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
  反代网关核心；`backend/config.cjs` 全局配置；`backend/webdav.cjs`/`s3.cjs` 号池同步的共享传输层。
- `src/` 渲染层（Vue 3 `<script setup lang="ts">`）：`views/proxy/` 网关页面，`api/ipc.ts` 统一 IPC 封装。
- `gateway/` Docker headless 形态：独立 package.json（依赖 `node:sqlite`，需 Node >= 22.5）。入口 `gateway/src/index.cjs` 复用
  `proxy/index.cjs` 的 `boot()`，只处理形态差异（监听覆盖、管理 REST API、停机序列）。

## 双形态共享网关核心

- `electron/backend/proxy/` 同时服务桌面版与 Docker 版（Dockerfile 直接 COPY 整个 `electron/backend`）。改 proxy 会同时影响两个形态。
- 两形态数据目录互不相通：桌面凭据是 safeStorage 密文，容器解不开；传号只走号池同步（poolsync）。部署细节见
  `gateway/README.md`。
- `gateway/**`、`electron/backend/**`、`tools/proxy-*.cjs`、`tools/gateway-*.cjs` 的变更会触发 `gateway-ci.yml`（核心自测 +
  Docker 构建冒烟，Node 22）。Docker 形态不设 `AGENTHUB_SECRET_KEY` 会拒绝启动（fail-closed，CI 有门禁）。

## 新增 IPC 命令要改三处

`electron/backend/ipc.cjs`（注册）→ `electron/preload.cjs`（白名单）→ `src/api/ipc.ts`（封装），三者一一对应，漏一处命令不通。渲染层调用统一走
`src/api/ipc.ts`：Vue 响应式 Proxy 直接过 `ipcRenderer.invoke` 会抛 "An object could not be cloned"，那里已统一 `toPlain`
脱壳。

## 前端约定

- `vite.config.ts` 里 unplugin-vue-components 设了 `dirs: []`：本地组件必须显式 import（自动注册已刻意关闭，避免同名静默换实现）；Element
  Plus 的 `<el-*>` 走 resolver 自动按需引入。
- Vite dev 端口 1420 `strictPort`，与 `electron/main.cjs` 的加载地址绑定，改动会断桌面开发。
- `npm run dev:web` 纯浏览器预览走 `src/api/mock.ts`（配置落 localStorage，未覆盖的命令返回 null 让页面降级）。

## 验证（无测试框架，全部是仓库内 .cjs 自测脚本）

- `npm run build` = `vue-tsc --noEmit` + `vite build`，是唯一类型门禁；仓库无 eslint / prettier 配置。
- `node scripts/dev-sink-golden.cjs` 是网关调度核心的「黄金字节等值」闸（响应字节 / 冷却决策 / 选号顺序 / 流水与基线逐字相等）。动
  `backend/proxy` 调度核心：改前 `--write` 录基线（`scripts/fixtures/gateway-sink-baseline.json`），改后比对。三协议回归闸另见
  `scripts/dev-anthropic-in-test.cjs`、`scripts/dev-responses-in-test.cjs`。
- 需要 Electron 运行时的脚本用仓库自带二进制跑：
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs`（全链路含假上游）。
- Docker 形态闭包自检：`node tools/gateway-closure-check.cjs`（下限 108，防 COPY 缩水）。
- 沙箱约定（gateway-ci 同款）：跑核心自测时把 `AGENTHUB_DATA_DIR` 指向临时目录；自测脚本不得读写真实用户数据。

## 环境与发布

- 本地打包 exe：`npm run electron:build`（类型检查 + 前端构建 + electron-builder）→ `release/` 下出
  `AgentHub-Setup-x.y.z.exe`（NSIS 安装版，`win.target` 只配了 nsis），版本号取 package.json 的 `version`；
  `npm run electron:pack` 只出未打包目录（`--dir`）。
- `.npmrc` 指向 npmmirror 的 Electron 与 electron-builder 二进制镜像；二进制下载失败（镜像未同步）时临时移除 `.npmrc` 重试。
- Docker 构建的 context 是仓库根：排除规则在根 `.dockerignore`，`gateway/` 下同名文件对它无效。
- `release.yml` 面向上游 HUIdada1/AgentHub 手动触发：版本必须严格高于最新 tag 且 tag 不可复用，`build/release-notes.md`
  必须非空。fork 上发版流程走不通。
