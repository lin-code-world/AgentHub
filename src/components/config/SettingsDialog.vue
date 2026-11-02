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
<!-- 全局设置弹窗：右上角设置按钮打开。通用 / 监控与安全 / 局域网访问 / 反代网关四块，
     左列模块按钮点击切换，右侧内容定高滚动（弹窗大小固定，不随内容长高）；
     反代网关的配置就在「反代网关」板块内，其余配置各自成板块 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { SETTINGS_TABS } from "../../types";
import { isWebTransport } from "../../api/caps";
import ConfigGeneralSection from "./ConfigGeneralSection.vue";
import ConfigTimingSection from "./ConfigTimingSection.vue";
import ConfigLanSection from "./ConfigLanSection.vue";
import ConfigProxySection from "./ConfigProxySection.vue";

const app = useAppStore();

/** Web 托管形态：通用 / 局域网访问不可用（通用依赖整份配置读写，局域网访问的令牌操作被服务端 deny），
 *  只留「监控与安全 + 反代网关」——两者都在反代段，走 proxy_config_get / proxy_config_save 读写 */
const tabs = computed(() => (isWebTransport() ? SETTINGS_TABS.filter((t) => t.key === "timing" || t.key === "proxy") : SETTINGS_TABS));

/** 模块懒挂载：首次切到才挂载（配置拉取 / 状态探测不白跑），之后 v-show 保活 */
const visited = ref<Record<string, boolean>>({});
watch(
  () => (app.settingsOpen ? app.settingsTab : ""),
  (t) => {
    if (t) visited.value[t] = true;
  },
  { immediate: true }
);

// 弹窗打开时确保 settingsTab 在可用 tabs 里：Web 托管形态只有「监控与安全 / 反代网关」，
// 若上次停在 general / lan（浏览器端不可用），落到第一个可用项，避免内容区显示不可用板块
watch(
  () => app.settingsOpen,
  (open) => {
    if (open && !tabs.value.some((t) => t.key === app.settingsTab)) {
      app.settingsTab = tabs.value[0].key;
    }
  },
  { immediate: true }
);
</script>

<template>
  <el-dialog v-model="app.settingsOpen" class="settings-dialog" width="1080px" align-center append-to-body>
    <template #header>
      <div>
        <div class="sd-title">设置</div>
        <div class="sd-sub">通用 · 监控与安全 · 局域网访问 · 反代网关</div>
      </div>
    </template>
    <div class="sd-layout">
      <div class="sd-nav">
        <button v-for="t in tabs" :key="t.key" class="sd-nav-btn" :class="{ active: app.settingsTab === t.key }" @click="app.settingsTab = t.key">
          <i class="ph" :class="t.icon"></i>
          <span class="sd-nav-txt">
            <b>{{ t.name }}</b>
            <small>{{ t.desc }}</small>
          </span>
        </button>
      </div>
      <div class="sd-scroll">
        <div v-if="visited.general" v-show="app.settingsTab === 'general'"><ConfigGeneralSection /></div>
        <div v-if="visited.timing" v-show="app.settingsTab === 'timing'"><ConfigTimingSection /></div>
        <div v-if="visited.lan" v-show="app.settingsTab === 'lan'"><ConfigLanSection /></div>
        <div v-if="visited.proxy" v-show="app.settingsTab === 'proxy'"><ConfigProxySection /></div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.sd-title {
  font-size: 15px;
  font-weight: 700;
}
.sd-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.settings-dialog {
  max-width: calc(100vw - 48px);
}
/* 弹窗体定高：左列按钮 + 右列内容都在这个高度里，内容超出由右列自己滚 */
.settings-dialog :deep(.el-dialog__body) {
  padding: 14px 16px 16px;
}
.sd-layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 14px;
  height: min(560px, calc(100vh - 200px));
}
.sd-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding: 2px;
  border-right: 1px solid var(--line);
}
.sd-nav-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-ui);
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.sd-nav-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}
:root[data-theme="light"] .sd-nav-btn:hover {
  background: rgba(15, 23, 42, 0.045);
}
.sd-nav-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
}
.sd-nav-btn > .ph {
  font-size: 16px;
  flex-shrink: 0;
}
.sd-nav-txt {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sd-nav-txt b {
  font-size: 12.5px;
  font-weight: 600;
}
.sd-nav-txt small {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-nav-btn.active .sd-nav-txt small {
  color: var(--accent-strong);
  opacity: 0.75;
}
/* 右列内容：定高内滚；cfg-sec 的纵向节奏在这里生效 */
.sd-scroll {
  min-width: 0;
  overflow-y: auto;
  padding: 2px 6px 2px 2px;
}
.sd-scroll::-webkit-scrollbar {
  width: 6px;
}
</style>
