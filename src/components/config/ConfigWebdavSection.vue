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
<!-- 设置弹窗 · WebDAV 同步：统一服务器 + 模块根目录/预设/电脑名 + 反代号池同步 -->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import * as api from "../../api/ipc";
import { onUpdateEvent } from "../../api/ipc";
import { useAppStore } from "../../stores/app";

const app = useAppStore();

// 每次激活都重拉共享配置（服务器配置在本页改，改完主进程即时生效）
const active = computed(() => app.settingsOpen && app.settingsTab === "webdav");
watch(active, (v) => { if (v) loadPage(); }, { immediate: true });

// 激活即加载：共享配置 / 号池同步状态
async function loadPage() {
  loadShared();
  refreshPoolsync();
}

// ===== 统一 WebDAV 服务器（webdavShared）：号池同步用 =====
const SYNC_PASSWORD_MASK = "••••••••"; // 与后端掩码约定一致：精确掩码视为「未修改密码」
const shared = ref<api.SharedWebdavConfig>({
  type: "webdav",
  endpoint: "",
  username: "",
  password: "",
  encryptionPassphrase: "",
  s3: { bucket: "", region: "", pathStyle: false },
  roots: { proxy: "/agenthub-proxy" },
});
const sharedTestResult = ref<{ ok: boolean; message: string } | null>(null);
const sharedSaveMsg = ref("");
const sharedTesting = ref(false);
const sharedSaving = ref(false);
/** 共享服务器是否已配置（各板块同步状态行的就绪判定） */
const configured = computed(() => !!(shared.value.endpoint && shared.value.username && shared.value.password));

// 密码框防误触：显示的是掩码，任何编辑（哪怕只删一个字符）都先清空，避免残缺掩码被当新密码落盘
function onSharedPasswordInput() {
  const v = shared.value.password;
  if (v !== SYNC_PASSWORD_MASK && v.includes("•")) shared.value.password = "";
}
function onSharedPassphraseInput() {
  const v = shared.value.encryptionPassphrase;
  if (v !== SYNC_PASSWORD_MASK && v.includes("•")) shared.value.encryptionPassphrase = "";
}
async function testShared() {
  sharedTestResult.value = null;
  sharedTesting.value = true;
  try {
    sharedTestResult.value = await api.webdavSharedTest(shared.value);
  } catch (e) {
    sharedTestResult.value = { ok: false, message: String((e as Error).message || e) };
  } finally {
    sharedTesting.value = false;
  }
}
async function saveShared() {
  sharedSaveMsg.value = "";
  sharedSaving.value = true;
  try {
    const r = await api.webdavSharedSave(shared.value);
    sharedSaveMsg.value = r?.ok ? "已保存，各模块的同步即刻生效" : r?.message || "保存失败";
    if (r?.ok) {
      // 回读掩码态（密码不回显明文）
      await loadShared();
      refreshPoolsync();
    }
  } catch (e) {
    sharedSaveMsg.value = String((e as Error).message || e);
  } finally {
    sharedSaving.value = false;
  }
}
// 显式清除（后端唯一允许清掉已存密码的入口；后台保存遇空密码会保留密文，防解密失败被覆盖）
async function clearShared() {
  if (!window.confirm("确定清除统一 WebDAV 服务器配置吗？\n\n地址、账号、密码与各模块根目录将全部清空，各模块的跨设备同步会立即停用（本机数据不受影响）。")) return;
  sharedSaveMsg.value = "";
  try {
    const r = await api.webdavSharedClear();
    sharedSaveMsg.value = r?.ok ? "已清除" : r?.message || "清除失败";
    if (r?.ok) {
      await loadShared();
      refreshPoolsync();
    }
  } catch (e) {
    sharedSaveMsg.value = String((e as Error).message || e);
  }
}
async function loadShared() {
  try {
    shared.value = await api.webdavSharedGet();
  } catch { /* 浏览器预览走 mock */ }
}

// ---- 反代网关号池同步（压缩包用 WebDAV 密码加密；进度走 app:event 推送） ----
const poolsync = ref<api.ProxyPoolSyncStatus | null>(null);
const poolsyncMsg = ref("");
const poolsyncRunning = computed(() => !!poolsync.value?.running);
let offEvents: (() => void) | undefined;

async function refreshPoolsync() {
  try {
    poolsync.value = await api.proxyPoolsyncStatus();
  } catch { /* 浏览器预览走 mock */ }
}
async function runPoolsync() {
  poolsyncMsg.value = "";
  try {
    const r = await api.proxyPoolsyncRun();
    poolsyncMsg.value = r?.ok ? r.summary || "同步完成" : r?.message || "同步失败";
  } catch (e) {
    poolsyncMsg.value = String((e as Error).message || e);
  }
  await refreshPoolsync();
}
function fmtAgoMs(ms: number) {
  if (!ms) return "从未同步";
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

    /** 未配置时引导到上方「统一 WebDAV 服务器」表单（与号池同步页的门控行为对齐） */
function gotoSharedForm() {
  document.getElementById("shared-webdav-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 各板块的同步进度事件合流：号池（proxy/poolsync）；
// 运行中就地更新运行态，结束时回读完整状态（拿 lastSyncAt / lastError / 摘要）
onMounted(() => {
  offEvents = onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; stage?: string; detail?: string; running?: boolean };
    if (p?.event === "proxy" && p?.type === "poolsync" && poolsync.value) {
      poolsync.value.running = !!p.running;
      if (p.stage) poolsync.value.stage = p.stage;
      poolsync.value.detail = p.detail || "";
    }
  });
});
onUnmounted(() => {
  if (offEvents) offEvents();
});
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">WebDAV 同步</div>
        <div class="cfg-sec-sub">统一服务器 · 号池根目录 · 快捷同步（号池同步用这一台服务器）</div>
      </div>
      <div class="cfg-sec-actions">
        <el-tag :type="configured ? 'success' : 'info'" effect="plain" round>
          <i class="ph" :class="configured ? 'ph-cloud-check' : 'ph-cloud-slash'"></i>
          {{ configured ? "已连接就绪" : "未配置" }}
        </el-tag>
      </div>
    </div>

    <div class="sk-note warn" v-if="!configured">
      <i class="ph ph-cloud-slash"></i>
      <div>还没配置 WebDAV 服务器。在下方「统一 WebDAV 服务器」填好地址、账号与应用密码并保存，即可开始跨设备同步。</div>
    </div>

    <!-- 统一 WebDAV 服务器：各模块共用这一套凭据，根目录各自隔离 -->
    <div class="sync-scope" style="display:flex; flex-direction:column; gap:12px">
      <div class="card" id="shared-webdav-card" style="padding: 16px 18px">
        <div class="setting-group" style="margin-bottom: 0">
          <div class="sg-title" style="margin-bottom: 12px">
            统一 WebDAV 服务器
            <span class="sg-hint">服务器凭据一套通用 · 密码经系统密钥加密保存，界面只显示掩码</span>
          </div>
          <div class="form-grid">
            <div class="form-field full">
              <label>存储类型</label>
              <div class="tabs">
                <button class="tab" :class="{ active: shared.type !== 's3' }" @click="shared.type = 'webdav'">WebDAV 网盘</button>
                <button class="tab" :class="{ active: shared.type === 's3' }" @click="shared.type = 's3'">S3 兼容对象存储</button>
              </div>
            </div>
            <template v-if="shared.type !== 's3'">
              <div class="form-field"><label>服务器地址（WebDAV）</label><input class="f-input" v-model="shared.endpoint" placeholder="https://dav.jianguoyun.com/dav" /></div>
              <div class="form-field"><label>账号</label><input class="f-input" v-model="shared.username" autocomplete="off" /></div>
              <div class="form-field full"><label>密码（同时作为反代号池压缩包的默认加密口令，多设备必须一致）</label><input class="f-input" type="password" v-model="shared.password" autocomplete="new-password" placeholder="已保存密码显示为掩码；输入任意字符即进入修改，请填写完整新密码" @input="onSharedPasswordInput" /></div>
            </template>
            <template v-else>
              <div class="form-field"><label>服务器地址（S3 兼容 API，如 OSS/COS/R2/MinIO 的端点）</label><input class="f-input" v-model="shared.endpoint" placeholder="https://s3.us-east-1.amazonaws.com" /></div>
              <div class="form-field"><label>AccessKeyId</label><input class="f-input" v-model="shared.username" autocomplete="off" /></div>
              <div class="form-field full"><label>SecretKey（同时作为反代号池压缩包的默认加密口令，多设备必须一致）</label><input class="f-input" type="password" v-model="shared.password" autocomplete="new-password" placeholder="已保存密钥显示为掩码；输入任意字符即进入修改" @input="onSharedPasswordInput" /></div>
              <div class="form-field"><label>桶名（Bucket）</label><input class="f-input mono" v-model="shared.s3.bucket" placeholder="my-bucket" /></div>
              <div class="form-field"><label>区域（AWS 填区域码；R2/MinIO 填 auto）</label><input class="f-input mono" v-model="shared.s3.region" placeholder="us-east-1 或 auto" /></div>
              <div class="form-field full">
                <div class="switch-row" style="padding: 0">
                  <div class="s-left">
                    <div class="s-title" style="font-size: 12.5px">Path-Style 寻址</div>
                    <div class="s-desc">MinIO / R2 / OSS 等勾选；AWS 官方 S3 留空（虚拟主机式）</div>
                  </div>
                  <div class="switch" :class="{ on: shared.s3.pathStyle }" role="switch" :aria-checked="shared.s3.pathStyle" @click="shared.s3.pathStyle = !shared.s3.pathStyle"></div>
                </div>
              </div>
            </template>
            <div class="form-field full"><label>号池加密口令（可选，留空沿用密码 / SecretKey；多设备必须一致）</label><input class="f-input" type="password" v-model="shared.encryptionPassphrase" autocomplete="new-password" placeholder="已保存口令显示为掩码；输入任意字符即进入修改" @input="onSharedPassphraseInput" /></div>
            <div class="form-field full">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
                <button class="btn-outline" :disabled="sharedTesting" @click="testShared">{{ sharedTesting ? "测试中…" : "测试连接" }}</button>
                <button class="btn btn-cta" :disabled="sharedSaving" @click="saveShared">{{ sharedSaving ? "保存中" : "保存设置" }}</button>
                <button v-if="shared.endpoint || shared.username" class="btn-outline danger" @click="clearShared">清除配置</button>
                <span v-if="sharedTestResult" class="hint" :style="{ color: sharedTestResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ sharedTestResult.message }}</span>
                <span v-else-if="sharedSaveMsg" class="hint">{{ sharedSaveMsg }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 各模块根目录：同一台服务器上的隔离目录（默认值即存量数据位置，勿轻易改） -->
      <div class="card" style="padding: 16px 18px">
        <div class="setting-group" style="margin-bottom: 0">
          <div class="sg-title" style="margin-bottom: 12px">
            模块根目录
            <span class="sg-hint">各模块在同一网盘上的隔离目录 · 改根目录 = 换一个全新数据位置（旧数据不搬）</span>
          </div>
          <div class="form-grid">
            <div class="form-field"><label>反代网关号池（默认 /agenthub-proxy）</label><input class="f-input mono" v-model="shared.roots.proxy" placeholder="/agenthub-proxy" /></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 快捷同步：各板块逐一手动触发（共用上方统一服务器与各自根目录；详细进度/报告在各模块同步页） -->
    <div class="sync-scope">
      <div class="card" style="padding: 4px 18px 10px">
        <div style="display:flex; align-items:baseline; padding: 12px 0 2px">
          <span style="font-size:13px; font-weight:600; color: var(--text)">快捷同步</span>
          <span style="font-size:11px; color: var(--text-3); margin-left:8px">各板块共用上方统一服务器 · 可逐个手动触发，详细进度与报告见各模块的「同步」页</span>
        </div>

        <!-- 反代网关号池 -->
        <div class="switch-row" style="align-items: flex-start">
          <div class="s-left">
            <div class="s-title">反代网关 · 号池同步</div>
            <div class="s-desc">把号池账号（含登录凭据）打成加密压缩包上传到网盘，其他电脑拉取后按账号自动去重合并；本机移除账号会同步移除他机 · 根目录 {{ shared.roots.proxy || "/agenthub-proxy" }}</div>
            <div class="s-desc" style="color: var(--text-3); margin-top: 2px">
              API Keys 与模型映射（含反向映射）随号池同步，改名/改配额/删除也会传播；上游启闭与签到规则按设备各自独立
            </div>
            <div class="s-desc" style="color: var(--text-3); margin-top: 2px">
              压缩包用上面的 WebDAV 密码加密（AES-256-GCM），各设备密码须一致
            </div>
            <div class="s-desc" style="margin-top: 2px" v-if="poolsync">
              <span :style="{ color: poolsync.configured ? 'var(--ok)' : 'var(--warn)' }">{{ poolsync.configured ? "已就绪" : "未配置" }}</span>
              <template v-if="poolsync.lastSyncAt"> · 上次同步 {{ fmtAgoMs(poolsync.lastSyncAt) }}</template>
              <template v-if="poolsync.lastSummary">（{{ poolsync.lastSummary }}）</template>
            </div>
            <div class="s-desc" v-if="poolsync?.lastError" :style="{ color: 'var(--err)' }">上次失败：{{ poolsync.lastError }}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
            <span v-if="poolsyncMsg" class="hint">{{ poolsyncMsg }}</span>
            <button v-if="poolsync && !poolsync.configured" class="btn-outline" @click="gotoSharedForm">去配置</button>
            <button v-else class="btn-outline" :disabled="poolsyncRunning || !poolsync" @click="runPoolsync">{{ poolsyncRunning ? "同步中…" : "立即同步" }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
