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
// 固定两条线：总 Token（左轴）与总请求数（右轴）。两者量纲差几个数量级
// （token 动辄百万、请求数才几百），共用一根纵轴会把请求线压成贴底直线，所以分离左右双轴。
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from "vue";
import { graphic, init, type ECharts } from "../../utils/echarts";
import { useAppStore } from "../../stores/app";
import { glassTooltip, tooltipCard, type TooltipParam } from "../../utils/chart-tooltip";
import type { ProxyStatsPoint } from "../../types";
import { fmtInt, fmtK } from "../../views/proxy/format";

const props = defineProps<{ points: ProxyStatsPoint[]; granularity: "hour" | "day" }>();

const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;

/** 取 :root 上的 CSS 变量（canvas 不认 var()，必须解析成实色） */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function render() {
  if (!chart || !el.value) return;
  const points = props.points || [];
  const gridColor = cssVar("--border", "rgba(15,23,42,0.08)");
  const textColor = cssVar("--text-3", "#85919f");
  const accent = cssVar("--accent", "#44e07f");
  const info = cssVar("--info", "#5c9dff");
  // 点少时直接在点上标数值；点多了靠悬停
  const showLabel = points.length > 0 && points.length <= 20;

  chart.clear();
  chart.setOption({
    animation: false,
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    // 右侧留位给右轴刻度；底部留位给图例（图例已移到底部，横轴刻度之上）
    grid: { left: 58, right: 62, top: 14, bottom: 44 },
    tooltip: {
      ...glassTooltip(),
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0];
        if (!p) return "";
        const pt = points[p.dataIndex];
        if (!pt) return "";
        const rows = [
          { label: "总 Token", value: fmtK(pt.tokens) },
          { label: "总请求数", value: fmtInt(pt.req) + " 次" },
        ];
        return tooltipCard(pt.label, rows);
      },
    },
    legend: {
      bottom: 0,
      left: "center",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 18,
      textStyle: { color: textColor, fontSize: 10.5 },
      data: ["总 Token", "总请求数"],
    },
    xAxis: {
      type: "category",
      data: points.map((p) => (props.granularity === "hour" ? p.label.slice(11) : p.label.slice(5))),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    // 左轴：总 Token
    yAxis: [
      {
        type: "value",
        axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => fmtK(v) },
        splitLine: { lineStyle: { color: gridColor } },
      },
      // 右轴：总请求数（splitLine 关掉免得两套横线叠在一起）
      {
        type: "value",
        axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => fmtK(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "总 Token",
        type: "line",
        yAxisIndex: 0,
        data: points.map((p) => p.tokens),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        showSymbol: points.length <= 60,
        lineStyle: { width: 2.1, color: accent },
        itemStyle: { color: accent },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent + "3d" },
            { offset: 1, color: accent + "00" },
          ]),
        },
        label: {
          show: showLabel,
          position: "top",
          fontSize: 9.5,
          color: textColor,
          formatter: (p: { value?: number | string }) => fmtK(Number(p.value) || 0),
        },
      },
      {
        name: "总请求数",
        type: "line",
        yAxisIndex: 1,
        data: points.map((p) => p.req),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        showSymbol: points.length <= 60,
        lineStyle: { width: 2.1, color: info },
        itemStyle: { color: info },
        label: {
          show: showLabel,
          position: "bottom",
          fontSize: 9.5,
          color: textColor,
          formatter: (p: { value?: number | string }) => fmtK(Number(p.value) || 0),
        },
      },
    ],
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

watch(() => props.points, () => nextTick(render), { deep: true });
watch(() => props.granularity, () => nextTick(render));
watch(() => ui.isDark, () => nextTick(render));
</script>

<template>
  <div class="trend-chart" ref="el"></div>
</template>

<style scoped>
.trend-chart {
  width: 100%;
  height: 260px;
}
</style>
