# 反向映射吸收的原生模型名：对外隐藏与拒绝直连

- 日期：2026-11-08
- 分支：`api-gateway`
- 状态：待评审

## 一、为什么做

"全渠道反向模型映射"的语义是：对外统一用一个请求名（如 `hy4`），网关按路由渠道自动翻译成该渠道的真实模型名（如 workbuddy 的 `hy4free`）。统一名是对客户端的**对外契约**，被映射的渠道真名只是**内部实现细节**。

现状：真名作为渠道原生模型，会和统一名一起出现在合并模型目录、客户端 `/v1/models` 清单里，也都能被直接请求。结果是同一个模型以两个名字对外暴露，客户端可能绕过统一名直接调真名。

## 二、目标

1. 客户端拉取模型清单（`/v1/models`）不出现"被映射吸收的渠道真名"；若该真名在别的渠道也原生存在且未被吸收，那条来源照常出现。
2. 直接请求被吸收的真名：当且仅当没有任何渠道能接时，由**网关直接拒绝**（按模型不存在返回 400），不透传给固定渠道。
3. 管理页**渠道页**保持现状：继续显示 `hy4free` 行并标注别名 `hy4`（不改）。
4. 管理页**"全部渠道"视图**隐藏被吸收的真名行（只留统一名）。

## 三、非目标

- 不改渠道页的合并显示逻辑（`src/views/proxy/channelRows.ts` 的 `mergeAliasRows`）。
- 不改"停用模型"（`disabledModels`）机制，也不把真名写进该清单。
- 不改恒等映射（统一名与真名逐字相同时，不隐藏）。
- 不改 `mergedModels` 的输出（管理页数据源，渠道页依赖它）。

## 四、反目标（这样算失败）

- 把统一名自己藏没了（恒等映射被误伤）。
- 连带藏掉**别的渠道**未映射的同名原生模型。
- 管理页渠道页也把 `hy4free` 藏掉了。
- 客户端仍能拉到或直接调用被吸收的真名。
- 固定渠道模式下，被吸收的真名被透传出去（应网关直接拒绝）。

## 五、判据（核心）

对渠道 `ch` 的原生模型名 `m`，称 `m` 在 `ch` 上**被吸收**，当且仅当存在统一名 `u`，满足：

1. `rev[u][ch]` 存在且 `reverseAliasTarget(u, ch, cfg)` 非空（映射合法生效）；
2. `reverseAliasTarget(u, ch, cfg)` 与 `m` **逐字相等**；
3. `u` 与 `m` **逐字不同**（排除恒等映射）。

补充：

- 恒等映射（`u === m` 逐字）不算吸收。
- 大小写不同算不同字面：`u = glm-5.3-flash`、`m = GLM-5.3-Flash` 时，`m` 被吸收、会被隐藏。
- 大小写逐字比对，与 `modelOwners` / `nativeModel` / `mergedModels` 现有口径一致。
- **统一名本身始终可以直接请求**：若某个名字同时是某条映射的统一名、又是某渠道的原生模型名（链式 / 打架配置），按统一名对待，仍可直连、仍出现在对外清单。也就是说「被吸收」不等于「不可直连」——这是与「绑定渠道」同样的边界（绑定渠道的 Key 直连被吸收真名仍放行），均为**有意为之**，防止把正在使用的统一名误藏。

## 六、改动点

### 后端 `electron/backend/proxy/adapters.cjs`

- 新增两个纯函数（导出供自测）：
  - `absorbedByAlias(model, channel, cfg)`：按上面判据，判断 `(m, ch)` 是否被吸收。
  - `isAbsorbedName(model, cfg)`：是否存在任意渠道吸收 `model`（供固定渠道透传分支判断）。
- `modelOwners` 的 exact 分支：逐字命中的渠道若 `absorbedByAlias(wanted, channel, c)` 为真，则**不加入归属**（`continue`）。
  - 效果：请求 `hy4free` 时 workbuddy 被剔除；无其它渠道→ `owners` 为空。
- `listableModels`：对 `mergedModels(enabledOnly)` 每行按来源剔除被吸收渠道；剩余来源为空 → 整行不出现。
  - 效果：`/v1/models` 只发统一名 `hy4`；`hy4free` 行（唯一来源被吸收）整体消失。

### 请求路径 `electron/backend/proxy/server.cjs`

- `resolveChannel` 的"模型不在任何目录"分支（fixed 策略放行固定渠道透传，约 195–197 行）：先判 `isAbsorbedName(model, settings)`，为真则**不放行**，返回 `unknownModel` → 走现有 400 文案（约 1123–1133 行）。
- 其它分支不变。

### 管理页 `electron/backend/proxy/index.cjs`

- `proxy_models`（约 1529 行）返回的每一行加标记字段，例如 `aliasAbsorbed: boolean`：该行的**所有**来源都被吸收时为 `true`（即该行是纯内部真名）。
- 便于前端"全部渠道"视图隐藏；渠道页不受影响。

### 前端

- `src/types/index.ts`：`ProxyModel` 加 `aliasAbsorbed?: boolean`。
- `src/views/proxy/ProxyModelsView.vue`：`rows` 计算里，当 `activeTab` 为空（"全部渠道"视图）时过滤 `aliasAbsorbed` 的行；具体渠道页不过滤。
  - 过滤范围要与"所见即所改"一致：搜索、批量开关、反选等作用范围都必须用过滤后的列表。

## 七、影响面提醒

这是**全局规则**：凡配过反向映射、被映射掉的真名都会照此隐藏并按需拒绝直连。例如已有的 `glm-5.3-flash → workbuddy 的 GLM-5.3-Flash`，落地后 `GLM-5.3-Flash` 会从对外清单消失、直接点名请求会被拒绝。

## 八、验证

- 新增自测（建议 `tools/proxy-reverse-alias-hide-selftest.cjs`）：覆盖判据的四个分支——被吸收剔除、恒等不剔、大小写不同剔除、其它渠道同名保留；`listableModels` 整行隐藏与来源剔除；`resolveChannel` 对被吸收名在 fixed 模式下直接拒绝。
- 复跑既有回归：`tools/proxy-channels-selftest.cjs`、`tools/proxy-models-merge-selftest.cjs`、`tools/proxy-smoke.cjs`、`tools/proxy-mapped-target-selftest.cjs`、`tools/proxy-model-order-selftest.cjs`。
- 调度核心闸：改动前 `node scripts/dev-sink-golden.cjs --write` 录基线，改动后比对（`modelOwners` 参与选路，可能改变选号顺序与流水）。
- 三协议回归：`scripts/dev-anthropic-in-test.cjs`、`scripts/dev-responses-in-test.cjs`。
- 类型门禁：`npm run build`；格式化：`npm run format:check`。
- 前端自测：`tools/proxy-models-filter-selftest.cjs` 若覆盖"全部/渠道"视图过滤，一并更新。

## 九、遗留待定（本稿已按建议定案）

- 固定渠道模式：被吸收真名一律由网关直接拒绝、不透传（已定）。
