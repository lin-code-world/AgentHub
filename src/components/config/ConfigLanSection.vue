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
<!-- 设置 · 局域网访问：管理地址（反代端口 + 1，只展示局域网地址）与访问令牌
     （不展示令牌内容，仅提供复制；复制即重置——每次点击都生成新令牌、旧令牌立即失效，
     浏览器里的管理会话随之作废，需要重新登录）。令牌只有一处来源：config.admin.token。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { denyState, isWebTransport } from "../../api/caps";
import type { AdminAccessInfo } from "../../api/ipc";

const app = useAppStore();
/** 浏览器形态（I3）：本页只作只读展示——令牌查看 / 重置在服务端被 deny，
 *  顶部提示直接写明「请在桌面端操作」，不让用户对着置灰按钮猜原因 */
const webForm = isWebTransport();
/** 令牌复制（= 重置令牌）的命令门控：浏览器形态服务端 deny 时置灰 + 展示下发原因，桌面（无 caps）不置灰 */
const tokenGate = denyState("admin_access_info", "admin_reset_token");

const info = ref<AdminAccessInfo | null>(null);
const resetting = ref(false);
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
    info.value = null; /* 拿不到就整块降级为「地址不可用」 */
  }
}

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

function copyText(text: string, what: string) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => feedback(`${what}已复制`))
    .catch(() => feedback("复制失败"));
}

/** 复制令牌 = 重置令牌：每次点击都生成新的随机令牌（旧令牌立即失效、浏览器会话作废），
 *  拿到新令牌后写剪贴板；写失败保留「请再点一次」提示（再点会再换一次令牌） */
async function resetAndCopyToken() {
  if (resetting.value) return;
  resetting.value = true;
  let token = "";
  try {
    const r = await api.adminResetToken();
    if (!r || !r.token) throw new Error(r && r.message ? r.message : "未返回新令牌");
    token = r.token;
  } catch (e) {
    resetting.value = false;
    feedback(`令牌重置失败：${(e as Error).message || e}`);
    return;
  }
  await refresh();
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(token);
    feedback("新令牌已复制，旧令牌立即失效，浏览器需重新登录");
  } catch {
    feedback("令牌已更新，但复制失败，请再点一次");
  } finally {
    resetting.value = false;
  }
}
</script>

<template>
  <div class="lan-sec">
    <div class="tg-head">
      <span class="tg-hint">{{ webForm ? "管理地址来自桌面端的反代端口；令牌的复制请在桌面窗口操作。" : info && !info.available ? info.message : "局域网内的浏览器访问管理地址并输入令牌，即可管理反代网关。" }}</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
    </div>

    <!-- 安全提示（I7）：页面本身没有 HTTPS，别把「内网能用」误解成「可以对外」 -->
    <div class="lan-warn">
      <div><b>仅建议在可信局域网内使用</b>：业务数据与令牌都经过应用层加密（ECDH 协商、AES-GCM），令牌不以明文上网；但页面本身没有 TLS，页面不可信、可被同网段嗅探或篡改，<b>不要映射到公网</b>。</div>
      <div>首次启用时 Windows 防火墙会弹窗，需允许「专用网络」；只勾选「公用网络」或拒绝放行，局域网其他设备都打不开。</div>
      <div>确需跨网访问，请在前面加一层带 TLS 的反向代理，只对外开 443，并保留令牌鉴权。</div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">局域网地址</div>
          <div class="set-desc">局域网内其他设备用这个地址访问管理页（反代端口 + 1）</div>
        </div>
        <div class="lan-ctl">
          <span class="mono lan-text">{{ info?.lanUrl || (info && info.available ? "（未检测到局域网地址）" : "（地址不可用）") }}</span>
          <button class="btn btn-ghost" :disabled="!info?.lanUrl" @click="info && info.lanUrl && copyText(info.lanUrl, '局域网地址')">复制</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">访问令牌</div>
          <div class="set-desc">登录管理页用；每次点击复制都会生成新令牌，旧令牌立即失效，浏览器需重新登录</div>
        </div>
        <el-tooltip :content="tokenGate.reason || ''" :disabled="!tokenGate.disabled" placement="top">
          <div class="lan-ctl">
            <button class="btn btn-ghost" :disabled="!info || tokenGate.disabled || resetting" @click="resetAndCopyToken">{{ resetting ? "生成中…" : "复制" }}</button>
          </div>
        </el-tooltip>
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
/* 安全提示块（I7）：常驻在地址卡上方，弱底不抢主操作 */
.lan-warn {
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(229, 180, 84, 0.28);
  background: var(--warn-dim);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.7;
}
.lan-warn b {
  color: var(--warn);
  font-weight: 600;
}
.lan-text {
  font-size: 12px;
}
</style>
