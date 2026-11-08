# 反向映射吸收的原生模型名：对外隐藏与拒绝直连 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"被反向映射占用的渠道真名"从对外模型清单消失、并拒绝客户端直连，同时保留统一名、保留其它渠道未映射的同名模型、保留管理页渠道页的现有显示。

**Architecture:** 在网关核心新增一个纯判据 `absorbedByAlias(model, channel, cfg)`，在三个出口复用它：请求归属（`modelOwners`）、对外清单（`listableModels`）、管理页标记（`proxy_models`）；请求选路（`resolveChannel`）在"无任何归属"分支上对被吸收名直接判"模型不存在"。

**Tech Stack:** Node.js（CommonJS `.cjs`，网关核心）、Vue 3 `<script setup lang="ts">` + TypeScript（渲染层）、仓库内 `.cjs` 自测脚本（无测试框架）。

**Spec:** `docs/superpowers/specs/2026-11-08-reverse-alias-hide-native-design.md`

## Global Constraints

- 仓库语言中文；提交信息用 conventional 中文前缀（`feat(gateway): …` / `fix(proxy): …`）。
- 格式化以根目录 `.prettierrc` 为准：printWidth 999、双引号、分号、2 空格缩进、LF；提交前 `npm run format:check`。
- 网关核心在 `electron/backend/proxy/`，全部 `.cjs`；平台相关只能 require `platform/index.cjs`，禁止直接 require electron。
- 逐字大小写口径必须与既有 `modelOwners` / `nativeModel` / `mergedModels` 一致：`GLM-5.3-Flash` 与 `glm-5.3-flash` 是不同模型。
- 自测脚本用 `AGENTHUB_DATA_DIR` 指向系统临时目录，不读写真实用户数据。
- 动网关核心（`electron/backend/proxy`）调度相关的，提交前按下面 Task 5 走 `scripts/dev-sink-golden.cjs`。
- 保留 `electron/backend/proxy/*` 与 `src/*` 文件头部的"版权与授权声明，禁止删除"注释块。

## Review Focus

以下五类输入/失败模式，spec 隐含但易被忽略；每条已指派到对应 Task 的测试断言：

1. **恒等映射**（统一名与真名逐字相同，如 `hy4 → workbuddy: hy4`）：不得隐藏统一名本身。（Task 1）
2. **仅大小写不同**（`glm-5.3-flash → workbuddy: GLM-5.3-Flash`）：真名 `GLM-5.3-Flash` 应隐藏，统一名 `glm-5.3-flash` 保留。（Task 1）
3. **真名在别的渠道也有原生且未被映射**：那些渠道的归属与来源必须保留，请求仍能路由到它们。（Task 1、Task 2）
4. **被吸收真名 + 固定渠道策略**：必须由网关直接判"模型不存在"，不透传给固定渠道。（Task 3）
5. **请求统一名不受影响**：请求统一名时仍正常走映射渠道（本改动不得破坏现有反向映射链路）。（Task 1）

---

### Task 1: 吸收判据 + 请求归属剔除

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（新增 `absorbedByAlias` / `isAbsorbedName` 并导出；`modelOwners` 的 exact 分支剔除被吸收渠道，约 4990–5002 行）
- Test: `tools/proxy-reverse-alias-hide-selftest.cjs`（新建）

**Interfaces:**
- Consumes: 现有 `reverseAliasTarget(model, channel, cfg)`（同文件，约 4758 行）、`proxyConfig()`、导出表 `module.exports`（约 5032 行）。
- Produces:
  - `absorbedByAlias(model: string, channel: string, cfg?) => boolean`
  - `isAbsorbedName(model: string, cfg?) => boolean`
  - `modelOwners(model, cfg)` 行为变化：不再把"被吸收的真名"归给吸收它的渠道。

- [ ] **Step 1: 写失败的测试**

新建 `tools/proxy-reverse-alias-hide-selftest.cjs`，骨架与断言如下（后续 Task 在同一文件追加断言组）：

```js
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-rev-alias-hide-"));
process.env.AGENTHUB_DATA_DIR = tmp;

const adapters = require(path.join(ROOT, "electron/backend/proxy/adapters.cjs"));

let fail = 0;
const eq = (a, e, l) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) { fail++; console.log(`FAIL ${l}\n 期望 ${JSON.stringify(e)}\n 实际 ${JSON.stringify(a)}`); }
  else console.log(`ok  ${l}`);
};
const check = (l, cond, extra) => { if (cond) console.log(`ok  ${l}`); else { fail++; console.log(`FAIL ${l}${extra ? " — " + extra : ""}`); } };

const withChannels = (fake, fn) => {
  const orig = { ...adapters.ADAPTERS };
  try {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, fake);
    return fn();
  } finally {
    for (const k of Object.keys(adapters.ADAPTERS)) delete adapters.ADAPTERS[k];
    Object.assign(adapters.ADAPTERS, orig);
  }
};

// [1] 吸收判据 + 请求归属
withChannels({ workbuddy: { models: () => ["hy4free", "GLM-5.3-Flash", "glm-5.3"] }, zcode: { models: () => ["glm-5.3-flash"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" }, "glm-5.3-flash": { workbuddy: "GLM-5.3-Flash" }, "glm-5.3": { workbuddy: "glm-5.3" } } };
  eq(adapters.absorbedByAlias("hy4free", "workbuddy", cfg), true, "hy4free 被 hy4 占用");
  eq(adapters.absorbedByAlias("hy4free", "zcode", cfg), false, "zcode 没占用 hy4free");
  eq(adapters.absorbedByAlias("glm-5.3", "workbuddy", cfg), false, "恒等映射不算吸收");
  eq(adapters.modelOwners("hy4free", cfg), [], "被吸收真名：无归属");
  check("统一名 hy4 仍归属 workbuddy", adapters.modelOwners("hy4", cfg).includes("workbuddy"));
  eq(adapters.modelOwners("GLM-5.3-Flash", cfg), [], "仅大小写不同的真名也被吸收");
  check("统一名 glm-5.3-flash 归属含 zcode", adapters.modelOwners("glm-5.3-flash", cfg).includes("zcode"));
});

// [3] 别的渠道同名原生、未映射 → 归属保留
withChannels({ workbuddy: { models: () => ["hy4free"] }, catpaw: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  eq(adapters.modelOwners("hy4free", cfg), ["catpaw"], "另一渠道同名原生保留归属");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 句柄交给系统 */ }
if (fail) { console.log(`\n结果：${fail} 失败`); process.exit(1); }
console.log("\n结果：全部通过");
process.exit(0);
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: FAIL —— `adapters.absorbedByAlias is not a function`；且 `modelOwners("hy4free", cfg)` 期望 `[]` 实际 `["workbuddy"]`。

- [ ] **Step 3: 实现判据与导出**

在 `electron/backend/proxy/adapters.cjs` 中 `reverseAliasTarget` 之后新增：

```js
/** 该渠道的原生模型名 model 是否被某条反向映射「吸收」（占用）：
 *  存在统一名 u，rev[u][ch] 生效且映射目标与 model 逐字相等，且 u 与 model 逐字不同（排除恒等映射）。 */
function absorbedByAlias(model, channel, cfg) {
  const c = cfg || proxyConfig();
  const rev = c.modelReverseAliases || {};
  const m = String(model || "");
  for (const u of Object.keys(rev)) {
    if (u === m) continue;
    const target = reverseAliasTarget(u, channel, c);
    if (target && target === m) return true;
  }
  return false;
}

/** 是否存在任意渠道吸收该名字（供"无归属"时直接拒绝、不走透传兜底）。 */
function isAbsorbedName(model, cfg) {
  const c = cfg || proxyConfig();
  const rev = c.modelReverseAliases || {};
  const m = String(model || "");
  for (const u of Object.keys(rev)) {
    if (u === m) continue;
    const chMap = rev[u];
    if (!chMap || typeof chMap !== "object") continue;
    for (const ch of Object.keys(chMap)) {
      if (reverseAliasTarget(u, ch, c) === m) return true;
    }
  }
  return false;
}
```

在导出表（约 5032 行的 `module.exports`）`reverseAliasEntry, resolveModelTarget` 附近加入 `absorbedByAlias, isAbsorbedName`。

在 `modelOwners` 的 exact 分支（`if (ad.models().some((m) => String(m) === wanted)) {` 内、`seen.add` 之前）加入一行：

```js
      // 被反向映射占用：该渠道不再认这个原生名（只藏被占用那份，其它渠道同名不受影响）
      if (absorbedByAlias(wanted, channel, c)) continue;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: 全部 `ok`，结尾 `结果：全部通过`。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/adapters.cjs tools/proxy-reverse-alias-hide-selftest.cjs
git commit -m "feat(gateway): 反向映射吸收的真名不再归属对应渠道"
```

---

### Task 2: 对外模型清单过滤

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（`listableModels`，约 5010–5018 行）
- Test: `tools/proxy-reverse-alias-hide-selftest.cjs`（追加断言组）

**Interfaces:**
- Consumes: `absorbedByAlias`（Task 1）、`mergedModels(cfg, { enabledOnly: true })`。
- Produces: `listableModels(cfg)` 行为变化——被吸收的真名按来源剔除；无剩余来源的行不出现。

- [ ] **Step 1: 追加失败的测试**

在自测文件 `[3]` 组之后追加：

```js
// [2] 对外清单：唯一来源被吸收 → 整行隐藏；另有来源 → 保留
withChannels({ workbuddy: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  const ids = adapters.listableModels(cfg).map((m) => m.id);
  check("统一名 hy4 在对外清单", ids.includes("hy4"));
  check("唯一来源被吸收 → hy4free 不在对外清单", !ids.includes("hy4free"));
});
withChannels({ workbuddy: { models: () => ["hy4free"] }, catpaw: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  const row = adapters.listableModels(cfg).find((m) => m.id === "hy4free");
  check("仍有其它来源 → hy4free 保留", !!row);
  eq(row && row.sources, ["catpaw"], "被吸收的来源 workbuddy 被剔除");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: FAIL —— 唯一来源场景仍能取到 `hy4free`；`row.sources` 仍含 `workbuddy`。

- [ ] **Step 3: 实现过滤**

将 `listableModels` 改为：

```js
function listableModels(cfg) {
  const c = cfg || proxyConfig();
  const off = new Set((c.disabledModels || []).map((s) => String(s)));
  const rows = mergedModels(c, { enabledOnly: true }).filter((m) => !off.has(m.id));
  // 反向映射吸收的真名：按来源剔除被吸收的渠道；无剩余来源 → 整行不出现（对外只留统一名）
  const out = [];
  for (const m of rows) {
    const all = m.sources || [];
    const kept = all.filter((ch) => !absorbedByAlias(m.id, ch, c));
    if (!kept.length) continue;
    out.push(kept.length === all.length ? m : { ...m, sources: kept });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/adapters.cjs tools/proxy-reverse-alias-hide-selftest.cjs
git commit -m "feat(gateway): 对外模型清单隐藏被反向映射吸收的真名"
```

---

### Task 3: 无归属时直接拒绝（固定渠道与提供商兜底都不透传）

**Files:**
- Modify: `electron/backend/proxy/server.cjs`（`resolveChannel`，约 192–204 行：`owners.length === 1 / > 1` 之后、fixed 分支之前）
- Test: `tools/proxy-reverse-alias-hide-selftest.cjs`（追加断言组）

**Interfaces:**
- Consumes: `adapters.isAbsorbedName`（Task 1）。
- Produces: `resolveChannel(key, model, settings)` 对被吸收名在无归属时返回 `{ channel: null, unknownModel: true }`。

- [ ] **Step 1: 追加失败的测试**

在自测文件顶部 require 补上 server：`const server = require(path.join(ROOT, "electron/backend/proxy/server.cjs"));`，然后在末尾追加：

```js
// [4] 被吸收名无归属：固定渠道也直接拒绝，不透传
withChannels({ workbuddy: { models: () => ["hy4free"] }, zcode: { models: () => ["glm-5.3-flash"] } }, () => {
  const s = { routeStrategy: "fixed", fixedChannel: "zcode", channelEnabled: {}, modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  const r = server.resolveChannel({ route: "auto" }, "hy4free", s);
  eq(r.unknownModel, true, "被吸收真名：固定渠道下也判 unknownModel（不透传给 zcode）");
  // [5] 请求统一名仍走映射渠道
  const ok = server.resolveChannel({ route: "auto" }, "hy4", s);
  eq(ok.channel, "workbuddy", "请求统一名 hy4 仍路由到 workbuddy");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: FAIL —— `r.unknownModel` 为 `undefined`，实际返回 `{ channel: "zcode" }`（透传）。

- [ ] **Step 3: 实现**

在 `resolveChannel`（`server.cjs`）中，"模型不在任何目录"注释那条（约 192 行）**之前**插入：

```js
  // 被反向映射占用的真名：没有任何渠道认领时直接判「模型不存在」——
  // 不走 fixed 透传试错、也不走提供商裸名兜底（对外只认统一名）。
  if (adapters.isAbsorbedName(model, settings)) return { channel: null, unknownModel: true };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/server.cjs tools/proxy-reverse-alias-hide-selftest.cjs
git commit -m "feat(gateway): 被反向映射吸收的真名在无归属时直接拒绝"
```

---

### Task 4: 管理页标记 + "全部渠道"视图隐藏

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（新增行级判据 `aliasRowAbsorbed` 并导出）
- Modify: `electron/backend/proxy/index.cjs`（`proxy_models`，约 1542–1588 行给每行加标记）
- Modify: `src/types/index.ts`（`ProxyModel`，约 467–500 行加字段）
- Modify: `src/views/proxy/ProxyModelsView.vue`（`rows` 计算，约 122–143 行）
- Test: `tools/proxy-reverse-alias-hide-selftest.cjs`（追加断言组）+ `npm run build`

**Interfaces:**
- Consumes: `absorbedByAlias`（Task 1）。
- Produces:
  - `aliasRowAbsorbed(model: string, sources: string[], cfg?) => boolean`
  - `proxy_models` 每行多出 `aliasAbsorbed: boolean`；`ProxyModel.aliasAbsorbed?: boolean`。

- [ ] **Step 1: 追加失败的测试**

在自测文件末尾追加：

```js
// [6] 行级吸收判据：该行所有来源都被吸收 → "全部渠道"视图隐藏
withChannels({ workbuddy: { models: () => ["hy4free"] }, catpaw: { models: () => ["hy4free"] } }, () => {
  const cfg = { modelReverseAliases: { hy4: { workbuddy: "hy4free" } } };
  eq(adapters.aliasRowAbsorbed("hy4free", ["workbuddy"], cfg), true, "唯一来源被吸收 → 隐藏");
  eq(adapters.aliasRowAbsorbed("hy4free", ["workbuddy", "catpaw"], cfg), false, "另有来源 → 不隐藏");
  eq(adapters.aliasRowAbsorbed("hy4", ["workbuddy"], cfg), false, "统一名不隐藏");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: FAIL —— `adapters.aliasRowAbsorbed is not a function`。

- [ ] **Step 3: 实现行级判据与后端标记**

在 `adapters.cjs` 的 `isAbsorbedName` 之后新增，并把 `aliasRowAbsorbed` 加入导出表：

```js
/** 行级：该模型行的所有来源是否都被反向映射吸收（纯内部真名，"全部渠道"视图隐藏用）。 */
function aliasRowAbsorbed(model, sources, cfg) {
  const arr = Array.isArray(sources) ? sources : [];
  return arr.length > 0 && arr.every((ch) => absorbedByAlias(model, ch, cfg));
}
```

在 `index.cjs` 的 `proxy_models` 返回里给每行加字段。在 `const item = { ...m, enabled: …, …` 里、`enabled` 之后加入：

```js
        // 该行所有来源都被反向映射吸收（纯内部真名）：供"全部渠道"视图隐藏，渠道页不受影响
        aliasAbsorbed: adapters.aliasRowAbsorbed(m.id, m.sources, cfg),
```

- [ ] **Step 4: 实现前端类型与过滤**

`src/types/index.ts` 的 `ProxyModel` 内、`accountless?: boolean;` 附近加入：

```ts
  /** 该行所有来源都被反向映射吸收（纯内部真名）：仅在"全部渠道"视图隐藏 */
  aliasAbsorbed?: boolean;
```

`src/views/proxy/ProxyModelsView.vue` 的 `rows` computed 过滤链中，在 `if (activeTab.value && !m.sources.includes(activeTab.value as ProxyChannelId)) return false;` 之后加入：

```ts
    // "全部渠道"视图隐藏被反向映射吸收的真名行；具体渠道页保留（渠道页由 mergeAliasRows 处理）
    if (!activeTab.value && m.aliasAbsorbed) return false;
```

- [ ] **Step 5: 运行测试与类型门禁**

Run: `node tools/proxy-reverse-alias-hide-selftest.cjs`
Expected: 全部 `ok`。

Run: `npm run build`
Expected: `vue-tsc --noEmit` 与 `vite build` 均无错误。

Run: `npm run format:check`
Expected: 通过（若报格式，运行 `npm run format` 后重跑）。

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/index.cjs src/types/index.ts src/views/proxy/ProxyModelsView.vue tools/proxy-reverse-alias-hide-selftest.cjs
git commit -m "feat(gateway): 全部渠道视图隐藏被反向映射吸收的真名"
```

---

### Task 5: 全量回归与基线

**Files:**
- Modify（按需）: `scripts/fixtures/gateway-sink-baseline.json`（仅当黄金基线因本改动变化时重录）

**Interfaces:**
- Consumes: 前四个 Task 的全部改动。
- Produces: 无新增接口；产出"回归通过"的证据。

- [ ] **Step 1: 调度核心黄金基线**

Run: `node scripts/dev-sink-golden.cjs`
Expected: PASS（模型目录 fixture 未含被测反向映射，预计无变化）。若 FAIL 且差异确由本改动引起：`node scripts/dev-sink-golden.cjs --write` 重录基线，并在提交信息中说明。

- [ ] **Step 2: 三协议回归**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/dev-anthropic-in-test.cjs`
Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/dev-responses-in-test.cjs`
Expected: 两个脚本均"全部通过"。

- [ ] **Step 3: 既有相关自测**

Run: `node tools/proxy-channels-selftest.cjs`
Run: `node tools/proxy-models-merge-selftest.cjs`
Run: `node tools/proxy-mapped-target-selftest.cjs`
Run: `node tools/proxy-model-order-selftest.cjs`
Expected: 全部通过（若某脚本因新行为需要更新断言，按新语义更新并说明）。

- [ ] **Step 4: 全链路冒烟**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs`
Expected: 通过。

- [ ] **Step 5: 提交（若基线有改动）**

```bash
git add scripts/fixtures/gateway-sink-baseline.json
git commit -m "test(gateway): 重录调度黄金基线（反向映射吸收真名）"
```
