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
<!-- 反代网关 · 总览（原「用量统计」页）
     页面结构：顶部时间档位 + 刷新/清理；用量统计表（维度切换 + 可排序列头 + 最新使用 + 筛选下钻）；
     两张比例饼图（跟随维度切换）；请求趋势折线图（独立卡片，按当前维度分线）；请求明细（筛选行 + 明细表）。
     口径：不建日聚合冗余表，全部由 usage_requests 流水直查 GROUP BY；流水保留期可配
     （设置 · 反代网关「余额历史 / 请求流水保留」，默认 90 天），本页「清理」按当前值立即删一轮。
     时间区间统摄全页：用量统计表 / 饼图 / 请求趋势 / 请求明细吃同一个 { from, to }；
     请求趋势折线图另取 proxy_stats_series（传 dim）：按当前维度分组，每项一条线，只吃时间区间。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyStatsOverview, ProxyStatsDetail, ProxyStatsDim, ProxyStatsAggRow, ProxyStatsBucket, ProxyStatsGroupSeries } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, fmtTime, fmtDate, fmtAgo, channelName, statusCls } from "./format";
import { coalesceAsync } from "../../utils/timing";
import { toast as ElMessage } from "../../utils/toast";
import { loadPhaseOf } from "./loadState";
import StatsDonutChart from "../../components/proxy/StatsDonutChart.vue";
import StatsTrendChart from "../../components/proxy/StatsTrendChart.vue";

const app = useAppStore();

// ===== 时间区间 =====
const PRESETS = [
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "custom", label: "自定义" },
] as const;
type Preset = (typeof PRESETS)[number]["key"];

const DAY_MS = 86400000;
const preset = ref<Preset>("today");
const customRange = ref<[string, string] | null>(null);
// 响应式时间锚：Date.now() 不是响应式依赖，直接在 range computed 里取会让区间冻结在
// 页面挂载时刻——「今天」档的 to 停在那一刻，之后的新请求 ts > to 永远查不到（点刷新
// 也没用，重启组件重建才好）。每次刷新前先推进 nowTick，让区间跟着当下时刻走。
const nowTick = ref(Date.now());

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dateInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前生效区间（毫秒闭区间）：档位、自定义日期或时间锚变化时自动重算 */
const range = computed<{ from: number; to: number }>(() => {
  const now = nowTick.value;
  if (preset.value === "custom") {
    const c = customRange.value;
    if (c && c[0] && c[1]) {
      const f = new Date(`${c[0]}T00:00:00`).getTime();
      const t = new Date(`${c[1]}T23:59:59.999`).getTime();
      return { from: Math.min(f, t), to: Math.max(f, t) };
    }
    return { from: dayStart(now) - 6 * DAY_MS, to: now };
  }
  const days = preset.value === "today" ? 1 : preset.value === "7d" ? 7 : 30;
  const from = dayStart(now) - (days - 1) * DAY_MS;
  // 「今天」档到此刻为止；其余档到今天 23:59:59.999（含当天全部流水）
  const to = days === 1 ? now : dayStart(now) + DAY_MS - 1;
  return { from, to };
});

const rangeLabel = computed(() => {
  const f = dateInput(range.value.from);
  const t = dateInput(range.value.to);
  return f === t ? f : `${f} ~ ${t}`;
});

function pickPreset(p: Preset) {
  // 首次切到自定义时给个「近 7 天」的初值，避免选择器空着
  if (p === "custom" && !customRange.value) {
    const now = Date.now();
    customRange.value = [dateInput(dayStart(now) - 6 * DAY_MS), dateInput(now)];
  }
  preset.value = p;
}
function pickCustomRange(v: [string, string] | null) {
  if (v && v[0] && v[1]) {
    customRange.value = v;
    preset.value = "custom";
  }
}

// ===== 维度 / 指标 / 排序 =====
const DIMS = [
  { value: "key", label: "Key" },
  { value: "channel", label: "渠道" },
  { value: "model", label: "模型" },
] as const;
// 初次进入的默认视角：Key × Token（最常用的「谁在用、用了多少」）
const dim = ref<ProxyStatsDim>("key");
/** 排序口径：点列头切换。只在这两列之间切，且恒为降序（看「谁最多」是这个页面的主要用法）。
 *  同一口径也决定请求趋势折线画哪个指标：点「总 Token」列 → 折线画 token，点「请求数」列 → 画请求数 */
const sortBy = ref<"req" | "tokens">("tokens");
function pickSort(k: "req" | "tokens") {
  sortBy.value = k;
}
/** 折线图的横轴粒度：跨度 ≤ 1 天按小时（看得清一天内的起伏），超过 1 天按天。
 *  「今天」天然落在这条规则里；「自定义」选同一天也走按小时，两个入口同区间得到同一种图。
 *  注意 range 依赖 nowTick/preset，本身是响应式的，所以这里能跟着档位与日期自动重算。 */
const trendGranularity = computed<"hour" | "day">(() => {
  const { from, to } = range.value;
  return to - from <= DAY_MS ? "hour" : "day";
});
const dimLabel = computed(() => DIMS.find((d) => d.value === dim.value)?.label || "维度");

// ===== 数据 =====
const ov = ref<ProxyStatsOverview | null>(null);
/** 请求趋势折线数据：按「用量统计」当前维度分组（每项一条线），只吃时间区间；
 *  不与「请求明细」的筛选条件联动 */
const trendBuckets = ref<ProxyStatsBucket[]>([]);
const trendSeries = ref<ProxyStatsGroupSeries[]>([]);
/** 折线图实际使用的粒度：以后端回填为准（后端可能把 hour 降级成 day），
 *  初值同 trendGranularity，取到数据后被覆盖 */
const seriesGranularity = ref<"hour" | "day">("day");
const detail = ref<ProxyStatsDetail | null>(null);
const page = ref(1);
const pageSize = 15;
const err = ref("");
/** 首屏 / 切档时在飞：空表期间显示「加载中」而不是「当前区间暂无数据」（I6 空态三态） */
const busy = ref(false);
const filters = reactive({ key: "", model: "", channel: "", status: "" }); // key 存 Key 的 keyId（明细筛选是下拉精确选择）

/** 空分组的筛选哨兵：与后端 store.cjs 的 NONE_FILTER 是同一个字面量，两边要一起改 */
const NONE_FILTER = "__none__";

/** 分组展示名：渠道 / Key / 模型都可能为空（未认证请求、没走到渠道），统一在这里命名，
 *  排行 / 饼图 / 下拉 / 折线共用，保证各处叫法一致。 */
function groupLabel(d: ProxyStatsDim, name: string): string {
  if (d === "channel") return name ? channelName(name) : "未认证 / 未知渠道";
  if (name) return name;
  return d === "key" ? "（无 Key）" : "（空模型）";
}

const s = computed(() => ov.value?.summary);

/** 下拉的「全部」项 value 是空串，空分组不能也传空串（会被当成「不筛选」），统一换成哨兵 */
const channelOptions = computed(() => (ov.value?.tops.channel || []).map((r) => ({ id: r.name || NONE_FILTER, label: groupLabel("channel", r.name) })));
/** 模型下拉选项：来自当前区间的模型排行（与渠道下拉同源），选中即按模型精确匹配 */
const modelOptions = computed(() => (ov.value?.tops.model || []).map((r) => ({ id: r.name || NONE_FILTER, label: groupLabel("model", r.name) })));

const topRows = computed(() => {
  const rows = [...(ov.value?.tops[dim.value] || [])];
  const key = sortBy.value;
  rows.sort((a, b) => (key === "tokens" ? b.tokens - a.tokens : b.req - a.req));
  return rows.slice(0, 10).map((r) => ({
    ...r,
    label: groupLabel(dim.value, r.name),
  }));
});

/** 饼图分组：跟上方维度走。模型条目多，只取前 8 名并把其余合并成「其他」；
 *  Key / 渠道数量有限且每个都值得看，全部列出不合并。
 *  重名处理：Key 可以重名也能为空（显示成「（未命名）」），图例上同名会分不清，
 *  这里给重名项补 (1)(2) 序号，仅影响显示，不影响数值与下钻。 */
const PIE_TOP = 8;
function pieSlices(metric: "tokens" | "req"): { name: string; value: number }[] {
  const rows = [...(ov.value?.tops[dim.value] || [])];
  const labelOf = (r: ProxyStatsAggRow) => groupLabel(dim.value, r.name);
  // 先按该指标排序再截断：「其他」必须是真正排在后面的那些，不能按别的口径先挑
  rows.sort((a, b) => (metric === "tokens" ? b.tokens - a.tokens : b.req - a.req));
  const limit = dim.value === "model" ? PIE_TOP : rows.length;
  const head = rows.slice(0, limit);
  const rest = rows.slice(limit);
  // 同名计数：第二次出现起补序号，避免图例出现多条一模一样且无法区分的条目
  const seen = new Map<string, number>();
  const out = head
    .map((r) => {
      const base = labelOf(r);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return { name: n === 1 ? base : `${base} (${n})`, value: metric === "tokens" ? r.tokens : r.req };
    })
    .filter((d) => d.value > 0);
  const restSum = rest.reduce((sum, r) => sum + (metric === "tokens" ? r.tokens : r.req), 0);
  if (restSum > 0) out.push({ name: "其他", value: restSum });
  return out;
}
const pieTokens = computed(() => pieSlices("tokens"));
const pieReq = computed(() => pieSlices("req"));

const keyRows = computed(() => [...(ov.value?.keys || [])].sort((a, b) => b.tokens - a.tokens).map((k) => ({ ...k, id: k.keyId || NONE_FILTER, label: groupLabel("key", k.name) })));

/** 用量统计行 → 明细筛选：按当前维度把该行灌进对应筛选条件并滚到明细表 */
function drillToRow(r: ProxyStatsAggRow) {
  filters.key = "";
  filters.channel = "";
  filters.model = "";
  if (dim.value === "key") filters.key = r.id || NONE_FILTER;
  else if (dim.value === "channel") filters.channel = r.id || NONE_FILTER;
  else if (dim.value === "model") filters.model = r.name || NONE_FILTER;
  filters.status = "";
  page.value = 1;
  loadDetail();
  detailRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / pageSize)));
/** 空态三态：加载中 / 确实没有请求 / 加载失败（失败给「重试」，别把断网当成「当前区间无数据」）。
 *  是否为空看「概览请求数 + 明细总数」，任一有数就按有数据处理 */
const phase = computed(() => loadPhaseOf({ loading: busy.value, error: err.value, count: (s.value?.req || 0) + (detail.value?.total || 0) }));

const rateCls = (r: number) => (r < 95 ? "rate-bad" : r < 99 ? "rate-warn" : "");

// ===== 取数 =====
async function refresh() {
  const { from, to } = range.value;
  try {
    ov.value = await api.proxyStatsOverview({ from, to, granularity: trendGranularity.value });
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 请求趋势取数的递增序号：并发时只认最后一次，丢弃先发后到的旧响应（快速切维度防串数据） */
let trendSeq = 0;

/** 请求趋势折线数据：按「用量统计」当前维度（Key / 渠道 / 模型）分组取数，每项一条线；
 *  只吃时间区间，不与「请求明细」的筛选条件联动。
 *  粒度以后端回填的为准——后端在「要小时但跨度 > 7 天」时会降级成按天，
 *  前端若还按自己要的 hour 去切片，标签会全变空字符串（横轴无刻度）。 */
async function loadSeries() {
  const { from, to } = range.value;
  const seq = ++trendSeq;
  try {
    const r = await api.proxyStatsSeriesByDim({ from, to, granularity: trendGranularity.value, dim: dim.value });
    if (seq !== trendSeq) return;
    const list = r.series || [];
    trendBuckets.value = r.buckets || [];
    // 分组名统一走 groupLabel（渠道 slug 转展示名，空分组单独命名），与排行 / 饼图叫法一致
    trendSeries.value = list.map((s) => ({ ...s, name: groupLabel(dim.value, s.name) }));
    if (r.range?.granularity) seriesGranularity.value = r.range.granularity;
  } catch (e) {
    if (seq !== trendSeq) return; // 过期请求的失败也丢弃，别把旧错误挂到当前维度上
    err.value = String((e as Error).message || e);
  }
}

async function loadDetail() {
  const { from, to } = range.value;
  try {
    detail.value = await api.proxyStatsDetail({
      from,
      to,
      page: page.value,
      pageSize,
      keyId: filters.key || undefined,
      model: filters.model || undefined,
      channel: filters.channel || undefined,
      status: filters.status || undefined,
    });
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function reload() {
  nowTick.value = Date.now(); // 先推进时间锚再取数：手动刷新要看到「此刻」为止的数据
  busy.value = true;
  try {
    await Promise.all([refresh(), loadSeries(), loadDetail()]);
  } finally {
    busy.value = false;
  }
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

// ===== 明细筛选 =====
const detailRef = ref<HTMLElement | null>(null);

/** 点「查询」/ 回车：把当前填写的条件应用上去并回到第一页（只作用于明细表，不动请求趋势折线） */
function applyFilter() {
  page.value = 1;
  loadDetail();
}
function resetFilters() {
  filters.key = "";
  filters.model = "";
  filters.channel = "";
  filters.status = "";
  applyFilter();
}

// ===== 清理流水：范围二选一（仅超期=按设置页保留期删旧 / 全部=清空整表），不可恢复所以先问一道 =====
const cleanOpen = ref(false);
const cleanScope = ref<"expired" | "all">("expired");
const cleaning = ref(false);
function openClean() {
  cleanScope.value = "expired"; // 每次打开回默认档，防上次选的「全部」被顺手确认
  cleanOpen.value = true;
}
async function doCleanup() {
  cleaning.value = true;
  try {
    const all = cleanScope.value === "all";
    const r = await api.proxyStatsCleanup(undefined, all);
    ElMessage.success(all ? `已清空全部流水 ${fmtInt(r.deleted)} 条` : `已清理保留期（${app.config.proxy.usageRetentionDays} 天）之前的流水 ${fmtInt(r.deleted)} 条`);
    cleanOpen.value = false;
    page.value = 1;
    await reload();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    cleaning.value = false;
  }
}

/** 本页是否处于前台：页面经 v-show 保活，事件刷新只在激活时跑，切走即停 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "stats");

// 事件合流：概览 + 折线 + 明细一起拉，1s 窗口合并防重入；先推进时间锚，让 range 拿到当下区间
const scheduleRefresh = coalesceAsync(() => {
  nowTick.value = Date.now();
  return Promise.all([refresh(), loadSeries(), loadDetail()]);
}, 1000);

// 档位/自定义日期变化：回到第 1 页并整体重拉。监听源头而不是 range 本身——
// nowTick 推进也会重算 range，若 watch(range) 会造成「刷新→重算→再刷新」的循环
watch([preset, customRange], () => {
  page.value = 1;
  scheduleRefresh();
});
// 维度切换：请求趋势折线按新维度重新分组取数（用量统计表一次拿到全部维度，无需重拉）
watch(dim, () => loadSeries());
// 筛选条件只在点「查询」时才生效：下拉 / 输入框改完不自动查，避免与「筛选」按钮下钻叠成两次查询。
// 回车等同点查询（键盘操作的常规预期），文本输入去掉了原来的 300ms 防抖轮询。

watch(active, (on) => {
  if (on) scheduleRefresh();
  else scheduleRefresh.cancel();
});

// 准实时刷新（任务 11）：usage 落库后后端 500ms 节流发 {type:"stats"}（事件体不带内容），
// 前端再节流最多 2s 一次；15s 兜底轮询防事件丢失（断流 / 休眠唤醒），页面可见才执行
const scheduleLiveRefresh = coalesceAsync(reload, 2000);
let liveTimer = 0;
let offEvent: (() => void) | undefined;

onMounted(() => {
  reload();
  // 明细/趋势/排行全部实时直查 usage_requests 流水，事件即变更信号；
  // resync = SSE 断线重连后的补偿信号（断线期间漏掉的事件用一次全量刷新补上）
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if (p.type !== "stats" && p.type !== "resync") return;
    if (!active.value) return;
    scheduleLiveRefresh();
  });
  liveTimer = window.setInterval(() => {
    if (active.value) scheduleLiveRefresh();
  }, 15000);
});

onUnmounted(() => {
  window.clearInterval(liveTimer);
  scheduleRefresh.cancel();
  scheduleLiveRefresh.cancel();
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 顶部筛选栏：档位 + 自定义区间 + 生效范围（sticky，滚动只发生在下方内容区）；
           右侧先给网关服务开关与端口号，再是刷新 / 清理 -->
      <div class="stats-filters">
        <div class="chips">
          <button v-for="p in PRESETS" :key="p.key" class="chip" :class="{ active: preset === p.key }" @click="pickPreset(p.key)">
            {{ p.label }}
          </button>
        </div>
        <el-date-picker v-if="preset === 'custom'" :model-value="customRange" type="daterange" value-format="YYYY-MM-DD" range-separator="~" start-placeholder="开始日期" end-placeholder="结束日期" popper-class="glass-popper" class="f-date-range" @update:model-value="pickCustomRange" />
        <span class="range-hint">{{ rangeLabel }}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" @click="reload"><i class="ph ph-arrows-clockwise"></i> 刷新</button>
        <button class="btn btn-sm" @click="openClean"><i class="ph ph-broom"></i> 清理</button>
      </div>

      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">加载失败：{{ err }} <button class="btn-link btn-sm" @click="reload">重试</button></div>
      </div>

      <!-- 用量统计：维度 × 排序双切换，含请求/响应 token 分列 -->
      <div class="card anim" style="margin-top: 12px">
        <div class="card-title">
          用量统计
          <div class="chips" style="margin-left: 8px">
            <button v-for="d in DIMS" :key="d.value" class="chip" :class="{ active: dim === d.value }" @click="dim = d.value">{{ d.label }}</button>
          </div>
        </div>
        <div class="tbl-wrap">
          <table class="tbl tbl-c tbl-even">
            <colgroup>
              <col />
              <col class="w-sort" />
              <col />
              <col />
              <col class="w-sort" />
              <col />
              <col />
              <col />
              <col class="w-btn" />
            </colgroup>
            <tbody>
              <tr>
                <th>{{ dimLabel }}</th>
                <th class="th-sort" :class="{ 'is-sort': sortBy === 'tokens' }" @click="pickSort('tokens')">总 Token <i class="ph ph-caret-down"></i></th>
                <th>请求 Token</th>
                <th>响应 Token</th>
                <th class="th-sort" :class="{ 'is-sort': sortBy === 'req' }" @click="pickSort('req')">请求数 <i class="ph ph-caret-down"></i></th>
                <th>成功率</th>
                <th title="仅统计有首字时间的请求（首字耗时大于 0 的才计入平均）">平均 TTFT</th>
                <th>最新使用</th>
                <th></th>
              </tr>
              <tr v-for="r in topRows" :key="r.id">
                <td>{{ r.label }}</td>
                <td class="mono">{{ fmtK(r.tokens) }}</td>
                <td class="mono">{{ fmtK(r.promptTokens) }}</td>
                <td class="mono">{{ fmtK(r.completionTokens) }}</td>
                <td class="mono">{{ fmtInt(r.req) }}</td>
                <td class="mono" :class="rateCls(r.successRate)">{{ r.successRate.toFixed(1) }}%</td>
                <td class="mono">{{ fmtMs(r.ttftAvg) }}</td>
                <td class="mono">{{ fmtAgo(r.lastTs) }}</td>
                <td><button class="btn btn-sm" @click="drillToRow(r)">筛选</button></td>
              </tr>
              <tr v-if="!topRows.length">
                <td colspan="9" class="empty-cell"><template v-if="phase === 'loading'">加载中…</template><template v-else-if="phase === 'failed'">加载失败：{{ err }} <button class="btn-link btn-sm" @click="reload">重试</button></template><template v-else>当前时间区间暂无请求数据</template></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 两个饼图：口径跟上方维度切换走，分别看「谁吃 token 多」与「谁请求多」 -->
      <div class="grid-2" style="margin-top: 12px">
        <div class="card anim">
          <div class="card-title">
            总 Token 比例 <span v-if="dim === 'model'" class="right">前 8 名</span>
          </div>
          <StatsDonutChart :data="pieTokens" :palette="['--accent', '--info', '--warn', '--danger']" unit="token" center-label="总 Token" />
        </div>
        <div class="card anim">
          <div class="card-title">
            请求数比例 <span v-if="dim === 'model'" class="right">前 8 名</span>
          </div>
          <StatsDonutChart :data="pieReq" :palette="['--accent', '--info', '--warn', '--danger']" unit="int" center-label="总请求" />
        </div>
      </div>

      <!-- 请求趋势：按当前维度（Key / 渠道 / 模型）分线，纵轴画 token 还是请求数跟随用量统计点选的列；
           只吃时间区间，不跟下方请求明细的筛选条件联动 -->
      <div class="card anim" style="margin-top: 12px">
        <div class="card-title">请求趋势</div>
        <StatsTrendChart :buckets="trendBuckets" :series="trendSeries" :granularity="seriesGranularity" :metric="sortBy" />
      </div>

      <!-- 请求明细：筛选条件 + 明细表 -->
      <div ref="detailRef" class="card anim" style="margin-top: 12px">
        <div class="card-title">请求明细</div>
        <div class="detail-filters">
          <el-select v-model="filters.key" placeholder="全部 Key" clearable class="f-el-select" popper-class="glass-popper">
            <el-option value="" label="全部 Key" />
            <el-option v-for="k in keyRows" :key="k.id" :value="k.id" :label="k.label" />
          </el-select>
          <el-select v-model="filters.model" placeholder="全部模型" clearable filterable class="f-el-select f-el-wide" popper-class="glass-popper">
            <el-option value="" label="全部模型" />
            <el-option v-for="m in modelOptions" :key="m.id" :value="m.id" :label="m.label" />
          </el-select>
          <el-select v-model="filters.channel" placeholder="全部渠道" clearable class="f-el-select f-el-wide" popper-class="glass-popper">
            <el-option value="" label="全部渠道" />
            <el-option v-for="c in channelOptions" :key="c.id" :value="c.id" :label="c.label" />
          </el-select>
          <el-select v-model="filters.status" placeholder="全部状态" clearable class="f-el-select" popper-class="glass-popper">
            <el-option value="" label="全部状态" />
            <el-option value="ok" label="成功 2xx" />
            <el-option value="4xx" label="客户端 4xx" />
            <el-option value="5xx" label="服务端 5xx" />
            <el-option value="other" label="无响应" />
          </el-select>
          <button class="btn btn-sm btn-chip-accent" @click="applyFilter"><i class="ph ph-magnifying-glass"></i> 查询</button>
          <button class="btn btn-sm" @click="resetFilters"><i class="ph ph-arrow-counter-clockwise"></i> 重置</button>
          <span class="detail-agg">{{ detail?.agg ? `${fmtInt(detail.agg.req)} 次请求 / 输入 ${fmtK(detail.agg.promptTokens)} token / 输出 ${fmtK(detail.agg.completionTokens)} token / 合计 ${fmtK(detail.agg.tokens)} token` : "" }}</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl tbl-c">
            <tbody>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>实际模型</th>
                <th>KEY</th>
                <th>渠道</th>
                <th>账号</th>
                <th>状态</th>
                <th>请求 Token</th>
                <th>响应 Token</th>
                <th>缓存命中</th>
                <th>TTFT</th>
                <th>耗时</th>
              </tr>
              <tr v-for="r in detail?.rows || []" :key="r.id">
                <td class="mono">
                  <el-tooltip :content="fmtDate(r.ts)" placement="top">
                    <span>{{ fmtTime(r.ts) }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td class="mono">{{ r.modelActual || "-" }}</td>
                <td class="mono">{{ r.keyName || "-" }}</td>
                <td>{{ channelName(r.channel) }}</td>
                <td>{{ r.accountName || "-" }}</td>
                <td>
                  <el-tooltip :content="r.error" :disabled="!r.error" placement="top">
                    <span class="tag" :class="statusCls(r.status)">{{ r.status || "-" }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ fmtK(r.promptTokens) }}</td>
                <td class="mono">{{ fmtK(r.completionTokens) }}</td>
                <td class="mono">
                  <el-tooltip v-if="r.cacheReadTokens" :content="`缓存读 ${fmtK(r.cacheReadTokens)} / 输入 ${fmtK(r.promptTokens)}${r.cacheCreationTokens ? ` / 缓存写 ${fmtK(r.cacheCreationTokens)}` : ''}`" placement="top">
                    <span>{{ r.promptTokens ? Math.round((r.cacheReadTokens / r.promptTokens) * 100) + "%" : "-" }}</span>
                  </el-tooltip>
                  <span v-else>-</span>
                </td>
                <td class="mono">{{ fmtMs(r.ttftMs) }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
              </tr>
              <tr v-if="!(detail?.rows || []).length">
                <td colspan="12" class="empty-cell"><template v-if="phase === 'loading'">加载中…</template><template v-else-if="phase === 'failed'">加载失败：{{ err }} <button class="btn-link btn-sm" @click="reload">重试</button></template><template v-else>当前筛选条件下没有请求明细（改一下筛选或点「重置」）</template></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <span class="pager-info">共 {{ fmtInt(detail?.total || 0) }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>

      <!-- 清理确认弹窗：删的是不可恢复的历史，范围与后果都写明白 -->
      <Teleport to="body">
        <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
          <div class="p-dlg glass">
            <div class="p-title">清理请求流水</div>
            <div class="chips" style="margin-bottom: 8px">
              <button class="chip" :class="{ active: cleanScope === 'expired' }" @click="cleanScope = 'expired'">仅超期流水</button>
              <button class="chip" :class="{ active: cleanScope === 'all' }" @click="cleanScope = 'all'">全部流水</button>
            </div>
            <div class="set-desc">
              <template v-if="cleanScope === 'expired'"> 将删除保留期（设置页当前为 {{ app.config.proxy.usageRetentionDays }} 天）之前的全部请求流水，此操作不可恢复。 </template>
              <template v-else> 将清空<b>整张请求流水表</b>（含当前筛选范围之外的历史记录），此操作不可恢复。 </template>
            </div>
            <div class="p-actions">
              <button class="btn" @click="cleanOpen = false">取消</button>
              <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">{{ cleaning ? "清理中…" : cleanScope === "all" ? "全部清空" : "确认清理" }}</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </section>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方内容区（对齐操作日志页的筛选栏配方） */
.stats-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--glass-a);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.stats-filters .spacer {
  flex: 1;
}
.range-hint {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* el 组件模板根是多节点结构，scoped 的 data-v 透传不到根上，必须 :deep 穿透 */
.stats-filters :deep(.f-date-range) {
  width: 260px;
}
.stats-filters :deep(.f-date-range .el-input__wrapper),
.stats-filters :deep(.f-date-range.el-date-editor) {
  min-height: 34px;
  font-size: 12.5px;
}

.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

/* 明细筛选行 */
.detail-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
/* 明细筛选行的下拉宽度按内容长度分两档：
   窄档（Key / 状态）内容短；宽档（模型 / 渠道）名称带版本号、渠道中文名或下划线，需要更多空间 */
.detail-filters :deep(.f-el-select) {
  width: 120px;
}
.detail-filters :deep(.f-el-select.f-el-wide) {
  width: 240px;
}
.detail-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 30px;
  font-size: 12.5px;
}
/* 查询 / 重置与左侧输入框同高（输入框 30px，小号按钮默认 24px，会矮一截） */
.detail-filters .btn {
  height: 30px;
  padding: 0 9px;
  font-size: 11.5px;
}
/* 查询用「选中标签」配色（与时间档位选中的绿色一致）：淡绿底 + 绿描边 + 亮绿字 */
.detail-filters .btn-chip-accent {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}
.detail-filters .btn-chip-accent:hover {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent-strong);
}
.detail-agg {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* 三个表（TOP / 各 Key / 明细）字段值居中；th 全局 .tbl 已居中，这里覆盖默认左对齐的 td */
.tbl-c th,
.tbl-c td {
  text-align: center;
}
/* 等宽分配：表格按列数均分，避免某一列按内容撑得很长（占比列已去进度条，不需要宽） */
.tbl-even {
  table-layout: fixed;
}
.tbl-even th,
.tbl-even td {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 可排序列：列头可点，带排序箭头；激活时箭头与文字高亮 */
.tbl-even .th-sort {
  cursor: pointer;
  user-select: none;
}
.tbl-even .th-sort:hover {
  color: var(--text-1);
}
.tbl-even .th-sort.is-sort {
  color: var(--accent);
}
.tbl-even .th-sort i {
  font-size: 10px;
  vertical-align: middle;
  opacity: 0.35;
}
.tbl-even .th-sort.is-sort i {
  opacity: 1;
}
/* 有排序箭头的两列稍宽一点，避免「总 Token ⌄」被省略号截断 */
.tbl-even .w-sort {
  width: 14%;
}
/* 操作列只放一个按钮，不需要与其他列同宽 */
.tbl-even .w-btn {
  width: 8%;
}

/* 成功率低于阈值时着色（TOP / Key 表共用） */
.rate-warn {
  color: var(--warn);
}
.rate-bad {
  color: var(--danger);
}

.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 18px 0;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.pager-info {
  font-size: 11px;
  color: var(--text-3);
}
</style>
