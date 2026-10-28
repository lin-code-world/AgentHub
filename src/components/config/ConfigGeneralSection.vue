<!-- 设置弹窗 · 通用：外观（主题）+ 应用行为（自启 / 托盘）+ 关于
     网关的操作设置在反代网关右上「配置」按钮切换的配置页里 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { denyState } from "../../api/caps";
// 版本号唯一事实源 = 仓库根 package.json 的 version（Electron 打包态 app.getVersion 同源）
import pkg from "../../../package.json";

const app = useAppStore();
const version = `v${pkg.version}`;
const dataDir = ref("");
const isPortable = ref(false);
/** 「打开目录」门控：浏览器形态服务端 deny 时置灰 + 展示下发原因，桌面（无 caps）不置灰 */
const dataDirGate = denyState("open_data_dir");

/** 仅在设置弹窗 · 通用可见时刷新数据（数据目录保持最新） */
const active = computed(() => app.settingsOpen && app.settingsTab === "general");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

async function refresh() {
  try {
    dataDir.value = await api.getDataDir();
  } catch {
    /* 浏览器预览无数据目录 */
  }
  try {
    isPortable.value = await api.getIsPortable();
  } catch {
    /* 浏览器预览走 mock */
  }
}

/** 应用行为开关（自启 / 托盘）：v-model 已改框架配置，这里只管落盘；
    save_config 后端会 applyAutoStart，开机自启即时生效，托盘行为关窗时实时读盘 */
async function toggleAppBehavior() {
  await app.save();
}

/** 外观切换（与左栏亮暗按钮同源） */
function setTheme(v: string | number | boolean | undefined) {
  if (v === "dark" || v === "light") app.setTheme(v);
}

async function openDataDir() {
  try {
    await api.openDataDir();
  } catch {
    /* 浏览器预览无此能力 */
  }
}
</script>

<template>
  <div class="cfg-sec">
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">外观</div>
          <div class="set-desc">深色 / 浅色主题，即时生效并记住</div>
        </div>
        <el-radio-group :model-value="app.isDark ? 'dark' : 'light'" @update:model-value="setTheme">
          <el-radio-button value="dark">深色</el-radio-button>
          <el-radio-button value="light">浅色</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">开机自启</div>
          <div class="set-desc">{{ isPortable ? "便携版不支持开机自启（注册的会是临时副本）" : "登录 Windows 后自动运行 AgentApiGateway，改动即时生效" }}</div>
        </div>
        <el-tooltip :content="'便携版不支持开机自启'" :disabled="!isPortable" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.schedule.autoStart, disabled: isPortable }"
            role="switch"
            :aria-checked="!!app.config.schedule.autoStart"
            @click="!isPortable && (app.config.schedule.autoStart = !app.config.schedule.autoStart, toggleAppBehavior())"
          ></div>
        </el-tooltip>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">关闭最小化到托盘</div>
          <div class="set-desc">开启：关闭后销毁界面进程（释放渲染进程），托盘与后台服务（反代网关）照常运行，唤回时重新加载界面；关闭：关闭后直接退出应用，浏览器与反代都会断开</div>
        </div>
        <div
          class="switch"
          :class="{ on: app.config.schedule.minimizeToTray }"
          role="switch"
          :aria-checked="!!app.config.schedule.minimizeToTray"
          @click="app.config.schedule.minimizeToTray = !app.config.schedule.minimizeToTray; toggleAppBehavior()"
        ></div>
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info"><div class="set-name">版本</div></div>
        <span class="num">{{ version }}</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">数据目录</div>
          <div class="set-desc">{{ dataDir || "（浏览器预览）" }}</div>
        </div>
        <el-tooltip :content="dataDirGate.reason || ''" :disabled="!dataDirGate.disabled" placement="top">
          <span><button class="btn btn-ghost" :disabled="dataDirGate.disabled" @click="openDataDir">打开目录</button></span>
        </el-tooltip>
      </div>
      
    </div>


  </div>
</template>

<style scoped>
/* 便携版禁用的开机自启开关：置灰且不响应 */
.switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 只有标题的设置行：不留底部内边距，让下面的 rows 贴上来 */
.set-row-head {
  padding-bottom: 2px;
  border-bottom: none;
}
</style>
