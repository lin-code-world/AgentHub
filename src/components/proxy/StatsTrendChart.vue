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
<script setup lang="ts">
// 反代网关 · 总览：请求趋势折线
// 按「用量统计」当前维度（Key / 渠道 / 模型）分组，每项一条线，有多少画多少。
// 纵轴只有一根：画 token 还是请求数由 metric 决定（跟随用量统计表当前选中的列头）。
// 图例用 HTML 自绘（放在图下方居中、一行放不下自动换行），不用 ECharts legend——
// 线多时图例会占好几行，echarts legend 会与绘图区重叠，自绘则让页面自然向下生长；
// 点击图例项可隐 / 显对应线（保留原先 ECharts legend 的这套交互）。
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from "vue";
import { init, type ECharts } from "../../utils/echarts";
import { useAppStore } from "../../stores/app";
import { glassTooltip, tooltipCard, markerColor, type TooltipParam } from "../../utils/chart-tooltip";
import type { ProxyStatsBucket, ProxyStatsGroupSeries } from "../../types";
import { fmtInt, fmtK } from "../../views/proxy/format";

const props = defineProps<{
  /** 时间轴桶（x 轴刻度），各分组共用 */
  buckets: ProxyStatsBucket[];
  /** 各分组序列（每项一条线） */
  series: ProxyStatsGroupSeries[];
  granularity: "hour" | "day";
  /** 纵轴指标：tokens = 总 Token，req = 请求数（跟随用量统计表当前选中的列头） */
  metric: "tokens" | "req";
}>();

const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;

/** 取 :root 上的 CSS 变量（canvas 不认 var()，必须解析成实色） */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// 固定色板：线多时按序循环。前四色取站内主题色变量（与其它图表同色系），其余用固定色补足
const PALETTE_VARS = ["--accent", "--info", "--warn", "--danger"];
const PALETTE_FALLBACK = ["#44e07f", "#5c9dff", "#e5b454", "#f26d6d", "#b07cf0", "#48c9c9", "#f0885a", "#7ab8ff", "#d4d94a", "#ff8fc7"];
function seriesColor(i: number): string {
  return i < PALETTE_VARS.length ? cssVar(PALETTE_VARS[i], PALETTE_FALLBACK[i]) : PALETTE_FALLBACK[i % PALETTE_FALLBACK.length];
}

/** 系列显隐（点图例切换）：按分组 id 记而不是按序号，实时刷新换掉整个数组也不会丢隐藏状态 */
const hidden = ref<Set<string>>(new Set());
function toggleSeries(id: string) {
  const next = new Set(hidden.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  hidden.value = next;
}

/** 图例与 tooltip 的展示项：重名分组（如两个同名 Key）补序号，否则图例与提示分不清。
 *  颜色读的是 CSS 变量（getComputedStyle 不是响应式源），所以这里显式读一下 ui.isDark
 *  建立依赖，否则切换深浅主题时颜色不会重算。 */
const items = computed(() => {
  void ui.isDark;
  const seen = new Map<string, number>();
  return (props.series || []).map((s, i) => {
    const base = s.name || "（未命名）";
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { key: `${i}-${s.id}`, id: s.id, label: n === 1 ? base : `${base} (${n})`, color: seriesColor(i), tokens: s.tokens || [], reqs: s.reqs || [] };
  });
});

function render() {
  if (!chart || !el.value) return;
  const buckets = props.buckets || [];
  const list = items.value;
  const gridColor = cssVar("--border", "rgba(15,23,42,0.08)");
  const textColor = cssVar("--text-3", "#85919f");
  const isToken = props.metric === "tokens";
  const hid = hidden.value;

  chart.clear();
  chart.setOption({
    animation: false,
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 58, right: 24, top: 14, bottom: 30 },
    tooltip: {
      ...glassTooltip(),
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const arr = Array.isArray(params) ? params : [params];
        const p0 = arr[0];
        if (!p0) return "";
        const di = p0.dataIndex;
        const bucket = buckets[di];
        if (!bucket) return "";
        // 每项一行：名称 + 该时刻的 token 数与请求数（两个都显示，与纵轴画哪个无关）
        const rows = arr.map((p) => {
          const si = p.seriesIndex ?? -1;
          const it = si >= 0 ? list[si] : undefined;
          return {
            color: markerColor(p.marker),
            label: it ? it.label : p.seriesName || "",
            value: `${fmtK(it ? it.tokens[di] || 0 : 0)} token / ${fmtInt(it ? it.reqs[di] || 0 : 0)} 次`,
          };
        });
        return tooltipCard(bucket.label, rows);
      },
    },
    xAxis: {
      type: "category",
      data: buckets.map((b) => (props.granularity === "hour" ? b.label.slice(11) : b.label.slice(5))),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    // 单纵轴：数值口径由 metric 决定（token 与请求数量纲不同，同一时刻只画一个指标）
    yAxis: {
      type: "value",
      axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => fmtK(v) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: list.map((it) => ({
      name: it.label,
      type: "line",
      // 隐藏的系列给空数组：线不画、tooltip 也不列它（按 id 判断，实时刷新后隐藏状态不丢）
      data: hid.has(it.id) ? [] : isToken ? it.tokens : it.reqs,
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      showSymbol: buckets.length <= 60,
      lineStyle: { width: 1.8, color: it.color },
      itemStyle: { color: it.color },
    })),
  });
}

let resizeObserver: ResizeObserver | null = null;
const onResize = () => chart?.resize();

onMounted(() => {
  if (!el.value) return;
  nextTick(() => {
    if (!el.value) return;
    chart = init(el.value);
    render();
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(el.value);
  });
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});

watch(() => props.buckets, () => nextTick(render), { deep: true });
watch(() => props.series, () => nextTick(render), { deep: true });
watch(() => props.granularity, () => nextTick(render));
watch(() => props.metric, () => nextTick(render));
// 点图例切换系列显隐：立即重绘
watch(hidden, () => nextTick(render));
watch(() => ui.isDark, () => nextTick(render));
</script>

<template>
  <div class="trend-wrap">
    <div class="trend-chart" ref="el"></div>
    <!-- 自绘图例：底部居中、一行放不下自动换行（线多时可占多行） -->
    <ul v-if="items.length" class="trend-legend">
      <li v-for="it in items" :key="it.key" class="lg-item" :class="{ off: hidden.has(it.id) }" :title="hidden.has(it.id) ? '点击显示这条线' : '点击隐藏这条线'" @click="toggleSeries(it.id)">
        <i :style="{ background: it.color }"></i>
        <span class="lg-name">{{ it.label }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.trend-wrap {
  width: 100%;
}
.trend-chart {
  width: 100%;
  height: 260px;
}
.trend-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 18px;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.trend-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.trend-legend li.off {
  opacity: 0.38;
}
.trend-legend i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
</style>
