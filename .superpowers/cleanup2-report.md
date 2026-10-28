# 收尾补丁报告（api-gateway，基线 7d4dd23）

日期：2026-10-28。只做清单内改动，未动 Docker/容器功能代码、反代转发/选号/冷却/鉴权/计费。

## 一、安全描述（按形态分开）

1. `README.md` 安全提示第 1 条：删掉「登录令牌与全部数据都走明文 HTTP」的笼统说法，改为按形态分两条：
   - 桌面 exe 浏览器控制台：业务数据与令牌都经过应用层加密（ECDH 协商、AES-GCM），令牌不以明文上网；但页面本身没有 TLS，仍只建议可信局域网内使用；
   - 容器 Web 控制台：Bearer 令牌 + 明文 JSON / SSE，抓包即可看到令牌与内容，必须放可信内网，或前置 TLS 反向代理。
   「页面不可信、可被同网段嗅探或篡改」「不要映射到公网」措辞保留。
2. `src/components/config/ConfigLanSection.vue` 安全提示同理改为桌面形态口径（ECDH + AES-GCM 全密文、令牌不以明文上网；页面无 TLS，仍限可信局域网）。

## 二、文案与显示

3. `src/views/WebLogin.vue` 副标题按形态区分：浏览器形态（桌面 exe 控制台）提示令牌来自桌面端『设置 · 局域网访问』且不落浏览器；容器形态保留 `AGENTHUB_ADMIN_TOKEN` 文案。
4. `src/components/Sidebar.vue` 端口卡片：选「挂载时取真实值」方案——Web 托管形态（`settingsUnavailable()` 为真，即 load_config 被 deny）挂载时调一次 `api.proxyConfigGet()`，把真实 `port` 写进 `app.config.proxy.port`，失败静默保留默认显示。复用已有 `api` import，无循环依赖；同一显示缺陷在容器形态一并被修正（只改显示，不动容器功能代码）。
5. `src/components/Sidebar.vue` 主题 tooltip：按 ConfigLanSection 既有做法在 tooltip 与 `:disabled` 按钮之间垫一层 `<span>`（disabled 控件不派发鼠标事件，否则原因弹不出来）。

## 三、重复规则收口

6. `electron/backend/admin.cjs` 的 `adminPortOf` 改为复用 `config.validateProxyPort`（同一份 1~65534 规则），错误消息与 `EADMINPORT` code 不变、行为不变；`config.cjs` 不依赖 `admin.cjs`，无循环依赖。
   `tools/admin-server-selftest.cjs` 补 2 条断言：`adminPortOf` 与 `config.validateProxyPort` 对 0 / 65535 / 9527 / 65534 结论一致；`adminPortOf(9527) === 9528`。

## 四、文档状态（docs/ 被 .gitignore 忽略，改动已生效但未入库）

7. `docs/superpowers/specs/2026-10-27-proxy-webconsole-design.md`：首行状态改「已实施（2026-10-28）」；5.2 第 1 条改「随同步模块一并删除；如未来需要备份/导出加密，再单独引入」。
8. `docs/superpowers/plans/2026-10-27-proxy-webconsole.md`：75 处 `- [ ]` → `- [x]`，末尾加「实施完成：effbcaf..7d4dd23（含收尾清理）」。
9. `AGENTS.md` 验证章节补一条：管理服务 / 浏览器控制台相关自测（admin-server、admin-crypto、admin-crypto-browser、admin-deny-ui、container-web、command-table）与删除守卫（test-poolsync-removed、test-remote-removed）。

## 五、注释现状化与自测沙箱

10. 注释残留改写：
    - `electron/backend/proxy/discovery.cjs`：「refresh_token 另存 refresh 列，供号池同步按通用键搬运」→「refresh_token 另存 refresh 加密列，续期链路按通用键从这里读」（store 列名核实为 `refresh_enc`）；
    - `src/api/ipc.ts` 4 处：Key 批量删除「墓碑先行 + WebDAV 传播」→「逐个走单删链路」；号池批量删除 →「逐个走单删链路（含 CatPaw 会话清理）」；重命名「WebDAV 同步时 LWW 传播」→「改 name 字段，本机即时生效」（对照 `proxy/index.cjs` 实现）；备注「随 WebDAV 快照导出 + 新者胜传播」→「随明文凭据导出带走」；
    - `src/views/proxy/ProxyKeysView.vue`：批量删除注释去掉「墓碑先行，经 WebDAV 传播到其他设备」；
    - 清单外同类残留一处（已改，不需可回退）：`src/stores/app.ts` 设置弹窗注释仍写「通用 / WebDAV 同步 / 数据与备份」，实际是「通用 / 刷新周期 / 局域网访问」，按现状改写。
11. 上一批遗留的 5 个不清理沙箱的自测脚本补清理：`proxy-crypto-envelope` / `proxy-lobster` / `proxy-modelscope` / `proxy-raccoon` / `proxy-stats-rename`。
    **实现偏差（与清单「补 finally 清理」字面不同）**：改用 `process.on("exit")` 清理钩子。原因：① 这 5 个脚本多处 `process.exit()`，上一批已实测 `process.exit()` 不执行 `finally`，纯 try/finally 包裹收不到尾；② 主体多为 500 行级直线/IIFE 代码，包 try/finally 会全文件重缩进，diff 失控（违反精准修改）；③ exit 钩子覆盖成功 / 失败 / `process.exit()` 全部退出路径，语义强于 finally。钩子里先 `store.close()` 关 sqlite 句柄再删——实测 Windows 上不关句柄 `stats.db` 报 `EBUSY` 删不掉（`close()` 幂等、未 open 时是 no-op，对不用 store 的脚本也安全）。

## 测试结果（全部通过）

| 命令 | 结果 |
| --- | --- |
| `npm run build`（vue-tsc + vite build） | ✅ built in 35.82s（chunk 大小警告为存量） |
| `node tools/gateway-closure-check.cjs` | ✅ 闭包 111 个文件，完整 |
| `node tools/admin-server-selftest.cjs` | ✅ 35 passed / 0 failed（含新增 2 条端口规则一致性断言） |
| `node tools/admin-crypto-browser-selftest.cjs` | ✅ 27 passed / 0 failed |
| `node tools/admin-deny-ui-selftest.cjs` | ✅ 84 passed / 0 failed |
| `node tools/container-web-selftest.cjs` | ✅ 45 passed / 0 failed |
| `node tools/command-table-selftest.cjs` | ✅ 16 passed / 0 failed |
| `node scripts/test-poolsync-removed.cjs` | ✅ 26 项通过 |
| `node scripts/test-remote-removed.cjs` | ✅ 34 项通过 |
| 5 个补清理脚本回归 | ✅ crypto-envelope 15 passed、stats-rename pass=26、raccoon 12 通过、lobster 27 passed、modelscope 31 passed；跑完 %TEMP% 无新增沙箱残留 |

格式：改动行按 `.prettierrc`（printWidth 999 / 双引号 / 分号 / 2 空格）核对无偏差；`prettier --check` 对 5 个改动的前端文件报 warn，经逐行 diff 证实全部来自存量历史行（与本次改动行无关），按 AGENTS.md「存量代码不做全量对齐」未动。

## 遗留（未动，留决策）

1. `docs/` 被 `.gitignore:56` 忽略：第 7、8 项文档改动在工作区生效但**未入库**。
2. 存量 prettier 格式未对齐的历史行（`src/api/ipc.ts`、`Sidebar.vue`、`ProxyKeysView.vue`、`stores/app.ts`、`ConfigLanSection.vue`）保持原样。
3. `%TEMP%` 下 10-26 ~ 10-27 的历史沙箱残留若干非本次引入，未清理；本次会话产生的残留已精确清除。
4. `src/stores/app.ts:104` 注释清理属清单外同类残留（见上文第 10 项末条），如要求严格限于清单可单独回退该行。
