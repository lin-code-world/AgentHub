/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-31
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · ZCode 模型能力数据层（三来源选择 + 校验 + 规则映射 + 联网自动更新与原子落盘）
//
// 为什么要有这一层：最终发布要给一台没装 ZCode 官方客户端的机器用。
// resolveModelMeta() 的规则读自本机 zcode-builtin.json，无客户端就退化成写死默认值。
// 本模块负责两件事：① 从客户端目录 / 本机落盘副本 / 仓库内置副本三来源按 revision 取最新
// 并映射成统一形状（纯函数，供 zcodeLocal.resolveModelMeta() 同步消费）；
// ② 联网按官方 revision 更新落盘副本（两跳请求、校验、原子落盘、定时调度与退避），
// 任何失败都沿用现有数据。纯函数部分离线可测，联网部分在自测里用假 fetch 覆盖，
// 都不依赖真客户端、不打真上游。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ===== mapModelRules =====

/** 把上游 modelRules 数组映射成统一 ModelRule[] 形状：
 *  输入（上游 JSON）：[{ modelMatch, config: { properties: { contextWindow?, inputFormat? }, optionSpecs: { maxOutputTokens: { max }? } } }]
 *  输出：[{ re, fmt, contextWindow, maxOutputTokens }] —— 只保留有 re 的规则，过滤无效条目。
 *  这是全仓对上游 modelRules 的唯一映射口径（zcodeLocal 已不再持有映射逻辑，一律经本模块）。
 *  不改 "contextWindow 为 0 被 Number()||undefined 吞掉" 的既有行为。 */
function mapModelRules(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const cfg = (r || {}).config || {};
      const props = cfg.properties || {};
      const opts = cfg.optionSpecs || {};
      const maxOut = (opts.maxOutputTokens || {}).max;
      return {
        re: (r && r.modelMatch) || "",
        fmt: props.inputFormat || null,
        contextWindow: Number(props.contextWindow) || undefined,
        maxOutputTokens: Number(maxOut) || undefined,
      };
    })
    .filter((r) => r.re);
}

// ===== validateRelease =====

/** 校验 release JSON 并映射为统一 ModelRule[] 形状。
 *  规则映射口径通过 mapModelRules() 复用——本模块内唯一映射源。 */
function validateRelease(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "release 不是对象" };
  }
  if (json.schemaVersion !== 1) {
    return { ok: false, reason: `schemaVersion 非 1（实际 ${json.schemaVersion}）` };
  }
  if (!Number.isInteger(json.revision) || json.revision <= 0) {
    return { ok: false, reason: `revision 非正整数（实际 ${json.revision}）` };
  }
  const list = ((json.config || {}).modelConfigRules || {}).modelRules;
  if (!Array.isArray(list)) {
    return { ok: false, reason: "modelRules 非数组" };
  }
  return {
    ok: true,
    release: { revision: json.revision, schemaVersion: 1, modelRules: mapModelRules(list) },
  };
}

// ===== pickLatestRelease =====

/** 按 revision 降序取最大；同 revision 按 stored(0) < client(1) < builtin(2) 升序取胜出者。
 *  空数组返回 null。origin 非三值之一按 builtin 兜底（来源未知时宁取权威最低者）。 */
const ORIGIN_RANK = { stored: 0, client: 1, builtin: 2 };
function pickLatestRelease(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  let best = null;
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const rev = Number(s.revision) || 0;
    const rank = ORIGIN_RANK[s.origin] !== undefined ? ORIGIN_RANK[s.origin] : 2;
    if (!best || rev > best.rev || (rev === best.rev && rank < best.rank)) {
      best = { rev, rank, origin: s.origin, revision: rev, raw: s.raw };
    }
  }
  if (!best) return null;
  return { origin: best.origin, revision: best.revision, raw: best.raw };
}

// ===== buildClientConfigsUrl =====

/** 拼 client configs 请求 URL：末尾 query 带上 app_version 与 platform。 */
function buildClientConfigsUrl(baseUrl, appVersion, platform) {
  const sep = String(baseUrl || "").includes("?") ? "&" : "?";
  return `${baseUrl}${sep}app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`;
}

// ===== resolveModelRules =====

/** 从多来源同步解析模型规则：deps = { storedFile, clientDirs: string[], builtinFile }。
 *  同步设计理由：zcodeLocal.resolveModelMeta() 是同步调用链（每次模型目录解析都会调），
 *  若此处返回 Promise，首次同步调用只能拿到空缓存，模型能力退化成默认值正是本任务要修的病。
 *  读三个来源本来就是 fs.readFileSync，异步只对远端请求有必要（Task 4 才引入联网 fetch）。
 *
 *  返回 { rules: ModelRule[], origin, revision } | null。全部来源不可用返回 null。
 *  任何一份读不出来或 JSON 损坏，只跳过该来源，不抛错。
 *
 *  缓存：key 由三个来源文件的存在性 + mtime 组成；任一变化即失效，下一次调用重新读。
 *  显式失效入口只有一个，见 invalidateModelRules()。 */
function resolveModelRules(deps) {
  const fs = require("node:fs");
  const path = require("node:path");
  const d = deps || {};
  const storedFile = d.storedFile || "";
  const builtinFile = d.builtinFile || "";
  const clientDirs = Array.isArray(d.clientDirs) ? d.clientDirs.filter(Boolean) : [];

  // 收集客户端目录下所有 zcode-builtin.json（深度 4 递归；这是全仓唯一一份该扫描逻辑）
  const clientFiles = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "zcode-builtin.json") {
        try {
          clientFiles.push(p);
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  for (const root of clientDirs) {
    if (!root) continue;
    walk(root, 0);
  }

  // 读一个来源：返回 { origin, revision, raw: ModelRule[] } 或 null（不可用）
  const readOne = (origin, file) => {
    if (!file) return null;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const v = validateRelease(json);
    if (!v.ok) return null;
    return { origin, revision: v.release.revision, raw: v.release.modelRules, _mtime: stat.mtimeMs };
  };

  // 构建缓存 key（任一来源存在性或 mtime 变化即失效）
  const cacheKeyParts = [];
  const pushStat = (label, file) => {
    if (!file) {
      cacheKeyParts.push(`${label}:missing`);
      return;
    }
    try {
      const s = fs.statSync(file);
      cacheKeyParts.push(`${label}:1:${s.mtimeMs}`);
    } catch {
      cacheKeyParts.push(`${label}:0`);
    }
  };
  pushStat("stored", storedFile);
  // clientDirs 可能多个，把每个目录的 stat 都计入
  clientDirs.forEach((root, i) => pushStat(`clientDir[${i}]`, root));
  // 客户端找到的文件（按路径排序稳定化）也计入 key——客户端可能在 runtime/provider 下留多份副本，随更新增减
  clientFiles.sort().forEach((p, i) => pushStat(`clientFile[${i}]`, p));
  pushStat("builtin", builtinFile);
  const cacheKey = cacheKeyParts.join("|");

  // 命中缓存：key 未变说明三个来源自上次读盘以来没动过，直接复用上次读盘的结论
  // （结论可能为 null——即"上次读时三来源都不可用"，此时也确实没有重新读盘的必要）。
  if (_resolveCache.hasValue && _resolveCache.key === cacheKey) {
    return _resolveCache.value;
  }

  // 读各来源
  const sources = [];
  const stored = readOne("stored", storedFile);
  if (stored) sources.push(stored);

  // 客户端可能有多份（runtime/provider 下不同版本目录），按 mtime 最新者作为 client 来源
  let latestClient = null;
  for (const p of clientFiles) {
    const r = readOne("client", p);
    if (r && (!latestClient || r._mtime > latestClient._mtime)) latestClient = r;
  }
  if (latestClient) sources.push(latestClient);

  const builtin = readOne("builtin", builtinFile);
  if (builtin) sources.push(builtin);

  const picked = pickLatestRelease(sources);
  const result = picked ? { origin: picked.origin, revision: picked.revision, rules: picked.raw } : null;

  // 记录"本次读盘的结论"（可能为 null）。key 照记，所以来源被写坏（mtime 变）后下次仍会重新读盘，
  // 不会永远吃旧 key。
  _resolveCache.key = cacheKey;
  _resolveCache.value = result;
  _resolveCache.hasValue = true;
  // 最近一次**成功**解析的规则单独保留：本次失败（result 为 null）时不覆盖，
  // 保证三来源暂时读不出来时，调用方仍能沿用已经拿到的规则（见 cachedModelRules()）。
  if (result) _lastGoodRules = result.rules;
  return result;
}

// resolveModelRules 的按来源 mtime 缓存。key/value 描述"最近一次读盘的实况"：
// value 可能为 null（那次三来源都不可用）。hasValue 区分"读过但结论是 null"与"从未读过"。
const _resolveCache = { key: "", value: null, hasValue: false };

// 最近一次成功解析出的规则（cachedModelRules() 的唯一来源）：只在解析成功时更新，
// 与本函数返回的"本次实况"解耦——后者可能为 null，前者始终是上一次的好数据。
let _lastGoodRules = [];

/** 唯一显式失效入口：清空"本次实况"缓存与"最近成功规则"，下次 resolveModelRules 重新读三个来源。
 *  Task 4 更新落盘副本成功后调用它即可让新规则生效。 */
function invalidateModelRules() {
  _resolveCache.key = "";
  _resolveCache.value = null;
  _resolveCache.hasValue = false;
  _lastGoodRules = [];
}

// ===== cachedModelRules =====

// 供同步的 resolveModelMeta() 消费：返回**最近一次成功解析**的规则；
// 从未成功过（或已显式失效）返回空数组，调用方退回保守默认值。
function cachedModelRules() {
  return _lastGoodRules;
}

// ===== 落盘副本路径与来源 deps（与 zcodeLocal._modelRulesDeps 的三来源口径一致） =====

/** 落盘副本路径：本机数据目录下的 proxy/zcode-builtin.json（resolveModelRules 的 stored 来源） */
function storedReleasePath() {
  return path.join(require("../config.cjs").dataDir(), "proxy", "zcode-builtin.json");
}

/** 三来源 deps：与 zcodeLocal._modelRulesDeps 同口径（客户端副本目录走 ZCODE_V2_DIR 沙箱钩子）。
 *  放在本模块是为了让更新器自己就能算出"全部现有来源的最大 revision"，不必反向依赖 zcodeLocal
 *  （zcodeLocal 依赖本模块，反向 require 会成环）。 */
function defaultRulesDeps() {
  const v2 = process.env.ZCODE_V2_DIR || path.join(os.homedir(), ".zcode", "v2");
  return {
    storedFile: storedReleasePath(),
    clientDirs: [path.join(v2, "runtime", "provider")],
    builtinFile: path.join(__dirname, "assets", "zcode-builtin.json"),
  };
}

// ===== 远端拉取（联网自动更新） =====

// 单跳超时 20s；正文上限 10MB（官方内置配置体实测远小于此，纯防畸形/超大响应）
const REMOTE_TIMEOUT_MS = 20000;
const REMOTE_BODY_LIMIT = 10 * 1024 * 1024;

/** URL 允许性：只放行 http(s)，且绝不允许带用户名密码——凭据会随请求行/日志外泄给第三方域 */
function isSafeRemoteUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.username || u.password) return false;
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** 总预算信号：本次更新**全程共享一个 deadline**（两跳请求与正文读取都用它），
 *  可选叠加外部中止信号（stopUpdater 能立刻掐断在途请求）。 */
function deadlineSignal(ms, outer) {
  const timeout = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([timeout, outer]) : timeout;
}

/** 读取响应正文并限体积：先看 content-length（有就早退），再流式累计（无该头也不至于被撑爆内存） */
async function readBodyLimited(resp, limit) {
  try {
    const len = Number(resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-length") : NaN);
    if (Number.isFinite(len) && len > limit) return null;
    if (resp.body && typeof resp.body.getReader === "function") {
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value && value.byteLength ? value.byteLength : 0;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            /* 取消失败无碍 */
          }
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    const text = await resp.text();
    return Buffer.byteLength(text, "utf8") > limit ? null : text;
  } catch {
    return null;
  }
}

/**
 * 官方两跳拉取：GET {clientConfigsUrl}?app_version=..&platform=.. → data.configs.builtin_provider_config_json
 * （一个 URL 字符串）→ GET 它拿最终配置 JSON。
 * `timeoutMs` 是**本次更新的总预算**（默认 20 秒），不是"每跳各自 20 秒"：入口建一次 deadline，
 * 两跳请求与两次正文读取共用它，第二跳不再继承满额预算（官方实现同样是一个 20 秒 timer
 * 覆盖内部两次请求；每跳各算最坏会拖到约 40 秒，与「总超时 20 秒」的口径不符）。
 * 一切失败（网络、超时、业务码非 0、字段缺失、畸形、超限）统一返回 null，绝不抛：
 * 更新循环靠"拿到 null 就沿用现有数据"兜底，一次抖动不能让模型能力退化。
 * 返回的是**上游原始形状**的 JSON（与 assets/zcode-builtin.json 同形状），
 * 这样落盘副本能被 resolveModelRules 的 stored 来源直接读。
 */
async function fetchRemoteRelease(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : REMOTE_TIMEOUT_MS;
  const outer = o.signal || null;
  const deadline = deadlineSignal(timeoutMs, outer);
  const init = { method: "GET", redirect: "error", credentials: "omit", signal: deadline };
  try {
    if (typeof fetchImpl !== "function") return null;
    const base = String(o.clientConfigsUrl || "");
    if (!base || !isSafeRemoteUrl(base)) return null;

    const first = await fetchImpl(buildClientConfigsUrl(base, o.appVersion, o.platform), init);
    if (!first || !first.ok) return null;
    const firstText = await readBodyLimited(first, REMOTE_BODY_LIMIT);
    if (!firstText) return null;
    let firstJson = null;
    try {
      firstJson = JSON.parse(firstText);
    } catch {
      return null;
    }
    if (!firstJson || firstJson.code !== 0) return null;
    const inner = ((firstJson.data || {}).configs || {}).builtin_provider_config_json;
    if (typeof inner !== "string" || !inner.trim() || !isSafeRemoteUrl(inner)) return null;

    const second = await fetchImpl(inner, init);
    if (!second || !second.ok) return null;
    const secondText = await readBodyLimited(second, REMOTE_BODY_LIMIT);
    if (!secondText) return null;
    let json = null;
    try {
      json = JSON.parse(secondText);
    } catch {
      return null;
    }
    return validateRelease(json).ok ? json : null;
  } catch (e) {
    // 主动中止（stopUpdater）静默；其余异常留一条诊断线索，但一律按"本次没拿到"处理
    if (!(e && e.name === "AbortError")) console.warn("[zcode] 远端模型配置拉取失败，沿用现有数据：" + ((e && e.message) || e));
    return null;
  }
}

/**
 * 采纳远端 release 落盘：**仅当 release.revision 大于全部现有来源（落盘副本 / 客户端副本 / 内置副本）
 * 的最大 revision** 时写入，返回是否写入。
 * 为什么比"全部来源"而不是只比落盘副本：外部来源已经更新、而远端落后时写入会把整体能力写退
 * （stored 一份较旧数据仍可能因其它来源不可用而胜出）——这是本方案要防的第一号风险。
 * 落盘口径复用 zcodeLocal.atomicWriteJson（临时文件 + rename），避免半截文件被下次解析读到。
 */
function writeStoredRelease(file, release, otherRevisions) {
  try {
    const rev = Number((release || {}).revision);
    if (!file || !Number.isInteger(rev) || rev <= 0) return false;
    const others = Array.isArray(otherRevisions) ? otherRevisions : [];
    let maxOther = 0;
    for (const r of others) {
      const n = Number(r);
      if (Number.isFinite(n) && n > maxOther) maxOther = n;
    }
    if (rev <= maxOther) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 延迟 require：zcodeLocal 依赖本模块，顶部 require 会成环取到未完成的导出
    require("./zcodeLocal.cjs").atomicWriteJson(file, release);
    return true;
  } catch (e) {
    console.warn("[zcode] 模型配置落盘失败，沿用现有数据：" + ((e && e.message) || e));
    return false;
  }
}

// ===== 定时更新 =====

// 首拉延迟 10s：启动阶段不与网关初始化/库迁移抢 IO，也不至于让新机器等太久
// 成功间隔 1h：官方 revision 变更不频繁，一小时一次足够及时
// 失败退避 15min 起、每次翻倍、上限 6h：上游异常时降低打点频率，又不至于长时间不重试
const UPDATER_FIRST_DELAY_MS = 10 * 1000;
const UPDATER_SUCCESS_MS = 60 * 60 * 1000;
const UPDATER_FAIL_BASE_MS = 15 * 60 * 1000;
const UPDATER_FAIL_MAX_MS = 6 * 60 * 60 * 1000;

// 当前更新器状态（单例）。null = 未启动/已停止。
let _updater = null;

/** 退避时长：首次失败取基值，之后每次翻倍、封顶上限 */
function nextFailDelay(st) {
  st.failMs = st.failMs ? Math.min(st.failMs * 2, st.failMaxMs) : st.failBaseMs;
  return st.failMs;
}

/** 用 setTimeout 链调度（而非固定 setInterval）：间隔要随成败动态变化。
 *  定时器 unref：退出流程 await shutdown 时不必等下一次拉取。 */
function scheduleUpdater(st, ms) {
  if (st.stopped || _updater !== st) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    void updaterTick(st);
  }, ms);
  if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
}

/** 单轮：拉取 → 比 revision → 落盘 → 失效缓存。成败只影响下一轮间隔，绝不外抛。 */
async function updaterTick(st) {
  if (st.stopped || _updater !== st) return;
  let nextMs = st.successMs;
  try {
    const cfg = st.opts.getConfig() || {};
    const url = String(cfg.clientConfigsUrl || "");
    if (!url) {
      // 还没配（或配置被临时清空）：按失败退避等下一轮，配置热加载后自然拿到
      nextMs = nextFailDelay(st);
      return;
    }
    const controller = new AbortController();
    st.controller = controller;
    const release = await fetchRemoteRelease({
      clientConfigsUrl: url,
      appVersion: cfg.appVersion,
      platform: cfg.platform,
      fetchImpl: st.opts.fetchImpl,
      signal: controller.signal,
    });
    if (st.controller === controller) st.controller = null;
    if (st.stopped || _updater !== st) return;
    if (!release) {
      nextMs = nextFailDelay(st);
      return;
    }
    st.failMs = 0;
    const deps = st.opts.deps || defaultRulesDeps();
    // 现有来源最大 revision：resolveModelRules 的结论本身就是三来源取最大（pickLatestRelease 语义），
    // 直接复用它，不另写一遍比较逻辑
    const current = resolveModelRules(deps);
    const others = current && Number.isFinite(Number(current.revision)) ? [Number(current.revision)] : [];
    if (writeStoredRelease(deps.storedFile, release, others)) {
      invalidateModelRules(); // 唯一显式失效入口：下次解析重读落盘副本
      console.log(`[zcode] 模型能力数据已更新到 revision ${release.revision}`);
    }
    nextMs = st.successMs;
  } catch (e) {
    nextMs = nextFailDelay(st);
    console.warn("[zcode] 模型配置更新轮次异常，沿用现有数据：" + ((e && e.message) || e));
  } finally {
    scheduleUpdater(st, nextMs);
  }
}

/** 启动联网更新（幂等：重复调用先停旧的）。getConfig 返回 zcode 渠道配置段
 *  （含 clientConfigsUrl / appVersion / platform，直接读 rules.get("headers.json").zcode）；
 *  fetchImpl / deps / 各类间隔仅作自测注入用，生产走默认值。 */
function startUpdater(opts) {
  stopUpdater();
  const o = opts || {};
  if (typeof o.getConfig !== "function") return;
  const st = {
    opts: o,
    stopped: false,
    timer: null,
    controller: null,
    failMs: 0,
    firstDelayMs: Number(o.initialDelayMs) > 0 ? Number(o.initialDelayMs) : UPDATER_FIRST_DELAY_MS,
    successMs: Number(o.successMs) > 0 ? Number(o.successMs) : UPDATER_SUCCESS_MS,
    failBaseMs: Number(o.failBaseMs) > 0 ? Number(o.failBaseMs) : UPDATER_FAIL_BASE_MS,
    failMaxMs: Number(o.failMaxMs) > 0 ? Number(o.failMaxMs) : UPDATER_FAIL_MAX_MS,
  };
  _updater = st;
  scheduleUpdater(st, st.firstDelayMs);
}

/** 停掉定时器与在途请求（幂等）。停掉后不再有任何拉取动作，定时器不残留。 */
function stopUpdater() {
  const st = _updater;
  if (!st) return;
  st.stopped = true;
  _updater = null;
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  if (st.controller) {
    try {
      st.controller.abort();
    } catch {
      /* 请求可能刚结束 */
    }
    st.controller = null;
  }
}

module.exports = {
  mapModelRules,
  validateRelease,
  pickLatestRelease,
  buildClientConfigsUrl,
  resolveModelRules,
  cachedModelRules,
  invalidateModelRules,
  fetchRemoteRelease,
  writeStoredRelease,
  startUpdater,
  stopUpdater,
};
