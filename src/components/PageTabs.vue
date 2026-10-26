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
<!-- 主区顶部横条卡片：当前模块的子页面切换（条超宽时可横向滚动）。
     右侧「配置」按钮与左侧 tab 是同一套页面切换逻辑：切到当前模块的配置页（id=config），
     配置页内子板块的二级 tab 由配置页自己渲染，不占这里的位置。
     页签右上角红点 = 该页有「待你处理」的东西（待裁决冲突 / 待确认裁决 / 索引不一致），
     没有待处理项时红点自动消失，不占位置提示不需要的文字 -->
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import * as api from "../api/ipc";
import { activeTargetName, refreshRemoteState, remoteActive, remoteState } from "../api/remote";
import { toast } from "../utils/toast";

const app = useAppStore();
const scrollEl = ref<HTMLElement | null>(null);

// ===== 网关服务开关（常驻导航栏右侧）：状态 / 启停 / 端口号展示 =====
const gwRunning = ref(false);
const gwBusy = ref(false);

async function refreshGw() {
  try {
    const s = await api.proxyStatus();
    gwRunning.value = !!s.running;
  } catch { /* 浏览器预览走 mock / 拉不到保留旧值 */ }
}

async function toggleGw() {
  if (gwBusy.value) return;
  gwBusy.value = true;
  const wasRunning = gwRunning.value;
  // 乐观更新先行：开关立即切到目标态（后端 stop/start 同步翻转 running，
  // 返回即代表已生效）；真实状态随后由 proxy status 事件回流纠偏
  gwRunning.value = !wasRunning;
  try {
    const r = wasRunning ? await api.proxyStop() : await api.proxyStart();
    if (r && (r as { ok?: boolean }).ok === false) {
      gwRunning.value = wasRunning; // 后端拒绝：回弹
      toast.error((r as { message?: string }).message || "操作失败");
    } else {
      app.config.proxy.restoreOnLaunch = !wasRunning; // 后端已落盘，同步内存里的配置让配置页开关跟手
      toast.success(wasRunning ? "网关服务已停止" : "网关服务已启动");
    }
  } catch (e) {
    gwRunning.value = wasRunning; // 调用异常：回弹
    toast.error(String((e as Error).message || e));
  } finally {
    gwBusy.value = false;
  }
}

/** 页签待处理红点：当前无动态数据源（原记忆中枢红点已随模块移除），保留结构备用 */
function pendingCount(pageId: string): number {
  return 0;
}

// 左右边缘渐隐提示还有内容可滚；条不超宽时两端贴边、无渐隐
function updateFades() {
  const el = scrollEl.value;
  if (!el) return;
  el.classList.toggle("fade-l", el.scrollLeft > 4);
  el.classList.toggle("fade-r", el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
}

// 纵向滚轮转横向滚动：tab 条超宽时免按 Shift
function onWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
}

// 切换模块后回到条头
watch(
  () => app.activeModule,
  () =>
    nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollLeft = 0;
      updateFades();
    })
);
/** 反代模块的操作目标（本机 / 远程实例）：切换后整页重载换源——所有页面的数据必须一起换 */
async function onRemoteCommand(cmd: string | number) {
  const id = String(cmd);
  if (id === "manage") {
    app.openModuleConfig();
    return;
  }
  if (id === remoteState.activeId) return;
  try {
    await api.remoteTargetsActivate(id);
    await refreshRemoteState();
    toast.success(id === "local" ? "已切回本机，页面即将刷新" : "已切到远程实例，页面即将刷新");
    setTimeout(() => window.location.reload(), 400);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

onMounted(() => {
  updateFades();
  refreshGw();
  // 网关状态变化（本页开关 / 后端自启）经事件回流，开关即时跟上
  api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "proxy" && p.type === "status") refreshGw();
  });
});
</script>

<template>
  <nav class="tabs glass">
    <div ref="scrollEl" class="tabs-scroll" @scroll.passive="updateFades" @wheel="onWheel">
      <button
        v-for="p in app.pagesOf"
        :key="p.id"
        class="tab"
        :class="{ active: app.activePage === p.id }"
        @click="app.setPage(p.id)"
      >
        {{ p.name }}
        <el-tooltip v-if="pendingCount(p.id)" :content="`${pendingCount(p.id)} 项待处理`" placement="top">
          <span class="tab-dot"></span>
        </el-tooltip>
      </button>
    </div>
    <!-- 反代模块的操作目标：本机 / 远程实例。远程时其它反代页也在操作远程，故放在全局可见处；
         没配过远程实例时不出现，不占位 -->
    <el-dropdown
      v-if="app.activeModule === 'proxy' && remoteState.targets.length"
      trigger="click"
      @command="onRemoteCommand"
    >
      <button class="tab tab-remote" :class="{ 'remote-on': remoteActive() }">
        <i class="ph" :class="remoteActive() ? 'ph-cloud-check' : 'ph-desktop'"></i>{{ activeTargetName() }}
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="local" :disabled="remoteState.activeId === 'local'">本机</el-dropdown-item>
          <el-dropdown-item
            v-for="t in remoteState.targets"
            :key="t.id"
            :command="t.id"
            :disabled="remoteState.activeId === t.id"
          >
            {{ t.alias }}
          </el-dropdown-item>
          <el-dropdown-item divided command="manage">管理远程实例…</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <!-- 网关服务开关 + 端口号：常驻在配置入口左边，不随 tab 条横向滚动 -->
    <div class="gw-ctl">
      <span class="gw-label">网关端口</span>
      <span class="gw-port" :title="`网关监听 ${app.config.proxy.bind}:${app.config.proxy.port}`">{{ app.config.proxy.port }}</span>
      <div
        class="switch gw-switch"
        :class="{ on: gwRunning, busy: gwBusy }"
        role="switch"
        :aria-checked="gwRunning"
        @click="toggleGw()"
      >
        <span class="gw-switch-text">{{ gwRunning ? "服务开" : "服务关" }}</span>
      </div>
    </div>
    <!-- 右侧常驻入口：普通态进配置页，配置态「完成」回到来时页面；不随 tab 条横向滚动 -->
    <button v-if="app.activePage === 'config'" class="tab tab-config active" @click="app.closeModuleConfig()">
      <i class="ph ph-check"></i>完成
    </button>
    <button v-else class="tab tab-config" @click="app.openModuleConfig()">
      <i class="ph ph-gear-six"></i>配置
    </button>
  </nav>
</template>

<style scoped>
.tabs {
  grid-area: tabs;
  border-radius: var(--r-panel);
  display: flex;
  overflow: hidden;
  min-height: 46px;
}
.tabs-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  /* 滚动条隐藏，横移靠滚轮 / 触摸板；可滚方向用边缘渐隐提示 */
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.fade-l {
  mask-image: linear-gradient(to right, transparent, #000 20px);
}
.fade-r {
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
}
.fade-l.fade-r {
  mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent);
}

.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: var(--ctl-h);
  padding: 0 14px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 550;
  line-height: 1;
  font-family: var(--font-ui);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.tab .ph {
  font-size: 14px;
}
.tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}
:root[data-theme="light"] .tab:hover {
  background: rgba(15, 23, 42, 0.045);
}
.tab.active {
  color: var(--accent-strong);
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.tab:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 2px;
}
.tab-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-3);
}
:root[data-theme="light"] .tab-badge {
  background: rgba(15, 23, 42, 0.06);
}
.tab.active .tab-badge {
  background: rgba(68, 224, 127, 0.18);
  color: var(--accent-strong);
}

/* 待处理红点：贴在页签右上角，只有「真的有东西等你处理」时才出现 */
.tab-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 2px var(--glass-a);
}
.tab.active .tab-dot {
  box-shadow: 0 0 0 2px var(--accent-dim);
}

/* 反代模块的操作目标（本机 / 远程实例）：常驻在配置入口左边，不随 tab 条滚动 */
.tab-remote {
  margin: 6px 0 6px 2px;
  border-left: 1px solid var(--line);
  border-radius: 0;
  padding-left: 12px;
}
.tab-remote.remote-on {
  color: var(--accent-strong);
}

/* 网关服务开关 + 端口号：常驻在配置入口左边，不随 tab 条横向滚动 */
.gw-ctl {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 6px 2px;
  padding: 0 12px;
  border-left: 1px solid var(--line);
}
.gw-label {
  font-size: 12px;
  font-weight: 550;
  color: var(--text-2);
  white-space: nowrap;
}
.gw-port {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  cursor: default;
}
/* 加宽的带文案开关：关 = 滑块在左、文案「服务关」靠右；开 = 滑块在右、文案「服务开」靠左
   （scoped 覆盖全局 40×22 的 .switch：64 宽，滑块行程 44px） */
.gw-switch {
  width: 64px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 5px;
  box-sizing: border-box;
}
.gw-switch.on {
  justify-content: flex-start;
}
.gw-switch.on::after {
  transform: translateX(44px);
}
.gw-switch-text {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-3);
  user-select: none;
  line-height: 1;
}
.gw-switch.on .gw-switch-text {
  color: #06130b;
}
.gw-ctl .switch {
  flex-shrink: 0;
}
.gw-ctl .switch.busy {
  opacity: 0.5;
  pointer-events: none;
}

/* 右侧常驻入口：不随 tab 条横向滚动，左边留一道分隔线 */
.tab-config {
  flex-shrink: 0;
  margin: 6px 10px 6px 2px;
  border-left: 1px solid var(--line);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  padding-left: 12px;
}
</style>
