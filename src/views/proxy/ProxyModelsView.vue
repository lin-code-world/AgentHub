<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 反代网关 · 模型目录：渠道 tab（全部/各渠道）+ 官方目录拉取 + 启停开关 / 渠道覆盖 / 倍率与能力 / 反向模型映射
     管理态存框架整体配置（disabledModels / modelOverrides / modelReverseAliases），保存即热生效（服务端每请求读盘） -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ModelCustomEntry, ProxyChannelId, ProxyChannelView, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";
import { capabilityNames, capabilityTags, channelName, fmtCtx, fmtInt, fmtRate, parseCtxInput } from "./format";
import { hiddenByRate } from "./rateGate";
import { mergeAliasRows, sourceRows, channelCustomOf } from "./channelRows";

const app = useAppStore();
const models = ref<ProxyModel[]>([]);
const err = ref("");
/** err 当前这条是不是 refresh 自己写下的加载错误：只有它能被 refresh 自动回收，
 *  拉取/保存等业务错误一律保留到用户点关闭（否则刚显示就被 finally 里的 refresh 清掉） */
let errFromRefresh = false;
const msg = ref("");
const syncing = ref("");
const filter = ref("");
const statusFilter = ref<"all" | "on" | "off">("all"); // 状态筛选：全部 / 已开启 / 已关闭
const activeTab = ref(""); // "" = 全部
const mainTab = ref<"catalog" | "reverse">("catalog");
const ruleDialogOpen = ref(false);

// 渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<ProxyChannelView[]>([]);
const CHANNEL_OPTIONS = computed<{ value: "" | ProxyChannelId; label: string }[]>(() => [
  { value: "", label: "自动（打分）" },
  ...channels.value.map((c) => ({ value: c.id as ProxyChannelId, label: c.display })),
]);

// 渠道 tab 只显示有模型的渠道：复用下方 modelsByChannel 预分组（O(渠道) 查直值，不再 O(渠道×模型) 逐对扫描）
const tabChannels = computed(() => channels.value.filter((c) => (modelsByChannel.value[c.id] || []).length > 0));

/** 各渠道是否提供倍率（随模型列表首条返回）：决定「无倍率模型」是否隐藏 */
const channelRateFlags = computed<Partial<Record<ProxyChannelId, boolean>>>(() => models.value[0]?.channelRateFlags || {});

/** 各渠道目录里的原始模型 id（随首条返回）：渠道 tab 下要显示该渠道自己的写法 */
const channelModelIds = computed<Partial<Record<ProxyChannelId, string[]>>>(() => models.value[0]?.channelModelIds || {});

/**
 * 当前渠道 tab 下该模型「在该渠道目录里的真实写法」（大小写敏感）。
 * 为什么需要：合并视图用一个统一 id 展示共享模型，取的是首个渠道的写法（WorkBuddy 早于 Loomy 注册，
 * 所以 DeepSeek 显示小写）。但上游是按自己目录里的写法认模型的（Loomy 是 DeepSeek-V4.1-Flash），
 * 在讯飞渠道页显示小写会让人照着发出一个讯飞根本不存在的名字 -> 路由到别的渠道。
 * 无 tab（全部视图）或该渠道没有这个模型时回落合并 id。
 */
function displayId(m: ProxyModel): string {
  const tab = activeTab.value;
  if (!tab) return m.id;
  const ids = channelModelIds.value[tab as ProxyChannelId] || [];
  const lower = m.id.toLowerCase();
  return ids.find((x) => x.toLowerCase() === lower) || m.id;
}

/** 来源渠道明细的单项：该渠道自己的 id / 名字 / 倍率 / 上下文 / 最大输出 / 能力 */
type SourceDetail = NonNullable<ProxyModel["sourceDetails"]>[number];
/** 来源渠道行的最小形状（sourceRows 的兜底项也满足） */
type SourceDetailLike = {
  channel: string;
  id: string;
  name?: string;
  rate: number | null;
  contextLength: number;
  maxOutputTokens: number;
  capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean };
  reasoning_effort?: string[];
  custom?: ModelCustomEntry | null;
};

/** 渠道视图下取该渠道自己的目录元数据；全部视图（或该渠道没有目录明细）返回 null */
function channelMetaOf(m: ProxyModel): SourceDetail | null {
  const tab = activeTab.value;
  if (!tab) return null;
  return (m.sourceDetails || []).find((d) => d.channel === tab) || null;
}

/** 上下文 / 能力 / 倍率的取数来源：渠道视图用该渠道自己的元数据，全部视图用行级合并值 */
const metaOf = (m: ProxyModel): SourceDetail | ProxyModel => channelMetaOf(m) || m;

/**
 * 显示名：渠道视图只认该渠道自己的目录名，全部视图用合并值。
 *
 * 为什么不能直接用行级 name：同名的模型可能被多个渠道提供，合并时只留了其中一个渠道给的名字
 * （例如 MonkeyCode 与 WorkBuddy 都有 minimax-m2.5，名字来自 WorkBuddy）。渠道页里显示它，
 * 就等于把这个渠道根本没有的名字安在了它头上——上游没给名就该是空的。
 */
function displayName(m: ProxyModel): string {
  const tab = activeTab.value;
  if (!tab) return String(m.name || "");
  const own = channelMetaOf(m)?.name;
  return own ? String(own) : "";
}

/** 渠道视图下的倍率：只显示该渠道自己的值（全部视图在「来源渠道」列里逐个渠道显示） */
const activeTabRate = (m: ProxyModel): number | null => channelMetaOf(m)?.rate ?? null;

// 三重筛选的交集：渠道 tab → 启停状态 → 关键词（id 与显示名模糊匹配）。
// 这个列表既是表格数据源，也是「一键开启/关闭/反选」的作用范围——所见即所改
// 渠道页合并：反向映射注入的别名行并入该渠道的原生行（全部视图不合并，规则在 channelRows.ts）
const mergedView = computed(() =>
  mergeAliasRows(models.value, activeTab.value, app.config.proxy.modelReverseAliases || {})
);
const aliasOf = computed(() => mergedView.value.aliasOf);
/** 合并行对应的别名请求名（无则空串） */
const aliasText = (m: ProxyModel) => aliasOf.value[m.id] || "";

const rows = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  return models.value.filter((m) => {
    // 无倍率的模型按**来源渠道**逐个判断：该渠道有价而此模型没价就隐藏；
    // 整个渠道都不标价的（Trae / ZCode / 魔搭 / Cline / 小浣熊）保留，否则会被整渠道清空
    if (hiddenByRate(m.sourceDetails || [], activeTab.value, channelRateFlags.value)) return false;
    if (activeTab.value && !m.sources.includes(activeTab.value as ProxyChannelId)) return false;
    // 已被合并进原生行的别名行不再单独占一行
    if (!mergedView.value.visibleIds.includes(m.id)) return false;
    if (statusFilter.value === "on" && !m.enabled) return false;
    if (statusFilter.value === "off" && m.enabled) return false;
    if (!kw) return true;
    // 搜索也要匹配「当前渠道的原始写法」与合并进来的别名：在讯飞页搜 DeepSeek-V4.1-Flash 不能搜不到
    return (
      m.id.toLowerCase().includes(kw) ||
      displayId(m).toLowerCase().includes(kw) ||
      // 搜索口径与显示口径一致：渠道页只搜该渠道自己的名字，别用合并来的名字把不相干的搜出来
      displayName(m).toLowerCase().includes(kw) ||
      aliasText(m).toLowerCase().includes(kw)
    );
  });
});

/** 当前筛选范围的人类可读描述：批量操作前让用户确认「打的是哪一片」 */
const scopeText = computed(() => {
  const parts = [activeTab.value ? channelName(activeTab.value) : "全部渠道"];
  if (statusFilter.value !== "all") parts.push(statusFilter.value === "on" ? "仅已开启" : "仅已关闭");
  const kw = filter.value.trim();
  if (kw) parts.push(`关键词「${kw}」`);
  return parts.join(" · ");
});

function resetFilters() {
  filter.value = "";
  statusFilter.value = "all";
}

// ===== 思考强度选项 =====
const REASONING_EFFORT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "off", label: "关闭思考 (off)" },
  { value: "minimal", label: "极低 (minimal)" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中等 (medium)" },
  { value: "high", label: "高 (high)" },
  { value: "xhigh", label: "极高 (xhigh)" },
  { value: "max", label: "最大 (max)" },
];
const REASONING_LABELS: Record<string, string> = {
  light: "轻 (light)",
  high: "标准 (high)",
  extra_high: "最高 (extra_high)",
  off: "关闭思考 (off)",
  minimal: "极低 (minimal)",
  low: "低 (low)",
  medium: "中等 (medium)",
  xhigh: "极高 (xhigh)",
  max: "最大 (max)",
};

/** 有目录档位时只显示支持的档位；完全没有目录数据时回落到通用选项（其它渠道） */
function reasoningOptionsOf(m: ProxyModel, d?: SourceDetailLike): { value: string; label: string }[] {
  const values = d && Array.isArray(d.reasoning_effort) ? d.reasoning_effort : Array.isArray(m.reasoning_effort) ? m.reasoning_effort : null;
  if (values === null) return REASONING_EFFORT_OPTIONS;
  return [{ value: "", label: "默认" }, ...values.map((v) => ({ value: v, label: REASONING_LABELS[v] || v }))];
}

// ===== 模型自定义参数更新 =====
// ===== 上下文长度输入：显示 K/M 缩写，编辑时展开为数字 =====
// ctxDraft 存「正在编辑的原始文本」：有 key 时输入框显示草稿，无 key 时显示 ctxDisplay 的缩写值。
// 不在草稿态做任何格式化，用户输入的每个字符都原样保留，光标不会跳。
const ctxDraft = ref<Record<string, string>>({});

/** 渠道页的编辑目标：该渠道视角的实际模型（无目录明细时回落条目 id）。
 *  合并行（原生 id）与全部视图里别名条目的该渠道行落到同一个键，天然同步。 */
function editDetail(m: ProxyModel): SourceDetailLike {
  const meta = channelMetaOf(m);
  if (meta) return meta;
  return { channel: activeTab.value, id: m.id, rate: null, contextLength: 0, maxOutputTokens: 0, capabilities: {} };
}

/** 该模型当前生效的上下文长度（渠道覆盖优先，其次旧模型级，最后该渠道目录值） */
function ctxValue(m: ProxyModel): number {
  return ctxOfChannel(m, editDetail(m));
}

/** 非编辑态显示值：K/M 缩写 */
function ctxDisplay(m: ProxyModel): string {
  return fmtCtx(ctxValue(m));
}

/** 悬停提示：编辑说明 + 当前精确值（缩写有精度损失，精确数字放这里） */
function ctxTip(m: ProxyModel): string {
  const v = ctxValue(m);
  return v ? `自定义上下文长度（Token）：${fmtInt(v)}，可直接写 128K / 1M，留空恢复默认` : "自定义上下文长度（Token），留空则恢复默认";
}

/** 提交编辑：解析 "128K"/"1M" 为数字落库；草稿清掉后回到缩写显示 */
async function commitCtx(m: ProxyModel) {
  const raw = ctxDraft.value[m.id];
  if (raw === undefined) return;
  delete ctxDraft.value[m.id];
  const parsed = parseCtxInput(raw);
  // 与「当前生效值」比较而不是与自定义值比较：只聚焦再失焦时草稿就是原始数字，
  // 若拿自定义值(0)比就会把目录自带值误写成一条自定义覆盖（凭空多出「自」标记）
  if ((parsed || 0) === ctxValue(m)) return;
  await updateChannelCustom(editDetail(m), { contextLength: parsed });
}

// ===== 按渠道自定义参数（全部视图拆行 / 渠道页编辑共用） =====
/** 该来源渠道的覆盖值：本地配置优先，后端富化值兜底（无 catalog 明细的渠道也能改、也能清） */
const channelCustom = (d: SourceDetailLike): ModelCustomEntry => channelCustomOf(app.config.proxy.modelCustomByChannel || {}, d);
/** 按渠道覆盖值 → 旧模型级值 → 该渠道目录值 */
const ctxOfChannel = (m: ProxyModel, d: SourceDetailLike): number =>
  Number(channelCustom(d).contextLength) || Number((app.config.proxy.modelCustom || {})[m.id]?.contextLength) || Number(d.contextLength) || 0;
const effortOfChannel = (m: ProxyModel, d: SourceDetailLike): string =>
  String(channelCustom(d).reasoningEffort || (app.config.proxy.modelCustom || {})[m.id]?.reasoningEffort || "");
const ctxDraftKey = (m: ProxyModel, d: SourceDetailLike) => `${m.id}::${d.channel}`;

/** 写「实际模型 + 渠道」一条配置；同一渠道同一实际模型的两种请求名因此共享同一份数据 */
async function updateChannelCustom(d: SourceDetailLike, patch: Partial<ModelCustomEntry>) {
  const all = { ...(app.config.proxy.modelCustomByChannel || {}) };
  const perModel = { ...(all[d.id] || {}) };
  const cur = { ...(perModel[d.channel] || {}), ...patch };
  if (!cur.contextLength || cur.contextLength <= 0) delete cur.contextLength;
  if (!cur.maxOutputTokens || cur.maxOutputTokens <= 0) delete cur.maxOutputTokens;
  if (!cur.reasoningEffort) delete cur.reasoningEffort;
  if (Object.keys(cur).length) perModel[d.channel] = cur;
  else delete perModel[d.channel];
  if (Object.keys(perModel).length) all[d.id] = perModel;
  else delete all[d.id];
  app.config.proxy.modelCustomByChannel = all;
  await persist(`模型 ${d.id}（${channelName(d.channel)}）参数已生效`);
  await refresh();
}

/** 全部视图：该模型的来源渠道行（缺明细的渠道也占一行） */
const rowsOf = (m: ProxyModel) => sourceRows(m);
/** 能力子列只显示 图 / 思 / 工（上下文已有独立子列，避免重复） */
function channelCapTags(d: SourceDetailLike): string[] {
  const c = d.capabilities || {};
  return [c.images ? "图" : "", c.reasoning ? "思" : "", c.tools ? "工" : ""].filter(Boolean);
}
/** 提交某个来源渠道行的上下文编辑 */
async function commitChannelCtx(m: ProxyModel, d: SourceDetailLike) {
  const key = ctxDraftKey(m, d);
  const raw = ctxDraft.value[key];
  if (raw === undefined) return;
  delete ctxDraft.value[key];
  const parsed = parseCtxInput(raw);
  if ((parsed || 0) === ctxOfChannel(m, d)) return;
  await updateChannelCustom(d, { contextLength: parsed });
}

// ===== 反向模型映射管理（统一请求名 -> 各渠道实际模型） =====
const reverseName = ref("");
const reverseTargets = ref<Record<string, string>>({});
const reverseAliases = computed<[string, Record<string, string>][]>(() =>
  Object.entries(app.config.proxy.modelReverseAliases || {})
);

/** 渠道 → 模型列表的预分组：供目录 tab 展示融合后的渠道来源。 */
const modelsByChannel = computed<Record<string, ProxyModel[]>>(() => {
  const map: Record<string, ProxyModel[]> = {};
  for (const c of channels.value) map[c.id] = [];
  for (const m of models.value) {
    for (const src of m.sources) {
      if (map[src]) map[src].push(m);
    }
  }
  return map;
});
/** 反向映射目标必须来自适配器原始目录。融合目录会把统一名也注入 sources，不能作为目标候选。 */
const reverseTargetsByChannel = computed<Record<string, string[]>>(() => models.value[0]?.channelModelIds || {});
function channelTargetModels(chId: string) {
  return reverseTargetsByChannel.value[chId] || [];
}

async function addReverseAlias() {
  const name = reverseName.value.trim();
  if (!name) return;
  const targetMap: Record<string, string> = {};
  for (const [ch, target] of Object.entries(reverseTargets.value)) {
    if (target && target.trim()) targetMap[ch] = target.trim();
  }
  if (!Object.keys(targetMap).length) {
    err.value = "至少为一个渠道选择目标模型";
    return;
  }
  const selfMapped = Object.entries(targetMap).filter(([ch, target]) => {
    if (target.toLowerCase() !== name.toLowerCase()) return false;
    // 候选来自渠道原始目录：同名且是原生模型 = 合法恒等映射，只有非原生同名才是脏配置
    return !channelTargetModels(ch).some((m) => m.toLowerCase() === target.toLowerCase());
  });
  if (selfMapped.length) {
    err.value = `以下渠道的实际模型不是该渠道原生模型，不能与统一请求名相同：${selfMapped.map(([ch]) => channelName(ch)).join("、")}`;
    return;
  }
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  rev[name] = targetMap;
  app.config.proxy.modelReverseAliases = rev;
  reverseName.value = "";
  reverseTargets.value = {};
  await persist(`反向映射 ${name} 已生效`);
  await refresh();
}

async function removeReverseAlias(name: string) {
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  delete rev[name];
  app.config.proxy.modelReverseAliases = rev;
  await persist(`已移除反向映射 ${name}`);
  await refresh();
}

function editReverseAlias(name: string, targetMap: Record<string, string>) {
  reverseName.value = name;
  reverseTargets.value = { ...targetMap };
}

async function refresh() {
  try {
    models.value = await api.proxyModels();
    channels.value = await api.proxyPool().catch(() => channels.value);
    // 渠道启闭：当前页签指向被关闭的渠道时回落「全部」（上游启闭后模型页立即跟随）
    if (activeTab.value && !channels.value.some((c) => c.id === activeTab.value)) activeTab.value = "";
    // 只回收本函数自己写下的加载错误：业务错误（拉取/保存）保留给用户手动关闭
    if (errFromRefresh) { err.value = ""; errFromRefresh = false; }
  } catch (e) {
    err.value = String((e as Error).message || e);
    errFromRefresh = true;
  }
}

/** 管理态写回整体配置（save 即热生效；保存后重拉对齐服务端口径） */
async function persist(successMsg: string) {
  const r = await app.save();
  if (r && r.ok === false) {
    err.value = r.message || "保存失败";
    return;
  }
  msg.value = successMsg;
  setTimeout(() => (msg.value = ""), 2000);
}

/** 启停开关：默认开；关闭即写入 disabledModels 落盘（软件记录，重启保持）。
 *  无账号来源的模型由服务端强制关闭，开关置灰，点击不生效 */
async function toggleEnabled(m: ProxyModel, v: string | number | boolean) {
  if (m.accountless) return;
  const on = !!v;
  const list = new Set(app.config.proxy.disabledModels || []);
  if (on) list.delete(m.id);
  else list.add(m.id);
  app.config.proxy.disabledModels = [...list];
  await persist(on ? `已启用 ${m.id}` : `已禁用 ${m.id}`);
  await refresh();
}

// ===== 批量启停：作用范围恒为「当前筛选出的可见模型」，不是整个目录 =====
// 与单条开关同一份数据（disabledModels）与同一种比较口径（精确 id），
// 因此批量结果与逐条点击完全等价，服务端每请求读盘热生效。
const bulkBusy = ref(false);
/** 待确认的批量操作：关闭/反选可能让模型大面积不可用（一键关闭「全部」会把整个网关打哑），先确认再落盘 */
const bulkConfirm = ref<{ mode: "off" | "invert"; title: string; desc: string } | null>(null);

/** 打开批量操作入口：开启是安全动作直接执行，关闭与反选先弹确认 */
function requestBulk(mode: "on" | "off" | "invert") {
  // 无账号模型由服务端强制关闭，批量操作跳过它们（否则「开启」点了也不会生效）
  const ids = rows.value.filter((m) => !m.accountless).map((m) => m.id);
  if (!ids.length || bulkBusy.value) return;
  if (mode === "on") {
    void applyBulk("on");
    return;
  }
  const verb = mode === "off" ? "关闭" : "反选";
  bulkConfirm.value = {
    mode,
    title: `${verb} ${ids.length} 个模型`,
    desc: `作用范围：${scopeText.value}。其余模型不受影响，误操作可用「一键开启」恢复。`,
  };
}

async function confirmBulk() {
  const c = bulkConfirm.value;
  bulkConfirm.value = null;
  if (c) await applyBulk(c.mode);
}

async function applyBulk(mode: "on" | "off" | "invert") {
  const ids = rows.value.filter((m) => !m.accountless).map((m) => m.id);
  if (!ids.length || bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    const list = new Set(app.config.proxy.disabledModels || []);
    for (const id of ids) {
      if (mode === "on") list.delete(id);
      else if (mode === "off") list.add(id);
      else if (list.has(id)) list.delete(id);
      else list.add(id);
    }
    app.config.proxy.disabledModels = [...list];
    const verb = mode === "on" ? "启用" : mode === "off" ? "关闭" : "反选";
    await persist(`已${verb} ${ids.length} 个模型`);
    await refresh();
  } finally {
    bulkBusy.value = false;
  }
}

async function setOverride(m: ProxyModel, v: string) {
  const ov = { ...(app.config.proxy.modelOverrides || {}) };
  if (v) ov[m.id] = v as ProxyChannelId;
  else delete ov[m.id];
  app.config.proxy.modelOverrides = ov;
  await persist(v ? `${m.id} → 固定走 ${channelName(v)}` : `${m.id} 恢复自动路由`);
  await refresh();
}

/** 拉取官方模型目录（云端接口，用号池账号 token，不依赖本地软件）：写回 rules/catalog.json 热生效 */
async function syncCatalog(channel: string) {
  if (syncing.value) return;
  syncing.value = channel;
  err.value = "";
  errFromRefresh = false;
  try {
    const r = await api.proxyModelsSync(channel);
    if (r && r.ok === false) {
      err.value = r.message || "拉取失败";
      errFromRefresh = false;
    } else {
      const rateInfo = r.withRate ? `，其中 ${r.withRate} 个含倍率` : "";
      msg.value = `已拉取 ${r.count ?? 0} 个模型到 ${channelName(channel)}目录${rateInfo}`;
      setTimeout(() => (msg.value = ""), 3000);
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
    errFromRefresh = false;
  } finally {
    syncing.value = "";
    await refresh();
  }
}

/** 全部渠道并发拉取：只拉「有可用账号」或「目录免登录」的渠道，逐渠道汇总结果，部分失败不拖垮整体 */
async function syncAll() {
  if (syncing.value) return;
  syncing.value = "__all__";
  err.value = "";
  errFromRefresh = false;
  try {
    // 号池里没有可用账号、且目录接口需要登录态的渠道直接跳过：这类渠道拉取必然返回
    // 「无可用账号」，属于没配置而非失败，不该堆成一片红字（单渠道「拉取」仍会如实报错）
    const targets = channels.value.filter((c) => c.modelsNeedAuth === false || c.accounts.some((a) => a.status === "online" && a.hasToken));
    const skipped = channels.value.length - targets.length;
    const results = await Promise.all(targets.map((c) => api.proxyModelsSync(c.id).catch((e) => ({ ok: false as const, message: String((e as Error).message || e) }))));
    const okParts: string[] = [];
    const failParts: string[] = [];
    results.forEach((r, i) => {
      const name = channelName(targets[i].id);
      if (r && r.ok !== false) okParts.push(`${name} ${r.count ?? 0} 个`);
      else failParts.push(`${name}：${(r && r.message) || "失败"}`);
    });
    if (okParts.length) {
      const skipInfo = skipped ? `，已跳过 ${skipped} 个未登录渠道` : "";
      msg.value = `已拉取 ${okParts.join("、")}${skipInfo}`;
      setTimeout(() => (msg.value = ""), 3000);
    } else if (!failParts.length) {
      // 一个能拉的都没有（全部渠道未登录且目录需登录）：给一句说明，避免点了没反应
      msg.value = `没有可拉取的渠道：${skipped} 个渠道都需要先登录账号，请到「号池」导入`;
      setTimeout(() => (msg.value = ""), 4000);
    }
    if (failParts.length) {
      err.value = failParts.join("；");
      errFromRefresh = false;
    }
  } finally {
    syncing.value = "";
    await refresh();
  }
}

onMounted(refresh);

/** 本页是否处于前台：v-show 保活的页面切走后不会重新挂载（App.vue 的 visited 懒挂载），
 *  渠道启闭（侧栏「上游启闭」弹窗等）发生在其他入口时，本页收不到事件。
 *  切回本页（顶部 tab 切到「模型目录」）时补一次全量刷新，渠道显隐即时跟随。 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "models");
watch(active, (on) => {
  if (on) refresh();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">{{ err }}</div>
        <button class="err-close" title="关闭" @click="err = ''"><i class="ph ph-x"></i></button>
      </div>

      <!-- 顶部两大 Tab：合并模型目录 / 全渠道反向模型映射 + 路由说明按钮 -->
      <div class="models-main-tabs">
        <button class="main-tab-btn" :class="{ active: mainTab === 'catalog' }" @click="mainTab = 'catalog'">
          {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
        </button>
        <button class="main-tab-btn" :class="{ active: mainTab === 'reverse' }" @click="mainTab = 'reverse'">
          全渠道反向模型映射
        </button>
        <div style="flex: 1"></div>
        <button class="btn btn-ghost" @click="ruleDialogOpen = true">
          <i class="ph ph-info"></i>路由与切换规则
        </button>
      </div>

      <!-- Tab 1: 模型目录 -->
      <template v-if="mainTab === 'catalog'">
        <!-- 页头工具条：渠道独占一行，状态筛选与搜索/拉取在下一行 -->
        <div class="models-head">
          <div class="models-head-row models-head-channels">
            <div class="seg-group">
              <span class="seg-label">渠道</span>
              <div class="seg">
                <button class="seg-item" :class="{ active: !activeTab }" @click="activeTab = ''">全部</button>
                <button
                  v-for="c in tabChannels"
                  :key="c.id"
                  class="seg-item"
                  :class="{ active: activeTab === c.id }"
                  @click="activeTab = c.id"
                >
                  {{ c.display }}
                </button>
              </div>
            </div>
          </div>
          <div class="models-head-row models-head-filters">
            <div class="seg-group">
              <span class="seg-label">状态</span>
              <div class="seg">
                <button class="seg-item" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
                <button class="seg-item" :class="{ active: statusFilter === 'on' }" @click="statusFilter = 'on'">开启</button>
                <button class="seg-item" :class="{ active: statusFilter === 'off' }" @click="statusFilter = 'off'">关闭</button>
              </div>
            </div>
            <span class="head-tools">
              <label class="search-box">
                <i class="ph ph-magnifying-glass"></i>
                <input v-model="filter" class="search-input" placeholder="搜索模型 ID / 名称" spellcheck="false" />
                <el-tooltip v-if="filter" content="清空搜索" placement="top">
                  <button class="search-clear" @click.prevent="filter = ''"><i class="ph ph-x"></i></button>
                </el-tooltip>
              </label>
              <button v-if="activeTab" class="btn btn-cta" :disabled="!!syncing" @click="syncCatalog(activeTab)">
                <i class="ph ph-cloud-arrow-down"></i>{{ syncing === activeTab ? "拉取中…" : "拉取模型" }}
              </button>
              <button v-else class="btn btn-cta" :disabled="!!syncing" @click="syncAll">
                <i class="ph ph-cloud-arrow-down"></i>{{ syncing === "__all__" ? "拉取中…" : "全部拉取" }}
              </button>
            </span>
          </div>
          <Transition name="headmsg">
            <span v-if="msg" class="head-msg tag tag-ok">{{ msg }}</span>
          </Transition>
        </div>

        <div class="card" style="margin-top: 10px">
          <div class="card-title">
            {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
            <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
            <!-- 批量启停：作用范围 = 上表当前筛选结果（渠道 / 状态 / 关键词三重筛选的交集） -->
            <div class="bulk-bar">
              <el-tooltip content="启用当前筛选出的全部模型" placement="top">
                <button class="btn btn-sm" :disabled="bulkBusy || !rows.length" @click="requestBulk('on')">
                  <i class="ph ph-check-circle"></i>一键开启
                </button>
              </el-tooltip>
              <el-tooltip content="关闭当前筛选出的全部模型" placement="top">
                <button class="btn btn-sm" :disabled="bulkBusy || !rows.length" @click="requestBulk('off')">
                  <i class="ph ph-x-circle"></i>一键关闭
                </button>
              </el-tooltip>
              <el-tooltip content="当前筛选出的模型：开启的关闭、关闭的开启" placement="top">
                <button class="btn btn-sm" :disabled="bulkBusy || !rows.length" @click="requestBulk('invert')">
                  <i class="ph ph-arrows-left-right"></i>一键反选
                </button>
              </el-tooltip>
            </div>
          </div>
          <!-- 渠道视图 6 列合计约 832px、全部视图 9 列约 1168px：窄窗口横向滚动走全局 .table-scroll 的 overflow:auto，宽窗口一屏放下 -->
          <div class="table-scroll">
            <table class="table table-bare models-table" style="table-layout: fixed; width: 100%">
              <colgroup v-if="!activeTab">
                <!-- 全部视图：模型 / 来源渠道六子列（渠道·实际模型·上下文·思考强度·能力·倍率）/ 覆盖 / 状态 -->
                <col style="width: 240px" />
                <col style="width: 100px" />
                <col style="width: 200px" />
                <col style="width: 108px" />
                <col style="width: 136px" />
                <col style="width: 92px" />
                <col style="width: 64px" />
                <col style="width: 156px" />
                <col style="width: 72px" />
              </colgroup>
              <colgroup v-else>
                <!-- 模型列：240px 容得下 deepseek-v4.1-flash 这类长 id，倍率灰字跟在 id 右侧 -->
                <col style="width: 240px" />
                <!-- 上下文列：输入框 62px + 自badge 21px + 左右 padding 24px = 107px 起步（显示 131K / 1M 缩写） -->
                <col style="width: 108px" />
                <!-- 思考强度列：select 90px + 自badge 21px + 左右 padding 24px = 135px 起步 -->
                <col style="width: 136px" />
                <col style="width: 120px" />
                <!-- 渠道覆盖列：select 固定 100px + 单元格左右 padding 各 12px = 124px 起步 -->
                <col style="width: 156px" />
                <!-- 状态列：开关固定 40px + 单元格左右 padding 各 12px = 64px 起步。
                     48px 的内容区只有 24px，开关必然溢出被裁（4K@200% 报障的直接原因） -->
                <col style="width: 72px" />
              </colgroup>
              <thead v-if="!activeTab">
                <tr>
                  <th rowspan="2">模型</th>
                  <th colspan="6">来源渠道</th>
                  <th rowspan="2">渠道覆盖</th>
                  <th rowspan="2" style="text-align: center">状态</th>
                </tr>
                <tr>
                  <th>渠道</th>
                  <th>实际模型</th>
                  <th>上下文</th>
                  <th>思考强度</th>
                  <th>能力</th>
                  <th style="text-align: center">倍率</th>
                </tr>
              </thead>
              <thead v-else>
                <tr>
                  <th>模型</th>
                  <th>上下文</th>
                  <th>思考强度</th>
                  <th>能力</th>
                  <th>渠道覆盖</th>
                  <th style="text-align: center">状态</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="!activeTab">
                  <template v-for="(m, i) in rows" :key="m.id">
                    <tr v-for="(d, di) in rowsOf(m)" :key="m.id + '|' + d.channel" :style="{ '--i': i }">
                      <td v-if="di === 0" :rowspan="rowsOf(m).length" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                        <div class="model-id-line">
                          <el-tooltip :content="displayId(m)" placement="top">
                            <div class="mono model-id">{{ displayId(m) }}</div>
                          </el-tooltip>
                        </div>
                        <el-tooltip v-if="m.name && m.name !== m.id" :content="m.name" placement="top">
                          <div class="model-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.name }}</div>
                        </el-tooltip>
                        <el-tooltip v-if="m.accountless" content="单来源渠道未配置账号，模型已自动关闭" placement="top">
                          <span class="tag tag-dim accountless-tag">无账号</span>
                        </el-tooltip>
                      </td>
                      <td>{{ channelName(d.channel) }}</td>
                      <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                        <el-tooltip :content="d.id" placement="top">
                          <span class="mono model-actual">{{ d.id }}</span>
                        </el-tooltip>
                      </td>
                      <td>
                        <div class="custom-cell">
                          <el-tooltip :content="`自定义上下文长度（Token）：${fmtInt(ctxOfChannel(m, d))}，可直接写 128K / 1M，留空恢复默认`" placement="top">
                            <input
                              type="text"
                              class="f-input custom-input"
                              style="width: 62px"
                              :value="ctxDraft[ctxDraftKey(m, d)] ?? (ctxOfChannel(m, d) ? fmtCtx(ctxOfChannel(m, d)) : '')"
                              placeholder="自动"
                              @focus="ctxDraft[ctxDraftKey(m, d)] = String(ctxOfChannel(m, d) || '')"
                              @input="ctxDraft[ctxDraftKey(m, d)] = ($event.target as HTMLInputElement).value"
                              @change="commitChannelCtx(m, d)"
                              @blur="commitChannelCtx(m, d)"
                              @keydown.enter="($event.target as HTMLInputElement).blur()"
                            />
                          </el-tooltip>
                          <el-tooltip v-if="channelCustom(d).contextLength" content="已自定义覆盖上下文" placement="top">
                            <span class="custom-badge">自</span>
                          </el-tooltip>
                        </div>
                      </td>
                      <td>
                        <div class="custom-cell">
                          <el-tooltip content="自定义思考强度，直接注入出站请求参数" placement="top">
                            <span>
                              <el-select
                                class="f-el-select custom-el-select"
                                popper-class="glass-popper"
                                :persistent="false"
                                :model-value="effortOfChannel(m, d)"
                                style="width: 90px"
                                placeholder="默认"
                                @update:model-value="(v: string) => updateChannelCustom(d, { reasoningEffort: v })"
                              >
                                <el-option v-for="opt in reasoningOptionsOf(m, d)" :key="opt.value" :value="opt.value" :label="opt.label" />
                              </el-select>
                            </span>
                          </el-tooltip>
                          <el-tooltip v-if="channelCustom(d).reasoningEffort" content="已自定义覆盖思考强度" placement="top">
                            <span class="custom-badge">自</span>
                          </el-tooltip>
                        </div>
                      </td>
                      <td>
                        <el-tooltip placement="top" :show-after="120" :disabled="!channelCapTags(d).length" popper-class="glass-popper qa-tip">
                          <template #content>
                            <div class="tip-title">模型能力</div>
                            <div v-for="n in capabilityNames({ capabilities: d.capabilities })" :key="n" class="tip-line">· {{ n }}</div>
                          </template>
                          <span class="tip-host" :class="{ 'can-tip': channelCapTags(d).length }">
                            <span v-for="t in channelCapTags(d)" :key="t" class="tag tag-dim" style="margin-right: 3px; font-size: 10px; padding: 1px 4px">{{ t }}</span>
                            <span v-if="!channelCapTags(d).length" style="color: var(--text-3)">—</span>
                          </span>
                        </el-tooltip>
                      </td>
                      <td style="text-align: center; color: var(--text-3)">{{ fmtRate(d.rate) }}</td>
                      <td v-if="di === 0" :rowspan="rowsOf(m).length">
                        <span v-if="m.sources.length === 1" style="color: var(--text-3)">单源模型</span>
                        <span v-else>
                          <el-select
                            class="f-el-select"
                            popper-class="glass-popper"
                            :persistent="false"
                            style="width: 100px"
                            :model-value="m.override"
                            :disabled="!m.enabled"
                            @update:model-value="(v: string) => setOverride(m, v)"
                          >
                            <el-option
                              v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))"
                              :key="o.value"
                              :value="o.value"
                              :label="o.label"
                            />
                          </el-select>
                        </span>
                      </td>
                      <td v-if="di === 0" :rowspan="rowsOf(m).length" style="text-align: center">
                        <el-tooltip v-if="m.accountless" content="所属渠道未配置账号，已自动关闭；导入账号后仍需手动开启" placement="top">
                          <div class="switch locked" role="switch" aria-checked="false" aria-disabled="true"></div>
                        </el-tooltip>
                        <div
                          v-else
                          class="switch"
                          :class="{ on: m.enabled }"
                          role="switch"
                          :aria-checked="!!m.enabled"
                          @click="toggleEnabled(m, !m.enabled)"
                        ></div>
                      </td>
                    </tr>
                  </template>
                </template>
                <template v-else>
                <tr v-for="(m, i) in rows" :key="m.id" :style="{ '--i': i }">
                  <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    <div class="model-id-line">
                      <el-tooltip :content="displayId(m)" placement="top">
                        <div class="mono model-id">{{ displayId(m) }}</div>
                      </el-tooltip>
                      <span v-if="activeTabRate(m) != null" class="rate-inline">×{{ activeTabRate(m) }}</span>
                      <!-- 合并进来的统一请求名：点它不是另一个模型，只是这张渠道页上的别名入口 -->
                      <el-tooltip v-if="aliasText(m)" :content="`别名：${aliasText(m)}`" placement="top">
                        <span class="tag tag-dim alias-tag">别名</span>
                      </el-tooltip>
                    </div>
                    <el-tooltip v-if="displayName(m) && displayName(m) !== displayId(m)" :content="displayName(m)" placement="top">
                      <div class="model-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ displayName(m) }}</div>
                    </el-tooltip>
                    <el-tooltip v-if="m.accountless" content="单来源渠道未配置账号，模型已自动关闭" placement="top">
                      <span class="tag tag-dim accountless-tag">无账号</span>
                    </el-tooltip>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <!-- 非编辑态显示 K/M 缩写（131K / 1M），聚焦时才展开成完整数字：
                           列宽只有 90px，直接显示 131072 必然被裁。tooltip 同步显示精确值 -->
                      <el-tooltip :content="ctxTip(m)" placement="top">
                        <input
                          type="text"
                          class="f-input custom-input"
                          style="width: 62px"
                          :value="ctxDraft[m.id] ?? ctxDisplay(m)"
                          placeholder="自动"
                          @focus="ctxDraft[m.id] = String(ctxValue(m) || '')"
                          @input="ctxDraft[m.id] = ($event.target as HTMLInputElement).value"
                          @change="commitCtx(m)"
                          @blur="commitCtx(m)"
                          @keydown.enter="($event.target as HTMLInputElement).blur()"
                        />
                      </el-tooltip>
                      <el-tooltip v-if="channelCustom(editDetail(m)).contextLength" content="已自定义覆盖上下文" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <el-tooltip content="自定义思考强度，直接注入出站请求参数" placement="top">
                        <span>
                          <el-select
                            class="f-el-select custom-el-select"
                            popper-class="glass-popper"
                            :persistent="false"
                            :model-value="effortOfChannel(m, editDetail(m))"
                            style="width: 90px"
                            placeholder="默认"
                            @update:model-value="(v: string) => updateChannelCustom(editDetail(m), { reasoningEffort: v })"
                          >
                            <el-option v-for="opt in reasoningOptionsOf(m, editDetail(m))" :key="opt.value" :value="opt.value" :label="opt.label" />
                          </el-select>
                        </span>
                      </el-tooltip>
                      <el-tooltip v-if="channelCustom(editDetail(m)).reasoningEffort" content="已自定义覆盖思考强度" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <!-- 能力/来源渠道：列宽固定且内容可多值，悬停展开完整清单 -->
                  <td>
                    <el-tooltip placement="top" :show-after="120" :disabled="!capabilityTags(metaOf(m)).length" popper-class="glass-popper qa-tip">
                      <template #content>
                        <div class="tip-title">模型能力</div>
                        <div v-for="n in capabilityNames(metaOf(m))" :key="n" class="tip-line">· {{ n }}</div>
                      </template>
                      <span class="tip-host" :class="{ 'can-tip': capabilityTags(metaOf(m)).length }">
                        <span v-for="t in capabilityTags(metaOf(m))" :key="t" class="tag tag-dim" style="margin-right: 3px; font-size: 10px; padding: 1px 4px">{{ t }}</span>
                        <span v-if="!capabilityTags(metaOf(m)).length" style="color: var(--text-3)">—</span>
                      </span>
                    </el-tooltip>
                  </td>
                  <td>
                    <span v-if="m.sources.length === 1" style="color: var(--text-3)">单源模型</span>
                    <span v-else>
                      <el-select
                        class="f-el-select"
                        popper-class="glass-popper"
                        :persistent="false"
                        style="width: 100px"
                        :model-value="m.override"
                        :disabled="!m.enabled"
                        @update:model-value="(v: string) => setOverride(m, v)"
                      >
                        <el-option
                          v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))"
                          :key="o.value"
                          :value="o.value"
                          :label="o.label"
                        />
                      </el-select>
                    </span>
                  </td>
                  <td style="text-align: center">
                    <el-tooltip v-if="m.accountless" content="所属渠道未配置账号，已自动关闭；导入账号后仍需手动开启" placement="top">
                      <div class="switch locked" role="switch" aria-checked="false" aria-disabled="true"></div>
                    </el-tooltip>
                    <div
                      v-else
                      class="switch"
                      :class="{ on: m.enabled }"
                      role="switch"
                      :aria-checked="!!m.enabled"
                      @click="toggleEnabled(m, !m.enabled)"
                    ></div>
                  </td>
                </tr>
                </template>
                <tr v-if="!rows.length">
                  <td :colspan="activeTab ? 6 : 9" style="text-align: center; color: var(--text-3); padding: 24px 0">
                    <template v-if="models.length && (statusFilter !== 'all' || filter.trim())">
                      当前筛选条件下无匹配模型 ——
                      <button class="link-btn" @click="resetFilters">清空筛选</button>
                    </template>
                    <template v-else>
                      无匹配模型 —— 点上方「拉取模型」从官方目录云端同步（用号池账号 token，不依赖本地软件）
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- Tab 2: 全渠道反向模型映射 -->
      <div v-else-if="mainTab === 'reverse'" class="card">
        <div class="card-title">
          全渠道反向模型映射
          <span class="right">统一请求名 → 各渠道实际模型 · 响应模型字段保持请求名</span>
        </div>
        <div class="set-desc" style="margin-bottom: 10px">
          解决不同渠道同一模型命名不一致（例如 Trae 的 glm-5.3 与 WorkBuddy/ZCode 的名称不同）。客户端按统一名称请求，网关根据路由渠道自动发给对应渠道的模型名。
        </div>
        <div class="set-desc" style="margin-bottom: 10px">
          实际模型可以与统一请求名相同（恒等映射）：只要它是该渠道原生模型，保存后仍按该名称转发；大小写可以不同。
        </div>
        <div class="rev-form">
          <div class="rev-row">
            <span class="rev-label">统一请求名：</span>
            <input v-model="reverseName" class="input" style="width: 240px" placeholder="统一名称（如 glm-5.3-flash）" />
          </div>
          <div class="rev-channels-grid">
            <div v-for="c in channels" :key="c.id" class="rev-ch-item">
              <span class="rev-ch-label">{{ c.display }}：</span>
              <el-select
                class="f-el-select"
                popper-class="glass-popper"
                :persistent="false"
                style="width: 190px"
                :model-value="reverseTargets[c.id] || ''"
                placeholder="（不映射此渠道）"
                filterable
                @update:model-value="(v: string) => reverseTargets[c.id] = v"
              >
                <el-option value="" label="（不映射此渠道）" />
                <el-option v-for="modelId in channelTargetModels(c.id)" :key="modelId" :value="modelId" :label="modelId" />
              </el-select>
            </div>
          </div>
          <div class="rev-actions">
            <button class="btn btn-cta" :disabled="!reverseName.trim()" @click="addReverseAlias">
              <i class="ph ph-plus"></i>保存反向映射
            </button>
            <button v-if="reverseName" class="btn" style="margin-left: 8px" @click="reverseName = ''; reverseTargets = {}">
              重置
            </button>
          </div>
        </div>
        <div v-if="reverseAliases.length" class="rev-list">
          <div v-for="[uname, cmap] in reverseAliases" :key="uname" class="rev-card-item">
            <div class="rev-card-head">
              <span class="mono rev-card-title">{{ uname }}</span>
              <div class="rev-card-btns">
                <el-tooltip content="编辑映射" placement="top">
                  <button class="btn btn-sm" @click="editReverseAlias(uname, cmap)"><i class="ph ph-pencil-simple"></i>编辑</button>
                </el-tooltip>
                <el-tooltip content="移除映射" placement="top">
                  <button class="btn btn-sm btn-del" @click="removeReverseAlias(uname)"><i class="ph ph-trash"></i>删除</button>
                </el-tooltip>
              </div>
            </div>
            <div class="rev-card-routes">
              <span v-for="(target, ch) in cmap" :key="ch" class="tag tag-dim rev-route-tag">
                <span class="rev-route-ch">{{ channelName(ch) }}</span>：<span class="mono">{{ target }}</span>
              </span>
            </div>
          </div>
        </div>
        <div v-else class="set-desc" style="margin-top: 10px; color: var(--text-3)">
          暂无反向映射 —— 输入统一名称并为各渠道指定对应实际模型后点保存即可生效。
        </div>
      </div>
    </div>

    <!-- 批量启停确认（关闭/反选会改变大量模型的可用性，先确认再落盘） -->
    <div v-if="bulkConfirm" class="p-mask" @click.self="bulkConfirm = null">
      <div class="p-dlg glass">
        <div class="p-title">{{ bulkConfirm.title }}</div>
        <div class="set-desc">{{ bulkConfirm.desc }}</div>
        <div class="p-actions">
          <button class="btn" @click="bulkConfirm = null">取消</button>
          <button class="btn btn-primary" @click="confirmBulk">确定</button>
        </div>
      </div>
    </div>

    <!-- 路由与切换规则小弹窗 -->
    <Teleport to="body">
      <div v-if="ruleDialogOpen" class="p-mask" @click.self="ruleDialogOpen = false">
        <div class="p-dlg glass rule-dlg" role="dialog" aria-modal="true" aria-label="路由与切换规则">
          <header class="rule-head">
            <div class="rule-head-left">
              <span class="rule-head-icon"><i class="ph ph-git-fork"></i></span>
              <div class="rule-head-text">
                <div class="rule-title">路由与切换规则</div>
                <div class="rule-sub">网关请求调度与模型切换说明</div>
              </div>
            </div>
            <el-tooltip content="关闭" placement="top">
              <button class="rule-close" @click="ruleDialogOpen = false"><i class="ph ph-x"></i></button>
            </el-tooltip>
          </header>
          <div class="rule-body">
            <div class="rule-item"><b>1. 渠道选择：</b>同一个模型只有一个渠道提供时，会自动走这个渠道；多个渠道都提供时，优先走你为它指定的渠道，没有指定就自动挑当前更合适的一个。</div>
            <div class="rule-item"><b>2. 统一模型名：</b>不同渠道对同一模型的叫法可能不同。设置统一名称后，你用这个名称请求，系统会自动换成对应渠道的真实模型名，返回给你的仍是统一名称。</div>
            <div class="rule-item"><b>3. 上下文与思考强度：</b>可以在表格里直接调整上下文长度和思考强度，保存后立即生效，模型目录也会同步更新。</div>
            <div class="rule-item"><b>4. 自动切换模型：</b>请求的模型找不到，或它所属渠道暂时没有可用账号时，如果开启了「不可用时自动切换模型」，会自动改用你设置的回退模型，你不用改请求。</div>
            <div class="rule-item"><b>5. 临时不可用：</b>某个账号在某个模型上被限流，或该账号不支持这个模型时，只会暂时跳过这个账号在这个模型上的使用；换账号或换模型都不受影响。</div>
            <div class="rule-item"><b>6. 用量记录：</b>发生换渠道、换模型或名称转换时，用量明细会显示实际使用的模型；把鼠标停在状态上还能看到切换详情。</div>
          </div>
          <footer class="rule-foot">
            <button class="btn btn-primary" @click="ruleDialogOpen = false">我知道了</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ===== 顶部三大 Tab 切换按钮 ===== */
.models-main-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
}
.main-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.main-tab-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--panel);
}
.main-tab-btn.active {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

/* ===== 路由与切换规则弹窗 ===== */
.p-mask {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.rule-dlg {
  width: 580px;
  max-width: 95vw;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rule-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-head-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}
.rule-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.rule-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.rule-close {
  background: transparent;
  border: none;
  font-size: 16px;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--r-sm);
}
.rule-close:hover {
  color: var(--text);
  background: var(--bg-soft);
}
.rule-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.rule-item b {
  color: var(--text);
}
.rule-foot {
  display: flex;
  justify-content: flex-end;
}

/* ===== 页头工具条：渠道独占一行，状态与搜索/拉取在下一行；反馈消息浮层不占布局 ===== */
.models-head {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.models-head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 状态与搜索/拉取整体靠右（head-tools 的 auto 外边距在这里归零，否则状态仍会被顶到左侧） */
.models-head-filters {
  justify-content: flex-end;
}
.models-head-filters .head-tools {
  margin-left: 0;
}
/* 带文字标签的分段组：页头有两个 seg（渠道 / 状态），无标签时两组「全部」会混淆 */
.seg-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.seg-label {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
/* 渠道分段选择器：容器框住选项，选中项点亮（与号池弹窗的方式切换同一语言）；
   容器 padding 3px + 内项 22px + 边框 = 30px，与右侧 .btn / 搜索框同高成一条线。
   渠道多达十几个，必须允许换行：单行会把右侧工具栏挤到下一行、渠道也被裁掉 */
.seg {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
/* 渠道组独占一整行才有空间真正换行（inline-flex 的宽度会收缩到内容宽度） */
.models-head-channels .seg-group {
  min-width: 0;
  flex: 1 1 auto;
}
.models-head-channels .seg {
  width: 100%;
}
.seg-item {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: calc(var(--r-sm) - 3px);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.2s;
}
.seg-item:hover {
  color: var(--text);
}
.seg-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
  box-shadow: 0 0 10px -6px var(--accent-line);
}
.seg-item:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
/* 搜索框：图标 + 无框输入 + 快捷清空；聚焦时整框点亮主色并给图标染色 */
.search-box {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 210px;
  height: var(--ctl-h);
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-box:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.search-box > .ph {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-3);
  transition: color 0.2s;
}
.search-box:focus-within > .ph {
  color: var(--accent-strong);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-ui);
}
.search-input::placeholder {
  color: var(--text-3);
}
.search-clear {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.search-clear:hover {
  color: var(--text);
  background: var(--line);
}
/* 拉取按钮里的云下载图标与文字同高（.btn 自带 6px 图文间距） */
.head-tools .btn .ph {
  font-size: 13px;
}
/* 拉取反馈：浮在工具条下缘，进出均不挤动任何布局 */
.head-msg {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 6;
  max-width: min(560px, 82%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.6);
}
.headmsg-enter-active,
.headmsg-leave-active {
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
}
.headmsg-enter-from,
.headmsg-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .headmsg-enter-active,
  .headmsg-leave-active {
    transition: none;
  }
}
/* 卡片标题右端批量按钮组：.right 的 margin-left:auto 已把这一组推到最右 */
.bulk-bar {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 窄窗口下标题行允许换行：三个批量按钮 + 计数挤不下时整体落到第二行，不压扁按钮 */
.card-title {
  flex-wrap: wrap;
  row-gap: 8px;
}
.bulk-bar .btn .ph {
  font-size: 12px;
}
/* 空态里的行内重置按钮：长得像链接，不抢表格主视觉 */
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
  color: var(--accent-strong);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link-btn:hover {
  color: var(--accent);
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
  padding-right: 34px;
}
.err-text {
  color: var(--err, #e05555);
}
.err-close {
  position: absolute;
  top: 6px;
  right: 8px;
  border: none;
  background: transparent;
  color: var(--err, #e05555);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px;
  opacity: 0.75;
}
.err-close:hover {
  opacity: 1;
}
/* 模型目录表格：字段值（含表头）统一居中。text-align 管不到 display:flex 的容器，
   模型名与来源渠道两个 flex 单元格单独归中 */
.models-table th,
.models-table td {
  text-align: center;
}
.models-table .model-id-line {
  justify-content: center;
}
.model-name {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
/* 模型名列：id 与渠道倍率同一行，倍率是模型名右侧的灰字，不额外占行高 */
.model-id-line {
  display: flex;
  align-items: center;
}
.model-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rate-inline {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  margin-left: 6px;
}
/* 合并行的别名标签：不参与省略，跟随 id 行右侧 */
.alias-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 4px;
  margin-left: 6px;
}
/* 全部视图「实际模型」子列：该渠道真正发往上游的模型名 */
.model-actual {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
/* 自定义单元格（上下文与思考强度） */
.custom-cell {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.custom-input {
  height: 26px;
  padding: 0 6px;
  font-size: 11.5px;
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  color: var(--text);
  font-family: var(--font-mono);
}
.custom-input:focus {
  border-color: var(--accent-line);
}
.custom-el-select :deep(.el-select__wrapper) {
  min-height: 26px;
  height: 26px;
  font-size: 11.5px;
  padding: 0 8px;
}
.custom-badge {
  margin-left: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
  line-height: 1;
}

/* 能力 / 来源渠道列的悬停浮窗：内容多值时展开完整清单。
   宿主保持 inline-block 收在列宽内，浮窗走 teleport，不改变行高与列宽 */
.tip-host {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 有可展开内容时才给 help 光标，暗示可悬停（浮窗禁用时不误导） */
.tip-host.can-tip {
  cursor: help;
}
.tip-title {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.tip-line {
  color: var(--text-2);
  line-height: 1.6;
  white-space: nowrap;
}

/* 反向模型映射卡片样式 */
.rev-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rev-label {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.rev-channels-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.rev-ch-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rev-ch-label {
  font-size: 11px;
  color: var(--text-3);
  width: 90px;
  text-align: right;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rev-actions {
  display: flex;
  align-items: center;
}
.rev-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.rev-card-item {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.rev-card-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.rev-card-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn-sm {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}
.btn-del:hover {
  color: var(--err, #e05555);
}
.rev-card-routes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rev-route-tag {
  font-size: 11px;
}
.rev-route-ch {
  color: var(--text-3);
}
.accountless-tag {
  display: inline-block;
  margin-top: 2px;
  font-size: 10px;
  padding: 1px 4px;
}
.switch.locked {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
