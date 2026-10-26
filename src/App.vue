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
<!-- 沐晖制作：AgentHub 反代网关入口（纯静态界面，无装饰动效） -->
<script setup lang="ts">
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { ElConfigProvider } from "element-plus";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import PageTabs from "./components/PageTabs.vue";
import SettingsDialog from "./components/config/SettingsDialog.vue";
import ConfigProxySection from "./components/config/ConfigProxySection.vue";
import ProxyKeysView from "./views/proxy/ProxyKeysView.vue";
import ProxyProvidersView from "./views/proxy/ProxyProvidersView.vue";
import ProxyAgentsView from "./views/proxy/ProxyAgentsView.vue";
import ProxyExpiryView from "./views/proxy/ProxyExpiryView.vue";
import ProxyModelsView from "./views/proxy/ProxyModelsView.vue";
import ProxyStatsView from "./views/proxy/ProxyStatsView.vue";
import ProxyPoolSyncView from "./views/proxy/ProxyPoolSyncView.vue";
import ProxyLogView from "./views/proxy/ProxyLogView.vue";
import * as api from "./api/ipc";

const app = useAppStore();

let dispose: (() => void)[] = [];

onMounted(() => {
  app.load();
  // 更新事件全局唯一监听：main 侧托盘等直写配置后的广播（config-changed）→
  // 重拉内存快照，防设置页旧快照把新值冲掉
  const offConfigChanged = api.onUpdateEvent((e) => {
    if ((e as { event?: string }).event === "config-changed") {
      app.refreshConfig();
    }
  });
  if (offConfigChanged) dispose.push(offConfigChanged);
});
onUnmounted(() => {
  dispose.forEach((fn) => fn());
});

/** 当前是否停在某模块某页（v-show 条件） */
const on = (mod: string, page: string) => app.activeModule === mod && app.activePage === page;

/** 懒挂载：页面首次进入才挂载（数据加载走各自的 onMounted），之后 v-show 保活不切状态。
    避免启动时就把十几个页面的扫描/探测 IPC 全打一遍。
    首键要等 load() 定下启动板块再记：loaded 翻真前的初始默认值
    不能抢先挂载，否则启动板块不在第一个模块时它的仪表盘会被白白拉起一遍 */
const visited = ref<Record<string, boolean>>({});
watch(
  [() => app.loaded, () => `${app.activeModule}/${app.activePage}`],
  ([loaded, k]) => {
    if (loaded) {
      visited.value[k] = true;
      // 同一处顺带镜像「上次停留的页面」：轻量模式销毁界面后唤回时据此回到原处
      // （loaded 翻真前的默认值不记，否则会把恢复出来的真实位置冲掉）
      app.mirrorActivePage();
    }
  },
  { immediate: true }
);
const seen = (mod: string, page: string) => !!visited.value[`${mod}/${page}`];
</script>

<template>
  <el-config-provider :locale="zhCn">
  <!-- 全库唯一的 locale 注入点：按需注册后没有 app.use(ElementPlus, { locale }) 了，
       el-date-picker 面板的月份/星期等内置文案全靠这里，删掉会静默回退英文。
       provider 自身不渲染 DOM 节点（config-provider 直接 renderSlot default），
       包一层不改变结构与 .app 的背景层叠。 -->
  <div class="app">
    <Sidebar />
    <PageTabs />
    <main class="main glass">
      <div class="pages">
        <ProxyKeysView v-if="seen('proxy', 'keys')" v-show="on('proxy', 'keys')" />
        <ProxyProvidersView v-if="seen('proxy', 'providers')" v-show="on('proxy', 'providers')" />
        <ProxyAgentsView v-if="seen('proxy', 'agents')" v-show="on('proxy', 'agents')" />
        <ProxyExpiryView v-if="seen('proxy', 'expiry')" v-show="on('proxy', 'expiry')" />
        <ProxyModelsView v-if="seen('proxy', 'models')" v-show="on('proxy', 'models')" />
        <ProxyStatsView v-if="seen('proxy', 'stats')" v-show="on('proxy', 'stats')" />
        <ProxyPoolSyncView v-if="seen('proxy', 'poolsync')" v-show="on('proxy', 'poolsync')" />
        <ProxyLogView v-if="seen('proxy', 'proxylog')" v-show="on('proxy', 'proxylog')" />
        <!-- 各模块的配置页：右上「配置」按钮切换到这里的页面（page + cfg-body 组合出页壳与留白）；
             配置页内部的二级子板块 tab 由各 section 自己渲染 -->
        <div v-if="seen('proxy', 'config')" v-show="on('proxy', 'config')" class="page cfg-body">
          <ConfigProxySection />
        </div>
      </div>
    </main>
    <!-- 常驻挂载：显隐交给 el-dialog 自己管 -->
    <SettingsDialog />
  </div>
  </el-config-provider>
</template>
