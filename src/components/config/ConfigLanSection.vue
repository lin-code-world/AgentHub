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
<!-- 设置 · 局域网访问：反代端口 / 绑定地址（保存并重启生效）+ 局域网地址（实时跟随端口与绑定）
     + 访问令牌（不展示令牌内容，仅提供复制；复制即重置——每次点击都生成新令牌、旧令牌立即失效，
       浏览器里的管理会话随之作废，需要重新登录）。令牌只有一处来源：config.admin.token。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { AdminAccessInfo } from "../../api/ipc";

const app = useAppStore();

/** 端口/绑定的本地草稿：本板块是「改完点保存并重启才生效」的语义，输入只改草稿、
 *  不直接写全局配置——否则切到别的板块时，那里的「改动即存」会把这里未保存的
 *  端口/绑定一起落盘（落盘了却没重启，配置与实际监听不一致）。
 *  每次切回本板块用全局值重置草稿，等价于「切走不保存即丢弃」。 */
const draftPort = ref<number | string>(app.config.proxy.port);
const draftBind = ref<string>(app.config.proxy.bind);
function syncDraft() {
  draftPort.value = app.config.proxy.port;
  draftBind.value = app.config.proxy.bind;
}

const info = ref<AdminAccessInfo | null>(null);
const resetting = ref(false);
const saveState = ref("");
let stateTimer = 0;

/** 仅在设置弹窗 · 局域网访问可见时刷新（管理地址 / 令牌保持最新） */
const active = computed(() => app.settingsOpen && app.settingsTab === "lan");
watch(
  active,
  (v) => {
    if (v) {
      syncDraft(); // 重新进入板块：丢弃上次未保存的编辑
      refresh();
    }
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

/** 本机局域网 IP：从后端给的局域网地址里只抠 IP（端口实时跟随输入框，不用后端的旧值） */
const lanIp = computed(() => {
  const m = /^http:\/\/([^:]+):\d+$/.exec(info.value?.lanUrl || "");
  return m ? m[1] : "";
});

/** 局域网地址实时跟随端口 / 绑定地址：端口 = 输入框的值（管理端口 = 端口 + 1）；
 *  绑定选「仅本机」时用回环地址，选「局域网开放」时用本机局域网 IP；
 *  端口非法或没拿到 IP 时给出对应提示，复制按钮同步置灰 */
const lanAddress = computed(() => {
  if (!info.value) return { text: "（地址不可用）", usable: false };
  const port = Math.round(Number(draftPort.value));
  if (!Number.isFinite(port) || port < 1 || port > 65534) return { text: "（端口非法，地址不可用）", usable: false };
  const host = draftBind.value === "127.0.0.1" ? "127.0.0.1" : lanIp.value;
  if (!host) return { text: "（未检测到局域网地址）", usable: false };
  return { text: `http://${host}:${port + 1}`, usable: true };
});

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

/** 保存并重启监听：只提交端口与绑定地址（proxy_set_listen），别的字段一律不动；
 *  成功后同进程 stop→listen 秒级重启（不中断应用）。局域网地址由草稿端口计算（端口 + 1），
 *  改输入框即预览新值，重启后实际监听生效 */
const savingLan = ref(false);
async function saveAndRestart() {
  if (savingLan.value) return;
  savingLan.value = true;
  saveState.value = "";
  try {
    const port = Math.round(Number(draftPort.value));
    if (!Number.isFinite(port) || port < 1 || port > 65534) {
      // 管理端口 = 反代端口 + 1：65535 会让管理端口越界，管理页静默消失（I2）
      feedback("端口必须是 1-65534 的整数（管理端口 = 端口 + 1，65535 会越界）");
      return;
    }
    const r = await api.proxySetListen(port, draftBind.value).catch((e: Error) => ({ ok: false, port: undefined, bind: undefined, message: String(e.message || e) }));
    if (r && r.ok === false) {
      feedback(`保存失败：${r.message}`);
      return;
    }
    // 后端以磁盘值为底只写这两个字段；这里同步内存快照，避免其他板块随后的整份保存用旧端口覆盖
    app.config.proxy.port = port;
    app.config.proxy.bind = draftBind.value;
    const rr = await api.proxyRestart().catch((e: Error) => ({ ok: false, port: undefined, message: String(e.message || e) }));
    if (rr && rr.ok === false) {
      feedback(`已保存，但重启监听失败：${rr.message}`);
      return;
    }
    feedback(`已保存并重启监听（端口 ${rr.port ?? port}）`);
    await refresh();
  } finally {
    savingLan.value = false;
  }
}
</script>

<template>
  <div class="lan-sec">
    <div class="tg-head">
      <span class="tg-hint">{{ info && !info.available ? info.message : "局域网内的浏览器访问管理地址并输入令牌，即可管理反代网关。" }}</span>
      <div class="lan-ctl">
        <span v-if="saveState" class="tg-state">{{ saveState }}</span>
        <button class="btn btn-cta" :disabled="savingLan" @click="saveAndRestart">{{ savingLan ? "保存中…" : "保存并重启" }}</button>
      </div>
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
          <div class="set-name">反代端口</div>
          <div class="set-desc">默认 9527；改端口需点「保存并重启」生效（秒级，不中断应用） · 管理端口 = 端口 + 1，所以最大只能填 65534</div>
        </div>
        <input v-model.number="draftPort" class="input mono" style="width: 100px" type="number" min="1" max="65534" />
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">绑定地址</div>
          <div class="set-desc">选「仅本机」时下面地址是 127.0.0.1；选「局域网开放」会强制要求 Key 鉴权，注意风险</div>
        </div>
        <el-select v-model="draftBind" class="f-el-select" popper-class="glass-popper" style="width: 208px">
          <el-option value="127.0.0.1" label="127.0.0.1（仅本机）" />
          <el-option value="0.0.0.0" label="0.0.0.0（局域网开放）" />
        </el-select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">局域网地址</div>
          <div class="set-desc">局域网内其他设备用这个地址访问管理页；改端口或绑定地址会立即预览新值，点「保存并重启」后才真正生效</div>
        </div>
        <div class="lan-ctl">
          <span class="mono lan-text">{{ lanAddress.text }}</span>
          <button class="btn btn-ghost" :disabled="!lanAddress.usable" @click="copyText(lanAddress.text, '局域网地址')">复制</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">访问令牌</div>
          <div class="set-desc">登录管理页用；每次点击复制都会生成新令牌，旧令牌立即失效，浏览器需重新登录</div>
        </div>
        <div class="lan-ctl">
          <button class="btn btn-ghost" :disabled="!info || resetting" @click="resetAndCopyToken">{{ resetting ? "生成中…" : "复制" }}</button>
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
