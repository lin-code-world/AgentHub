<!--
  ============================================================
   作者：沐晖
   日期：2026-10-27
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 设置 · 局域网访问：管理地址（反代端口 + 1，局域网地址优先展示、本机回环地址兜底）与访问令牌
     （掩码展示，可查看 / 复制 / 修改）。修改令牌后浏览器里的管理会话作废，需要重新登录。
     令牌来源分形态：桌面管理服务只认 config.admin.token（本页展示 / 修改的就是它），
     容器（Docker headless）仍认 AGENTHUB_ADMIN_TOKEN 环境变量；桌面没有只读令牌 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { AdminAccessInfo } from "../../api/ipc";

const app = useAppStore();

const info = ref<AdminAccessInfo | null>(null);
const tokenShown = ref(false);
const editing = ref(false);
const newToken = ref("");
const saveState = ref("");
let stateTimer = 0;

/** 仅在设置弹窗 · 局域网访问可见时刷新（管理地址 / 令牌保持最新） */
const active = computed(() => app.settingsOpen && app.settingsTab === "lan");
watch(
  active,
  (v) => {
    if (v) refresh();
  },
  { immediate: true }
);

async function refresh() {
  try {
    info.value = await api.adminAccessInfo();
  } catch {
    info.value = null; /* 拿不到就整块降级为「暂不可用」 */
  }
}

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

/** 令牌掩码：前 4 ···· 后 4（与 Key 列表 mask 同款） */
const tokenMask = computed(() => {
  const t = info.value?.token || "";
  return t.length >= 8 ? `${t.slice(0, 4)}····${t.slice(-4)}` : "····";
});

function copyText(text: string, what: string) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => feedback(`${what}已复制`))
    .catch(() => feedback("复制失败"));
}

function startEdit() {
  newToken.value = "";
  editing.value = true;
}

/** 修改令牌：非空且 ≥16 位（不允许清空），成功后管理会话全部作废 */
async function saveToken() {
  const t = newToken.value.trim();
  if (t.length < 16) {
    feedback("令牌至少 16 位");
    return;
  }
  try {
    await api.adminSetToken(t);
    editing.value = false;
    tokenShown.value = false;
    await refresh();
    feedback("令牌已更新，浏览器需重新登录");
  } catch (e) {
    feedback(`保存失败：${(e as Error).message || e}`);
  }
}
</script>

<template>
  <div class="lan-sec">
    <div class="tg-head">
      <span class="tg-hint">{{ info && !info.available ? info.message : "局域网内的浏览器访问管理地址并输入令牌，即可管理反代网关。" }}</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">局域网地址</div>
          <div class="set-desc">局域网内其他设备用这个地址访问管理页（反代端口 + 1）</div>
        </div>
        <div class="lan-ctl">
          <span class="mono lan-text">{{ info?.lanUrl || (info && info.available ? "（未检测到局域网网络，请用本机地址）" : "（地址不可用）") }}</span>
          <button class="btn btn-ghost" :disabled="!info?.lanUrl" @click="info && info.lanUrl && copyText(info.lanUrl, '局域网地址')">复制</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">本机地址</div>
          <div class="set-desc">仅本机浏览器可用（回环地址）</div>
        </div>
        <div class="lan-ctl">
          <span class="mono lan-text">{{ info?.loopbackUrl || "（地址不可用）" }}</span>
          <button class="btn btn-ghost" :disabled="!info?.loopbackUrl" @click="info && info.loopbackUrl && copyText(info.loopbackUrl, '本机地址')">复制</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">访问令牌</div>
          <div class="set-desc">登录管理页用；修改后浏览器需重新登录</div>
        </div>
        <div class="lan-ctl">
          <span class="mono lan-text">{{ tokenShown ? info?.token || "" : tokenMask }}</span>
          <button class="btn btn-ghost" :disabled="!info" @click="tokenShown = !tokenShown">{{ tokenShown ? "隐藏" : "查看" }}</button>
          <button class="btn btn-ghost" :disabled="!info" @click="info && copyText(info.token, '令牌')">复制</button>
          <button class="btn btn-ghost" @click="startEdit">修改</button>
        </div>
      </div>
    </div>

    <div v-if="editing" class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">修改令牌</div>
          <div class="set-desc">至少 16 位，不允许清空；保存后浏览器里的管理会话作废，需重新登录</div>
        </div>
        <div class="lan-ctl">
          <input v-model="newToken" class="input mono" style="width: 240px" placeholder="输入新令牌（≥16 位）" @keyup.enter="saveToken" />
          <button class="btn btn-primary" @click="saveToken">保存</button>
          <button class="btn btn-ghost" @click="editing = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lan-sec {
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
.lan-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.lan-text {
  font-size: 12px;
}
</style>
