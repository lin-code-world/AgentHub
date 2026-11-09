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
<!-- 设置 · 监控与安全：额度自动刷新周期 / 「即将到期」预警阈值 / 数据保留期（余额历史 / 请求流水 / 操作日志）在这里管，改动即改即存，状态反馈集中在顶部 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { isWebTransport } from "../../api/caps";
import { toast } from "../../utils/toast";

const app = useAppStore();

/** 浏览器托管形态：load_config / save_config 被 deny，监控与安全配置走反代段 proxy_config_get / proxy_config_save */
const webForm = computed(() => isWebTransport());

const ready = ref(true);
const saveState = ref("");
let stateTimer = 0;

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

/** 监控与安全改动即存：桌面走整份 save_config，浏览器走反代段 proxy_config_save
 *  （激活时已用 proxy_config_get 回填真实值，整体提交反代段：port/bind 后端忽略、out-of-band 字段保护）。
 *  预警阈值 / 保留期提交前按 ConfigProxySection.saveRoute() 同一口径钳制，保证落盘值合法 */
async function saveFramework() {
  // 判数用 Number.isFinite 而不是 ||：合法的 0（= 关闭预警）会被 || 当 falsy 跳回默认值
  const esd = Number(app.config.proxy.expiringSoonDays);
  app.config.proxy.expiringSoonDays = Math.min(3650, Math.max(0, Math.round(Number.isFinite(esd) ? esd : 1)));
  // 保留期只认 1~3650：非正值（0 / 负数 / 空串 / 垃圾）一律兜底默认 90（与 ConfigProxySection.saveRoute() 同口径）
  const urd = Number(String(app.config.proxy.usageRetentionDays ?? "").trim() || NaN);
  app.config.proxy.usageRetentionDays = Number.isFinite(urd) && Math.round(urd) >= 1 ? Math.min(3650, Math.round(urd)) : 90;
  const r = webForm.value ? await api.proxyConfigSave(app.config.proxy).catch((e: Error) => ({ ok: false, message: String(e.message || e) })) : await app.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

// 每次激活（设置弹窗打开且停在监控与安全板块）浏览器形态回填真实值：拿不到整份配置（默认值），
// 用反代段读取回填，下拉才显示真实周期；桌面 load() 已载入整份，无需重复
const active = computed(() => app.settingsOpen && app.settingsTab === "timing");
watch(
  active,
  async (v) => {
    if (v && webForm.value) {
      const remote = await api.proxyConfigGet().catch(() => null);
      if (remote) app.config.proxy = remote;
    }
  },
  { immediate: true }
);

/** 导出崩溃日志：桌面弹「另存为」；浏览器拿数据自行下载（导出的是**网关所在机器**的日志）。
 *  浏览器端不弹本机对话框，服务端把压缩包数据回传、这里用 Blob 触发下载 */
const exporting = ref(false);
async function exportCrashLogs() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    if (webForm.value) {
      const r = await api.exportCrashLogsData();
      if (!r || r.ok === false || !r.base64) {
        toast.error((r && r.message) || "导出失败");
        return;
      }
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.name || "crash-logs.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`崩溃日志已导出（${r.count} 个日志文件）`);
      return;
    }
    const r = await api.exportCrashLogs();
    if (!r || r.ok === false) {
      toast.error((r && r.message) || "导出失败");
      return;
    }
    if (r.canceled) return; // 用户取消：不打扰
    toast.success(`崩溃日志已导出：${r.path}`);
  } catch (e) {
    toast.error(String((e as Error).message || e));
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div v-if="ready" class="timing-sec">
    <div class="tg-head">
      <span class="tg-hint">额度刷新 / 预警阈值 / 保留期统一在这里调整，改动即存即生效。</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
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
        <div class="s-title">「即将到期」预警阈值</div>
        <div class="s-desc">号池到期徽标与逐包明细共用这一个值；填 0 关闭预警。范围 0~3650，超出按边界保存</div>
      </div>
      <div class="tg-val">
        <input v-model.number="app.config.proxy.expiringSoonDays" class="input mono" style="width: 90px" type="number" min="0" max="3650" @change="saveFramework" />
        <span class="tg-unit">天</span>
      </div>
    </div>

    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">数据保留期</div>
        <div class="s-desc">启动时按它清理超期的请求流水、余额历史与操作日志（1~3650 天，默认 90；填 0 或非法值按 90 保存）。日志页与用量统计页的「清理」按钮按当前值立即删一轮</div>
      </div>
      <div class="tg-val">
        <input v-model.number="app.config.proxy.usageRetentionDays" class="input mono" style="width: 90px" type="number" min="1" max="3650" @change="saveFramework" />
        <span class="tg-unit">天</span>
      </div>
    </div>

    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">崩溃日志</div>
        <div class="s-desc">导出全部崩溃日志（当前段 + 历史分段）与一份环境信息，打包为 zip；出问题时发给开发者排查</div>
      </div>
      <button class="btn btn-ghost" :disabled="exporting" @click="exportCrashLogs">{{ exporting ? "导出中…" : "导出" }}</button>
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
.tg-unit {
  font-size: 11px;
  color: var(--text-3);
}
/* 左文右控行：文案与右侧控件之间保底间距（长描述文本不紧贴文本框） */
.switch-row {
  gap: 24px;
}
/* 数值输入 + 单位：固定 8px 间距、整体靠右（避免 .switch-row 的 space-between 把两者拆开） */
.tg-val {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
