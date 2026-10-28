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
import { denyState, settingsUnavailable } from "../api/caps";
import { coalesceAsync } from "../utils/timing";
import { toast } from "../utils/toast";
import ProxyUpstreamDialog from "./ProxyUpstreamDialog.vue";
import logoUrl from "../assets/logo.png";
// 版本号唯一事实源 = 仓库根 package.json 的 version（与设置 · 通用里的展示同源）
import pkg from "../../package.json";

const app = useAppStore();
const version = `v${pkg.version}`;
const gwBusy = ref(false);
/** 网关启停门控：浏览器形态被服务端 deny 时置灰并展示下发原因，桌面（无 caps）不置灰 */
const gwGate = denyState("proxy_start", "proxy_stop");
/** 设置弹窗入口（左下角齿轮）在 Web 托管形态整体隐藏（I3）：通用 / 刷新周期都依赖整份配置读写，
 *  浏览器形态拿不到真值（load_config 被 deny，容器命令表只有 proxy_*），显示出来的只是前端默认值。
 *  不逐控件置灰——一整块「不可用」的表单只会误导；反代配置仍走「配置」页的 proxy_config_get/save */
const settingsHidden = settingsUnavailable();

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
      toast.success(wasRunning ? "网关服务已停止" : "网关服务已启动");
    }
  } catch (e) {
    proxyRunning.value = wasRunning;
    toast.error(String((e as Error).message || e));
  } finally {
    gwBusy.value = false;
  }
}

// 事件合流：credits 等事件密集到达时，
// 侧栏卡片的刷新被合并成有节制的几次，不再逐事件打 IPC（事件风暴 → IPC 风暴）
const scheduleProxyRefresh = coalesceAsync(() => Promise.all([refreshProxyMeta(), refreshChannels()]), 800);

function refreshStatsForEnabled() {
  refreshProxyMeta();
  refreshChannels();
}
onMounted(async () => {
  refreshStatsForEnabled();
  // Web 托管形态 load_config 被 deny，app.config.proxy.port 只是前端默认值，端口卡片会显示错值——
  // 用浏览器可用的 proxy_config_get 取一次真实端口写回去（失败静默，保留默认显示）
  if (settingsHidden) {
    api
      .proxyConfigGet()
      .then((cfg) => {
        if (cfg && typeof cfg.port === "number") app.config.proxy.port = cfg.port;
      })
      .catch(() => {});
  }
  // 网关启停等经 app:event 广播：侧栏卡片只订阅不轮询。
  // 原来只在切模块时刷一次，本模块内点「启动服务」后卡片会一直停在「网关未启动」
  offProxyEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "proxy" && (p.type === "status" || p.type === "credits" || p.type === "pool" || p.type === "resync")) {
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
const MODULE_META = computed<Record<ModuleKey, { stats: { v: string; label: string }[] }>>(() => {
  return {
    proxy: {
      stats: [
        { v: String(app.config.proxy.port), label: "端口" },
        { v: String(proxyKeyCount.value), label: "Key" },
        { v: channels.value.length ? String(channels.value.length) : "-", label: "上游" },
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
// 空号池（accountCount = 0，还没接入账号的渠道）同样不占行：侧栏只列「有号池」的渠道。
const visibleChannels = computed(() => {
  const now = Date.now();
  return channels.value.filter((c) => c.summary.accountCount > 0 && !isUnusableChannel(c.summary, now));
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
          <div class="brand-sub">反代网关 · {{ version }}</div>
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
            <!-- 网关服务开关（stop 与卡片点击互不影响）；浏览器形态被服务端 deny 时置灰并展示原因 -->
            <div
              v-if="mod.key === 'proxy'"
              class="switch mc-gw-switch"
              :class="{ on: proxyRunning, busy: gwBusy, disabled: gwGate.disabled }"
              role="switch"
              :aria-checked="proxyRunning"
              :aria-disabled="gwGate.disabled"
              :title="gwGate.disabled ? gwGate.reason || '' : proxyRunning ? '点击停止网关服务' : '点击启动网关服务'"
              @click.stop="!gwGate.disabled && toggleGw()"
            >
              <span class="mc-gw-switch-text">{{ gwBusy ? "切换中…" : proxyRunning ? "服务开" : "服务关" }}</span>
            </div>
          </div>
          <div class="mc-stats">
            <div v-for="s in MODULE_META[mod.key].stats" :key="s.label" class="mc-stat">
              <span>{{ s.label }}</span><b>{{ s.v }}</b>
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
        <!-- 主题切换：浏览器形态拿不到整份配置读写（save_config 被 deny），主题改了也记不住——
             切换入口隐藏为禁用态，tooltip 指到桌面窗口改（桌面不受影响） -->
        <el-tooltip :content="settingsHidden ? '请在桌面窗口修改主题' : '切换亮暗主题'" placement="top">
          <!-- disabled 按钮不派发鼠标事件，tooltip 要弹原因得垫一层 span（同 ConfigLanSection 的做法） -->
          <span>
            <button class="btn btn-ghost" :disabled="settingsHidden" @click="!settingsHidden && app.toggleTheme()">
              <i class="ph" :class="app.isDark ? 'ph-moon' : 'ph-sun'"></i>
            </button>
          </span>
        </el-tooltip>
        <el-tooltip v-if="!settingsHidden" content="设置" placement="top">
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
  margin-top: 8px;
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
  padding: 16px 16px 14px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s var(--ease), border-color 0.2s, transform 0.15s;
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
/* 性能：激活指示条的呼吸动画已移除（位于玻璃面板内，每帧触发父级 backdrop-filter 重新模糊） */
/* ===== 反代网关卡内容区：顶部操作行（上游启闭 | 服务开关）+ 三列统计 ===== */
.mc-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
}
.mc-stats {
  display: flex;
  justify-content: space-between;
}
/* 网关服务开关（文档流内，操作行右侧；scoped 覆盖全局 40×22 的 .switch：78 宽，滑块行程 58px）
   关 = 滑块在左、文案「服务关」靠右；开 = 滑块在右、文案「服务开」靠左（绿底深字） */
.mc-gw-switch {
  width: 78px;
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
  transform: translateX(58px);
}
.mc-gw-switch-text {
  font-size: 12px;
  font-weight: 600;
  color: #e07f44; /* 关态：橙色调，与服务开/关的提示语义呼应 */
  user-select: none;
  line-height: 1;
}
.mc-gw-switch.on .mc-gw-switch-text {
  color: #06130b; /* 开态：亮绿底上深色字对比最高（橙色在绿底对比不足） */
}
.mc-gw-switch.busy {
  opacity: 0.5;
  pointer-events: none;
}
/* 浏览器形态被服务端 deny：置灰不可点；刻意不关 pointer-events，hover 的 title 要能展示原因 */
.mc-gw-switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 单个统计列：标签行 + 数字行纵向排布，行高锁定后各列基线天然对齐 */
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
  font-size: 19px;
  font-weight: 600;
  color: var(--text);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.module-card.active .mc-stat b {
  color: var(--accent-strong);
}
.mc-stat span {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--text-3);
}
/* 上游启闭小按钮（仅反代网关卡）：操作行内靠右，绿色描边常态，悬停点亮加深 */
.mc-up-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.mc-up-btn .ph {
  font-size: 14px;
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
/* 性能：在线状态点的波纹动画已移除（同上，避免持续触发父级玻璃面板合成） */
</style>
