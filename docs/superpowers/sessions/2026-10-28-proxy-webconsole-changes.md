# 会话记录：桌面 exe 内置网页控制台（2026-10-28）

分支：`api-gateway`
范围：`effbcaf..a22aa7b`（41 个提交）
规格：`docs/superpowers/specs/2026-10-27-proxy-webconsole-design.md`
计划：`docs/superpowers/plans/2026-10-27-proxy-webconsole.md`

> `docs/` 被根 `.gitignore` 忽略，本文档与规格/计划只存在本机，未入库。

---

## 一、这次做了什么（一句话）

把桌面 exe 从「Electron + IPC 单机应用」扩展成「一个进程同时提供反代数据面、管理 HTTP 服务、网页控制台」：局域网浏览器可完整管理（除依赖本机的能力）；同时删除了号池 WebDAV/S3 同步与远程实例模块；最后做了开发期与界面性能优化。

## 二、最终架构

```
exe 进程
├── 反代数据面    :<反代端口>        /v1/chat/completions、/v1/messages、/v1/responses、/v1/models
├── 管理 API      :<反代端口 + 1>    /api/capabilities、/api/login、/api/rpc、/api/events、/api/status
├── 网页控制台    :<反代端口 + 1>    dist 静态资源 + SPA 回退
└── 桌面窗口      IPC                与原来一致
```

- 管理端口 = 反代端口 + 1，监听 `0.0.0.0`，与反代 `bind` 解耦。
- 桌面窗口与浏览器共用同一份数据库与同一份命令实现（`commandTable.collect()`）。
- Docker 形态保留可用，但**本次不改造**：容器仍是 Bearer + 明文；前端按 `capabilities.form` 分流（`browser` 走 ECDH，`container` 走旧 Bearer）。

## 三、安全与会话

- 单一管理令牌：加密存 `config.admin.token`，设置页「局域网访问」查看/修改，≥16 位、不可清空、不写日志。
- 浏览器登录用 ECDH P-256 协商，派生 `K_req/K_resp/K_sig`；令牌只在登录瞬间参与签名，不上网、不落浏览器。
- 会话 12 小时，服务端强制；浏览器 localStorage 只存 `sessionId` + 三把会话密钥 + 登录时间。
- 请求/响应/SSE 全 AES-256-GCM；HMAC 签名覆盖 sessionId + 方法 + 路径 + ts + nonce + 密文哈希；时间窗 ±5 分钟、nonce 去重防重放；SSE 帧带连接内递增 seq。
- 浏览器形态禁止：启停/重启网关、OAuth、IDE、ZCode、打开本机目录、主进程文件框、日志导出到本机、整份配置读写、令牌读写、本机登录态扫描。
- 两套 deny 文案：`DENY`（容器）与 `DENY_BROWSER`（浏览器），加载期校验同键；桌面 IPC 不套 deny。

## 四、功能清单

- 浏览器可管理：号池增删改/签到/刷新、API Keys、模型目录、自定义提供商、配置读写、日志、统计、账号 JSON 上传导入。
- 配置保存只写 `config.proxy`，保护四个 out-of-band 字段（渠道启停、按渠道签到、两个协议开关）；端口/绑定在浏览器端忽略。
- 写盘后广播 `config-changed`，桌面刷新内存快照，避免旧快照整份保存回滚浏览器写入。
- 日志/统计准实时：服务端 300/500ms 节流发“有新数据”通知（不带内容），前端按自增 id 拉增量并再节流 2 秒；15 秒兜底轮询；断线横幅与空态三态。
- 升级兼容：旧配置字段（webdav/remote/poolsync）读取时剔除；`configVersion` 标记；旧配置首次启动强制开启「最小化到托盘」并记一条「版本升级」日志。

## 五、主要文件

**新增**
- `electron/backend/admin.cjs`：管理服务（Express、静态资源、SPA、capabilities/login/rpc/events/status）
- `electron/backend/adminCrypto.cjs`：ECDH 会话、HMAC、AES-GCM、nonce/会话清理
- `electron/backend/commandTable.cjs`：可注入命令表、`modeOf/denyReason(cmd, form)`、两套 deny 表
- `src/api/adminCrypto.ts`：浏览器侧协议（@noble 纯 JS 实现，兼容局域网 HTTP）
- `src/views/proxy/loadState.ts`、`src/views/proxy/oplogIncrement.ts`：空态三态与日志增量合并

**删除**
- `electron/backend/webdav.cjs`、`s3.cjs`、`proxy/poolsync.cjs`、`proxy/poolsched.cjs`、`proxy/remote.cjs`
- `src/api/remote.ts`、`ConfigWebdavSection.vue`、`ConfigRemoteTargets.vue`、`ProxyPoolSyncView.vue`
- 依赖同步的 7 个自测脚本（保留 3 个改写为本机链路）

**关键修改**
- `electron/main.cjs`：启动管理服务、端口联动、令牌初始化、升级日志、开发跳过服务开关
- `electron/backend/config.cjs`：旧字段剔除、`configVersion`、令牌、`mergeOutOfBandProxy`、`validateProxyPort`
- `electron/backend/ipc.cjs` / `preload.cjs` / `src/api/ipc.ts`：命令表注入、`load_config` mtime 快照、令牌命令
- `electron/backend/proxy/index.cjs`：配置读写、账号文本导入、`pool` 事件、端口守卫
- `electron/backend/proxy/events.cjs` / `oplog.cjs` / `store.cjs`：节流通知、`sinceId` 增量
- `src/api/web-transport.ts` / `events.ts` / `caps.ts`：双形态分流、加密传输、连接状态
- `src/components/config/ConfigProxySection.vue` / `ConfigLanSection.vue` / `SettingsDialog.vue` / `Sidebar.vue`：配置读写、令牌面板、置灰与原因、浏览器隐藏设置
- `README.md`、`gateway/README.md`、`AGENTS.md`：文档同步

## 六、验证

全量回归 19 条命令，0 失败：

```
npm run build
node scripts/dev-sink-golden.cjs
node tools/gateway-closure-check.cjs          （111）
node tools/admin-server-selftest.cjs          （35）
node tools/admin-crypto-selftest.cjs          （43）
node tools/admin-crypto-browser-selftest.cjs  （27）
node tools/admin-deny-ui-selftest.cjs         （84）
node tools/proxy-config-web-selftest.cjs      （46）
node tools/proxy-import-text-selftest.cjs     （33）
node tools/event-throttle-selftest.cjs        （20）
node tools/oplog-increment-selftest.cjs       （21）
node scripts/test-poolsync-removed.cjs        （26）
node scripts/test-remote-removed.cjs          （34）
node scripts/test-account-import-formats.cjs  （7）
node tools/proxy-config-outofband-persist-selftest.cjs（29）
node tools/container-web-selftest.cjs         （45）
node tools/command-table-selftest.cjs         （16）
node tools/config-upgrade-selftest.cjs        （16）
node tools/admin-access-info-selftest.cjs     （31）
```

真实浏览器验证（系统 Edge + 真实管理服务，沙箱数据目录）：登录、号池读取、日志读取、SSE 事件自动刷新、模型/统计页渲染全部通过，控制台 0 错误。

## 七、性能优化（会话末尾）

- `vite.config.ts`：`server.watch.ignored` 排除 `electron/ gateway/ release/ tools/ scripts/ docs/ .superpowers/`，保留 `node_modules/.git`。
- 号池页冷却倒计时：1 秒 → 5 秒。
- `electron/main.cjs`：`AGENTHUB_DEV_SKIP_SERVICES=1` 时跳过反代网关与管理服务（仅非打包态）。
- **删除装饰动画**（保留功能性 loading 与 transition）：
  - 侧栏激活模块呼吸条、在线状态点波纹
  - 表格行入场 `rowIn`、渠道切换条 `stripIn`、渠道面板 `panelIn`、号池状态点 `pulse`
  - 保留：按钮 loading 转圈 `ctaSpin`、骨架屏 `shimmer`、所有 `transition`
- 实测：刚启动时 GPU 进程 170%、渲染 22%，主要来自玻璃面板内的无限动画；移除后 GPU 3D 从 56% 降到 **0%**，渲染与 GPU 进程 CPU 接近 0。

## 八、遗留与未做

**容器相关（用户明确暂不处理）**
- 桌面 `admin.cjs` 与容器 `gateway/src/index.cjs` 两套管理面并存
- 容器没有 ECDH 加密通道，仍 Bearer + 明文，且有只读令牌
- 容器路由未复用桌面模块

**合并后/发版前**
- asar 打包后的静态资源未实测（`npm run electron:pack` 后浏览器打开管理页验证）
- 真机双机（另一台电脑访问局域网 IP）未做，防火墙路径未验证
- 登录限流表、SSE 连接数无硬上限
- 浏览器多标签配置互踩（一个标签保存后另一个不刷新）
- 代码注释引用 `Ruling 1..44`，但 `docs/` 未入库，决策记录无法追溯
- 规格/计划文档状态已更新为本机文件，未入库
- `{type:"request"}` 已删，历史 `ProxyEvent` 类型已补但仅本机

## 九、常用操作

```powershell
# 正常开发
npm run dev

# 只改前端，跳过网关与管理服务
$env:AGENTHUB_DEV_SKIP_SERVICES="1"; npm run dev

# 恢复动画：把删掉的 animation 定义加回（见 git show a22aa7b / d302854 的反向 diff）
git revert a22aa7b d302854

# 打包
npm run electron:build
```

## 十、提交范围

`effbcaf..a22aa7b` 共 41 个提交，包含 13 个任务实现、各任务的评审修复轮、两次收尾清理、开发性能优化与动画删除。关键节点：

- `d85524e` 移除号池同步
- `7c14949` 移除远程实例
- `fbeeef2` 管理服务骨架
- `43c1c96` ECDH 通道
- `eaa4ae7` 浏览器侧改用 @noble（解决局域网 HTTP 无 WebCrypto）
- `0725481` 容器控制台恢复 Bearer 分流
- `096d9d2` 安全文案分形态、端口规则收口
- `8506875` dev 性能（Vite 监听、定时器、跳过服务）
- `a22aa7b` 删除装饰动画
