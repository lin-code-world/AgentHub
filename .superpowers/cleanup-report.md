# 分支收尾遗留清理报告（api-gateway，基线 cb19326）

改动共 20 个文件，严格按清单执行，未扩大范围、未重构。以下按清单逐项说明。

## 一、规格补漏

### 1. 升级日志（规格 9.1）
- `electron/backend/config.cjs`：新增模块级标记 `lastLoadLegacy`（`loadConfig()` 每次读取刷新：磁盘无 `configVersion` 或 < 2 即为旧配置），导出 `wasLastLoadLegacy()`。
- `electron/main.cjs`：`whenReady` 里首次 `loadConfig()` 后立即捕获 `upgradedFromLegacy`，`proxy.boot()` 完成后若为旧配置则 `oplog.log("info", "版本升级", "已升级到新版本（v{版本}）")`，整体包 try/catch 静默，不阻塞启动。
- 立即捕获布尔值的原因：后续 `ensureAdminToken()` 等路径会把合并结果（含 `configVersion: 2`）写回磁盘，若 boot 后现读会丢标记。
- 自测（`tools/config-upgrade-selftest.cjs` 新增 F 组）：F1 旧配置（无 configVersion）读取后标记为已升级；F2 新配置（configVersion: 2）不记；F3 main.cjs 接线（oplog「版本升级」）存在且失败静默。

## 二、注释与死代码清理

2. `electron/backend/proxy/discovery.cjs`：「临期预刷新与 PoolSync 仲裁少了依据」→「临期预刷新少了依据（跨设备凭据仲裁已移除）」。
3. `src/components/config/ConfigLanSection.vue`：注释「整块降级为「暂不可用」」→「地址不可用」，与实际文案一致。
4. `electron/backend/config.cjs` 头注释：「反代网关 / 远程目标配置」→「全局配置（主题 / 关窗行为 / 反代网关）与管理令牌等」。
5. `electron/preload.cjs`：「主进程广播（更新状态 / WebDAV 进度 / focus-update 跳转信号）」→「主进程广播（网关状态 / 号池结构 / 配置变更等）」。
6. `electron/backend/proxy/store.cjs` 7 处现状化：`accounts.updated_at` / `token_at` 迁移注释、`keys.updated_at` 迁移注释、`importKey`（改为「凭据/Key 导入」，LWW→新者胜、远端→来源）、`updateKey` 的 updated_at 说明、`tokenUsable` 历史说明、账号备注（随明文凭据导出带走）、`addAccount` 凭据时刻、`updateAccount` 凭据时钟、`setCreditPackages` 入口说明。
7. `src/types/index.ts`：备注注释「随 WebDAV 同步」→「随明文凭据导出带走」；操作分类注释按实际分类重写（含新增的「版本升级」，去掉已不存在的「号池同步」）。
8. `src/views/proxy/ProxyAgentsView.vue` 3 处残留注释：批量删除（去掉「墓碑先行 / WebDAV 传播」，改为 CatPaw 会话清理 + 汇总一条日志；`electron/` 下已无墓碑实现）、备注弹窗两处（去掉 WebDAV 表述）。
9. `electron/backend/proxy/server.cjs`：删除 `emitRequestThrottled()` 函数、`reqEvt` 状态与调用点（`{type:"request"}` 无任何消费者）。请求统计走 `store.insertUsage`、日志走 `oplog.log("代理请求", …)`，均不依赖该事件，已确认不受影响。
10. `src/types/index.ts` 的 `ProxyEvent.type`：按全仓 `events.emit` 实测改为 `"status" | "credits" | "oauth-done" | "stats" | "oplog" | "pool" | "channel-health" | "resync"`（`resync` 为浏览器 SSE 重连后前端补发的同形信号）；已删除的 `"request"` 一并移出。

## 三、门控与安全小项

11. `electron/backend/commandTable.cjs`：`get_is_portable` 加入 READ（只读分类，不参与鉴权判定）。
12. `tools/gateway-closure-check.cjs`：ENTRIES 增加 `electron/backend/commandTable.cjs`、`electron/backend/admin.cjs`、`electron/backend/adminCrypto.cjs`（闭包扫描认相对路径 require，三者及其依赖都能入闭包，实测无缺失）；下限按实测重录 107 → **111**，`AGENTS.md` 中的下限数字同步更新。
13. `electron/backend/admin.cjs` `loginHandler`：`adminCrypto.createSession()`（内部 `kTokenOf()`/`ensureAdminToken()` 会读写配置盘）包 try/catch，异常统一 401 文案，不再让 Express 兜成 HTML 500。
14. `src/api/adminCrypto.ts` `handleAuthLost`：恢复模块级 reload 闸 `authLostNavigating`（并发 401 只 reload 一次），`login()` 成功落会话后复位，之后再失效照常跳登录页（S5/S6/S7 各自登录后仍各跳一次，既有自测不受影响）。
15. `electron/backend/admin.cjs` `rpcHandler`：`proxy_vault_status` 在浏览器形态按命令脱敏（删除返回值里的 `dataDir`，桌面 IPC 返回不变），命令本身仍可用、不进 deny 表。
16. `src/components/config/ConfigGeneralSection.vue`：托盘开关文案补「关闭：关闭后直接退出应用，浏览器与反代都会断开」。

## 四、前端小修

17. `src/components/Sidebar.vue`：浏览器形态（`settingsHidden`）下主题按钮禁用、点击无效，tooltip 换成「请在桌面窗口修改主题」；桌面保持「切换亮暗主题」。
    - **实现口径说明**：清单写「隐藏并给 tooltip」，完全 `v-if` 隐藏则 tooltip 无处可挂，故实现为「切换能力隐藏（禁用）+ tooltip 指引」。若要改成彻底不渲染，删掉该按钮即可，请确认。
18. `src/views/proxy/ProxyLogView.vue`：新增 `incError` —— rows 非空且增量拉取失败时，旧行保留（不改 rows），表格上方显示一条粘性小条「日志增量刷新失败，已保留上次数据：…」+ 重试；刷新恢复即消失，不用 toast（15s 兜底轮询反复失败时不会刷屏）。
19. `src/api/mock.ts`：补 `proxy_config_get`（返回 mock 配置的 proxy 段）与 `proxy_config_save`（proxy 段合入 mock 配置，沿用 mock 既有 localStorage 持久约定），纯预览用。
20. 自测沙箱清理：`tools/admin-access-info-selftest.cjs`、`tools/config-upgrade-selftest.cjs` 补 `try { … } finally { fs.rmSync(SANDBOX, ...) }`（`process.exit` 移到 finally 之后——实测 `process.exit()` 不会执行 finally；安全闸门的 `process.exit(2)` 分支另有手动收尾）。
    - 清单内其余候选核对结果：`admin-crypto`、`admin-server`、`proxy-config-web`、`proxy-import-text`、`event-throttle`、`container-web` 均已有沙箱清理（成功路径 `try{rmSync}catch{}` 或 `.finally()` / `finally`），按「已有清理的跳过」未改；`oplog-increment-selftest` 不建沙箱（纯函数自测），无需清理。
    - `tools/command-table-selftest.cjs` 按指令明确排除，未动。

## 测试结果（全部通过）

| 命令 | 结果 |
| --- | --- |
| `npm run build`（vue-tsc + vite build） | 通过（chunk 大小警告为既有现象） |
| `node scripts/dev-sink-golden.cjs` | 16 场景响应字节 / 冷却决策 / 选号顺序 / 流水与基线逐字相等 |
| `node tools/gateway-closure-check.cjs` | 111 个文件（下限 111），闭包完整 |
| `node tools/admin-server-selftest.cjs` | 33 passed |
| `node tools/admin-crypto-selftest.cjs` | 43 passed |
| `node tools/admin-crypto-browser-selftest.cjs` | 27 passed（S5/S6/S7 跳转断言与 reload 闸兼容） |
| `node tools/admin-deny-ui-selftest.cjs` | 84 passed |
| `node tools/proxy-config-web-selftest.cjs` | 46 passed |
| `node tools/proxy-import-text-selftest.cjs` | 33 passed |
| `node tools/event-throttle-selftest.cjs` | 20 passed |
| `node tools/oplog-increment-selftest.cjs` | 21 passed |
| `node scripts/test-poolsync-removed.cjs` | 26 项通过 |
| `node scripts/test-remote-removed.cjs` | 34 项通过 |
| `node scripts/test-account-import-formats.cjs` | 7 项通过 |
| `node tools/proxy-config-outofband-persist-selftest.cjs` | 29 passed |
| `node tools/container-web-selftest.cjs` | 45 passed |
| `node tools/command-table-selftest.cjs` | 16 passed |
| 另：`tools/config-upgrade-selftest.cjs` 16 passed、`tools/admin-access-info-selftest.cjs` 31 passed（本次改动直接相关） |

## 遗留（未动，留决策）

1. 同类残留注释（不在清单内，按「不要扩大范围」未改）：
   - `electron/backend/proxy/discovery.cjs:3476`「供号池同步按通用键搬运」；
   - `src/api/ipc.ts`（批量删除 / 重命名 / 备注共 4 处「WebDAV 传播 / LWW」）、`src/views/proxy/ProxyKeysView.vue:180`、`src/stores/app.ts:104`「WebDAV 同步」。
2. 沙箱仍不清理的自测脚本（清单外）：`proxy-crypto-envelope`、`proxy-lobster`、`proxy-modelscope`、`proxy-raccoon`、`proxy-stats-rename`（多为 500 行级直线脚本，包 try/finally 改动面大）；`proxy-command-table-selftest` 按指令明确排除。
3. `%TEMP%` 下存在本次改动之前产生的 `ah-*` 自测沙箱残留若干（10-27 ~ 10-28 早间），非本次引入，未清理。
4. item 17 的「隐藏 + tooltip」实现口径见上文说明，请确认。
5. 按约束未动：asar 打包验证、SSE 连接数上限、登录限流硬上限、浏览器主题持久化方案。
