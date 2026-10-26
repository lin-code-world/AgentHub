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
<!-- 左栏双卡片：上 = 品牌 + 模块入口；下 = 当前模块的总览概况
     概况数据全部来自真实统计：proxy 走号池/Keys/网关状态
     版本 / 署名 / GitHub / 亮暗 / 设置入口统一收在最左下角 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import { fmtBalance, balanceUnit } from "../views/proxy/format";
import { isUnusableChannel } from "../views/proxy/channelHealth";
import type { ModuleKey } from "../types";
import * as api from "../api/ipc";
import { coalesceAsync } from "../utils/timing";
import { toast } from "../utils/toast";
import ProxyUpstreamDialog from "./ProxyUpstreamDialog.vue";
import logoUrl from "../assets/logo.png";

const app = useAppStore();
const gwBusy = ref(false);

/** 网关服务开关（覆盖在反代网关卡右上角）：启停 + 状态经 proxy status 事件回流 */
async function toggleGw() {
  if (gwBusy.value) return;
  gwBusy.value = true;
  const wasRunning = proxyRunning.value;
  proxyRunning.value = !wasRunning; // 乐观更新先行，失败回弹
  try {
    const r = wasRunning ? await api.proxyStop() : await api.proxyStart();
    if (r && (r as { ok?: boolean }).ok === false) {
      proxyRunning.value = wasRunning;
      toast.error((r as { message?: string }).message || "操作失败");
    } else {
      app.config.proxy.restoreOnLaunch = !wasRunning; // 后端已落盘，同步内存里的配置让配置页开关跟手
      toast.success(wasRunning ? "网关服务已停止" : "网关服务已启动");
    }
  } catch (e) {
    proxyRunning.value = wasRunning;
    toast.error(String((e as Error).message || e));
  } finally {
    gwBusy.value = false;
  }
}

// 事件合流：poolsync/credits 事件密集到达时，
// 侧栏卡片的刷新被合并成有节制的几次，不再逐事件打 IPC（事件风暴 → IPC 风暴）
const scheduleProxyRefresh = coalesceAsync(() => Promise.all([refreshProxyMeta(), refreshChannels()]), 800);

function refreshStatsForEnabled() {
  refreshProxyMeta();
  refreshChannels();
}
onMounted(async () => {
  refreshStatsForEnabled();
  // 网关启停/号池同步都经 app:event 广播：侧栏卡片只订阅不轮询。
  // 原来只在切模块时刷一次，本模块内点「启动服务」后卡片会一直停在「网关未启动」
  offProxyEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "proxy" && (p.type === "status" || p.type === "poolsync" || p.type === "credits")) {
      scheduleProxyRefresh();
      return;
    }
  });
});
let offProxyEvent: (() => void) | undefined;
onUnmounted(() => {
  if (offProxyEvent) offProxyEvent();
  scheduleProxyRefresh.cancel();
});
// 切模块时刷新对应板块的实时统计（号池可能刚被同步）
watch(
  () => app.activeModule,
  (m) => {
    if (m === "proxy") {
      refreshChannels();
      refreshProxyMeta();
    }
  }
);

// ===== 反代网关 · 网关状态 + Key 数（真实） =====
const proxyRunning = ref(false);
const proxyKeyCount = ref(0);
async function refreshProxyMeta() {
  try {
    const st = await api.proxyStatus();
    proxyRunning.value = !!st.running;
    proxyKeyCount.value = st.keyCount ?? 0;
  } catch {
    /* 保留旧值 */
  }
}

// ===== 模块卡片的统计（全部真实数据，无 mock）；开关状态由覆盖在卡片右上角的 switch 表达 =====
const MODULE_META = computed<Record<ModuleKey, { stats: { v: string; label: string; unit?: string }[] }>>(() => {
  return {
    proxy: {
      stats: [
        { v: String(app.config.proxy.port), label: "端口" },
        { v: String(proxyKeyCount.value), label: "Key", unit: "个" },
        { v: channels.value.length ? String(channels.value.length) : "-", label: "已启用上游", unit: "个" },
      ],
    },
  };
});

// 反代网关 · 渠道额度（真实数据：号池各渠道的积分余量与可用账号；渠道增减自动跟进）
type ProxyChannelRow = {
  id: string;
  display: string;
  summary: { totalCredits: number; accountCount: number; onlineCount: number; earliestExpire: number; expiringSoon: boolean };
};
const channels = ref<ProxyChannelRow[]>([]);
async function refreshChannels() {
  // 后端抛错时 ipc.cjs 的 handle 会收口成 { ok:false, message }（不是 rejected）——
  // 不做数组兜底的话这个对象会污染 channels，之后 visibleChannels 的 filter 每次渲染都抛错，
  // 整个侧栏的 DOM 更新从此卡死（开关切换等一切状态变化在界面上失效）。空数组走空态文案。
  const rows = await api.proxyPool().catch(() => null);
  channels.value = Array.isArray(rows) ? rows : [];
}
// 死渠道（有号已过期 且 在线余额合计 0）不占侧栏那一行：它们不可用却和可用渠道长得一样，
// 渠道一多就把真正要看的挤下去。判据落在 channelHealth.ts 里，理由是那条规则错了会静默藏号。
const visibleChannels = computed(() => {
  const now = Date.now();
  return channels.value.filter((c) => !isUnusableChannel(c.summary, now));
});
const fmtDay = (ts: number) => {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 上游启闭弹窗（渠道级开关：关闭的渠道在反代网关全部页面动态隐藏）
const upOpen = ref(false);

// ===== 下卡片：模块总览概况（标题 / 提示全部接真实统计） =====
const OVERVIEW = computed<Record<ModuleKey, { title: string; hint: string }>>(() => ({
  proxy: { title: "渠道额度", hint: visibleChannels.value.length ? `${visibleChannels.value.length} 个渠道` : "渠道" },
}));
</script>

<template>
  <aside class="side-col">
    <!-- 上卡片：品牌 + 模块切换 -->
    <div class="side glass">
      <div class="brand">
        <img class="brand-mark" :src="logoUrl" alt="AgentApiGateway" />
        <div class="brand-txt">
          <div class="brand-name">AgentApiGateway</div>
          <div class="brand-sub">反代网关</div>
        </div>
      </div>

      <nav class="modules">
        <div
          v-for="mod in app.orderedModules"
          :key="mod.key"
          class="module-card"
          :class="{ active: app.activeModule === mod.key }"
          @click="app.selectModule(mod.key)"
        >
          <!-- 服务开关（右）+ 上游启闭（左）：第一行两端对齐 -->
          <div class="mc-actions">
            <!-- 上游启闭（仅反代网关卡）：渠道级开关入口，弹窗内各渠道图标 + 名称 + 开关 -->
            <el-tooltip v-if="mod.key === 'proxy'" content="上游启闭：控制各渠道在反代网关中的启用与可见" placement="top">
              <button class="mc-up-btn" @click.stop="upOpen = true">
                <i class="ph ph-plugs-connected"></i>上游启闭
              </button>
            </el-tooltip>
            <!-- 网关服务开关（stop 与卡片点击互不影响） -->
            <div
              v-if="mod.key === 'proxy'"
              class="switch mc-gw-switch"
              :class="{ on: proxyRunning, busy: gwBusy }"
              role="switch"
              :aria-checked="proxyRunning"
              :title="proxyRunning ? '点击停止网关服务' : '点击启动网关服务'"
              @click.stop="toggleGw()"
            >
              <span class="mc-gw-switch-text">{{ gwBusy ? "切换中…" : proxyRunning ? "服务开" : "服务关" }}</span>
            </div>
          </div>
          <div class="mc-stats">
            <div v-for="s in MODULE_META[mod.key].stats" :key="s.label" class="mc-stat">
              <b>{{ s.v }}<span v-if="s.unit" class="mc-unit">{{ s.unit }}</span></b><span>{{ s.label }}</span>
            </div>
          </div>
        </div>
      </nav>
    </div>

    <!-- 下卡片：当前模块的总览概况 + 左下角全局操作 -->
    <div class="side-overview glass">
      <div class="ov-head">
        <span class="ov-title">{{ OVERVIEW[app.activeModule].title }}</span>
        <span class="ov-hint">{{ OVERVIEW[app.activeModule].hint }}</span>
      </div>
      <div class="ov-body">
        <!-- 反代网关：渠道额度（号池实时数据，渠道增减自动跟进）。
             注意：这里不能用 <template> 做分组——无指令的 template 会被 Vue 编译成不渲染的
             惰性 fragment（内容进 content 文档片段），整个渠道列表会凭空消失 -->
        <div v-for="c in visibleChannels" :key="c.id" class="ov-row">
          <div class="grow">
            <div class="ov-name">
              {{ c.display }}<span v-if="c.summary.expiringSoon" class="ov-tag warn">即将到期</span>
            </div>
            <div class="ov-meta">
              {{ c.summary.accountCount ? `${c.summary.onlineCount}/${c.summary.accountCount} 可用` : "空号池" }}
            </div>
            <div v-if="c.summary.earliestExpire" class="ov-meta">最早到期 {{ fmtDay(c.summary.earliestExpire) }}</div>
          </div>
          <b class="ov-num">{{ fmtBalance(c.summary.totalCredits, c.id) }}<span class="ov-unit">{{ balanceUnit(c.id) }}</span></b>
        </div>
        <div v-if="!visibleChannels.length" class="ov-row">
          <div class="grow"><div class="ov-meta">{{ channels.length ? "无可用余额渠道（已过期或额度耗尽）" : "号池尚未接入或加载中" }}</div></div>
        </div>
      </div>

      <!-- 左下角全局操作：亮暗 / 设置（侧栏收缩入口统一在页签条最左） -->
      <div class="side-foot">
        <el-tooltip content="切换亮暗主题" placement="top">
          <button class="btn btn-ghost" @click="app.toggleTheme()">
            <i class="ph" :class="app.isDark ? 'ph-moon' : 'ph-sun'"></i>
          </button>
        </el-tooltip>
        <el-tooltip content="设置" placement="top">
          <button class="btn btn-ghost settings-btn" @click="app.openSettings('general')">
            <i class="ph ph-gear-six"></i>
          </button>
        </el-tooltip>
      </div>
    </div>

    <!-- 上游启闭弹窗（渠道级开关）：关闭的渠道在反代网关全部页面动态隐藏，重新打开立即恢复 -->
    <ProxyUpstreamDialog :open="upOpen" @close="upOpen = false" />
  </aside>
</template>

<style scoped>
/* 左栏外层：上下双卡片列。极矮窗口（浏览器预览等无缩放兜底时）整体可滚 */
.side-col {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--gap-shell);
  min-height: 0;
  overflow-y: auto;
}
.side-col::-webkit-scrollbar {
  width: 4px;
}

/* ===== 上卡片：品牌 + 模块切换 ===== */
.side {
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 18px 12px 12px;
  overflow: hidden;
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 16px;
}
.brand-mark {
  width: 33px;
  height: 33px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
  object-fit: cover;
  display: block;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.brand-txt {
  flex: 1;
  line-height: 1.2;
}
.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.brand-sub {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 1px;
}
/* 左下角的图标按钮用项目统一按钮（.btn.btn-ghost），这里只管图标字号与呼吸间距 */
.side-foot .ph {
  font-size: 15px;
}
/* 设置齿轮：承载「有更新」红点的定位上下文（红点样式见 global.css 的 .dot-ping） */
.side-foot .settings-btn {
  position: relative;
}

/* 模块卡片（顺序自定义入口在「设置 · 通用」，支持拖拽排序） */
.modules {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.module-card {
  border-radius: var(--r-ctl);
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.025);
  padding: 14px 14px 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s var(--ease), border-color 0.2s, transform 0.15s;
}
/* 已停用板块（issue #91）：低对比置灰、禁用指针交互反馈，右上角「已停用」角标 */
.module-card.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  filter: grayscale(0.6);
}
.module-card.disabled:hover { background: rgba(255, 255, 255, 0.025); }
.module-card.disabled:active { transform: none; }
.module-card.disabled::after { display: none; }
.mc-off {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 4px;
  padding: 2px 5px;
}
:root[data-theme="light"] .module-card {
  background: rgba(15, 23, 42, 0.02);
}
.module-card:hover {
  background: rgba(255, 255, 255, 0.05);
  transform: translateY(-1px);
}
:root[data-theme="light"] .module-card:hover {
  background: rgba(15, 23, 42, 0.045);
}
.module-card:active {
  transform: scale(0.985);
}
/* 悬停聚光（--mx/--my 由 App.vue 全局委托写入；::before 已被激活指示条占用） */
.module-card::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), var(--spot-wash), transparent 65%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.module-card:hover::after {
  opacity: 1;
}
.module-card.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.module-card.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: var(--r-pill);
  background: var(--accent);
}
/* 激活指示条呼吸：明暗缓慢起伏 */
@media (prefers-reduced-motion: no-preference) {
  .module-card.active::before {
    animation: barBreathe 3s ease-in-out infinite;
  }
  @keyframes barBreathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
}
/* ===== 反代网关卡内容区：顶部操作行（上游启闭 | 服务开关）+ 三列统计 ===== */
.mc-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.mc-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
/* 网关服务开关（文档流内，操作行右侧；scoped 覆盖全局 40×22 的 .switch：64 宽，滑块行程 44px）
   关 = 滑块在左、文案「服务关」靠右；开 = 滑块在右、文案「服务开」靠左（绿底深字） */
.mc-gw-switch {
  width: 64px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 5px;
  box-sizing: border-box;
}
.mc-gw-switch.on {
  justify-content: flex-start;
}
.mc-gw-switch.on::after {
  transform: translateX(44px);
}
.mc-gw-switch-text {
  font-size: 9.5px;
  font-weight: 600;
  color: #e07f44; /* 关态：橙色调，与服务开/关的提示语义呼应 */
  user-select: none;
  line-height: 1;
}
.mc-gw-switch.on .mc-gw-switch-text {
  color: #06130b; /* 开态：主题绿底上用深色字，对比清晰 */
}
.mc-gw-switch.busy {
  opacity: 0.5;
  pointer-events: none;
}
/* 单个统计列：数字行 + 标签行纵向排布，行高锁定后各列基线天然对齐 */
.mc-stat {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mc-stat b {
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.module-card.active .mc-stat b {
  color: var(--accent-strong);
}
/* 数字后的弱化单位（台/个/条）：与数字基线对齐（flex baseline），不随字高浮动 */
.mc-unit {
  font-size: 9px;
  font-weight: 500;
  color: var(--text-3);
  font-family: var(--font-ui);
}
.mc-stat span {
  display: block;
  margin-top: 3px;
  font-size: 9.5px;
  line-height: 1.2;
  color: var(--text-3);
}
/* 上游启闭小按钮（仅反代网关卡）：操作行内靠右，绿色描边常态，悬停点亮加深 */
.mc-up-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: transparent;
  color: var(--text-2);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.mc-up-btn .ph {
  font-size: 10px;
}
.mc-up-btn:hover {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
  background: var(--accent-dim);
}
/* 左下角全局操作条（概况卡底部，常驻可见） */
.side-foot {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding: 10px 4px 2px;
  display: flex;
  align-items: center;
  justify-content: flex-end; /* 全部操作按钮居右 */
  gap: 6px;
  flex-shrink: 0;
}
.foot-ver {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
}
.foot-author {
  font-size: 10px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 4px;
}
.foot-author .ph {
  font-size: 11px;
}
.foot-author b {
  color: var(--text-2);
  font-weight: 600;
}

/* ===== 下卡片：模块总览概况 ===== */
.side-overview {
  flex: 1;
  /* 高度下限：保证标题 / 底部操作条常驻，再矮就交给 side-col 滚动 */
  min-height: 150px;
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 12px 12px 10px;
  overflow: hidden;
}
.ov-head {
  display: flex;
  align-items: center;
  padding: 2px 8px 8px;
  flex-shrink: 0;
}
.ov-title {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  font-weight: 600;
  color: var(--text-3);
}
.ov-hint {
  margin-left: auto;
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-3);
}
.ov-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 2px;
  display: flex;
  flex-direction: column;
}
.ov-body::-webkit-scrollbar {
  width: 4px;
}
.ov-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  border-radius: var(--r-sm);
  font-size: 12px;
}
/* 悬停底色只给未选中行：亮色主题下这条选择器权重更高，会盖掉选中高亮 */
.ov-row:not(.selected):hover {
  background: rgba(255, 255, 255, 0.035);
}
:root[data-theme="light"] .ov-row:not(.selected):hover {
  background: rgba(15, 23, 42, 0.03);
}
.ov-row + .ov-row {
  border-top: 1px solid var(--line);
}
.ov-row .grow {
  flex: 1;
  min-width: 0;
}
.ov-name {
  font-weight: 550;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-meta {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-num {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}
/* 渠道额度数字后的单位（积分/Tokens/Credits）：弱化小字，与号池页两段式同构 */
.ov-unit {
  font-size: 9px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 3px;
  font-family: var(--font-ui);
}
.ov-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
  margin-left: 5px;
}
.ov-tag.warn {
  background: var(--warn-dim);
  color: var(--warn);
}
/* 可选中行（「全部电脑」与各设备行共用同一套指针/过渡/选中高亮，样式完全一致） */
.ov-pick {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.ov-pick.selected {
  background: var(--accent-dim);
}
/* 设备行：在可选中行之上叠加左滑删除手势（行体左移，露出右侧删除按钮） */
.ov-device {
  position: relative;
  touch-action: pan-y; /* 纵向滚动不受影响，横向拖动才是删除手势 */
  transition: transform 0.18s var(--ease), background 0.15s;
}
.ov-device .ov-del {
  position: absolute;
  right: -56px;
  top: 0;
  bottom: 0;
  width: 52px;
  border: none;
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.ov-device.swiped .ov-del,
.ov-device:active .ov-del {
  opacity: 1;
}
/* 行容器不能裁掉左移露出的删除按钮以外的部分：删掉行间距分割线错位即可 */
.ov-body {
  overflow-x: clip;
}

/* 设备在线圆点（在线涟漪，离线置灰静止） */
.ov-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  position: relative;
  flex-shrink: 0;
}
.ov-dot.off {
  background: var(--text-3);
  box-shadow: none;
}
.ov-dot::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1px solid var(--accent);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ov-dot:not(.off)::after {
    animation: ovDotRipple 2.4s var(--ease) infinite;
  }
  @keyframes ovDotRipple {
    from {
      transform: scale(1);
      opacity: 0.7;
    }
    to {
      transform: scale(3);
      opacity: 0;
    }
  }
}
</style>
