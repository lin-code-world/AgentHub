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
<!-- 设置 · 同步时间：反代网关「号池定时同步」的周期在这里管，改动即改即存，状态反馈集中在顶部 -->
<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../../stores/app";

const app = useAppStore();

const ready = ref(true);
const saveState = ref("");
let stateTimer = 0;

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

/** 框架配置（反代网关周期）改动即存 */
async function saveFramework() {
  const r = await app.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

/** 自动签到已改为按渠道设置（时间/抖动随各渠道领取形态不同），从这里直接去号池页 */
function gotoProxyPool() {
  app.settingsOpen = false;
  app.selectModule("proxy");
  app.setPage("agents");
}
</script>

<template>
  <div v-if="ready" class="timing-sec">
    <div class="tg-head">
      <span class="tg-hint">各板块的自动同步 / 自动刷新周期统一在这里调整，改动即存即生效。各板块配置页里的同类入口已改为引导到这里。</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
    </div>

    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">号池定时同步（WebDAV）</div>
        <div class="s-desc">API Keys、模型映射与账号随号池同步；开启后按周期自动跑，换设备不用手动点</div>
      </div>
      <div class="tg-ctl">
        <el-select v-if="app.config.proxy.poolsyncSchedule.hourly" v-model="app.config.proxy.poolsyncSchedule.hourlyInterval" class="f-el-select" popper-class="glass-popper" style="width: 110px" @change="saveFramework">
          <el-option v-for="n in [1, 2, 3, 6, 12]" :key="n" :value="n" :label="`${n} 小时`" />
        </el-select>
        <div class="switch" :class="{ on: app.config.proxy.poolsyncSchedule.hourly }" role="switch" :aria-checked="app.config.proxy.poolsyncSchedule.hourly" @click="app.config.proxy.poolsyncSchedule.hourly = !app.config.proxy.poolsyncSchedule.hourly; saveFramework()"></div>
      </div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">号池每天固定时间</div>
        <div class="s-desc">每天到点同步一次（错过自动补跑）；与每小时档可同时开</div>
      </div>
      <div class="tg-ctl">
        <input v-if="app.config.proxy.poolsyncSchedule.daily" type="time" class="f-input" style="width: 110px" v-model="app.config.proxy.poolsyncSchedule.dailyTime" @change="saveFramework" />
        <div class="switch" :class="{ on: app.config.proxy.poolsyncSchedule.daily }" role="switch" :aria-checked="app.config.proxy.poolsyncSchedule.daily" @click="app.config.proxy.poolsyncSchedule.daily = !app.config.proxy.poolsyncSchedule.daily; saveFramework()"></div>
      </div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">额度自动刷新周期</div>
        <div class="s-desc">逐账号批量查询各渠道额度（每渠道并发 ≤2）</div>
      </div>
      <el-select v-model="app.config.proxy.creditsRefreshMin" class="f-el-select" popper-class="glass-popper" style="width: 120px" @change="saveFramework">
        <el-option :value="10" label="10 分钟" />
        <el-option :value="30" label="30 分钟" />
        <el-option :value="60" label="60 分钟" />
      </el-select>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">定时自动签到</div>
        <div class="s-desc">已改为按渠道设置（签到 / 领加油包 / 领 Credits 的形态各不相同）：到号池页各渠道工具栏的「自动签到 / 自动领加油包 / 自动领 Credits」里设每天的时间与抖动</div>
      </div>
      <div class="tg-ctl">
        <button class="btn btn-sm" @click="gotoProxyPool">去号池页设置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timing-sec {
  display: flex;
  flex-direction: column;
}
.tg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
}
.tg-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.tg-state {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent-strong);
}
.tg-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tg-unit {
  font-size: 11px;
  color: var(--text-3);
}
</style>
