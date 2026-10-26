<!-- 设置弹窗 · 通用：外观（主题）+ 应用行为（自启 / 托盘）+ 关于
     网关的操作设置在反代网关右上「配置」按钮切换的配置页里 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
// 版本号唯一事实源 = 仓库根 package.json 的 version（Electron 打包态 app.getVersion 同源）
import pkg from "../../../package.json";

const app = useAppStore();
const version = `v${pkg.version}`;
const dataDir = ref("");
const isPortable = ref(false);

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

/** 未开托盘常驻时轻量模式无意义（关窗本来就释放界面）—— 置灰并说明理由，而不是点了没反应 */
const lightweightDisabledReason = computed(() =>
  app.config.schedule.minimizeToTray ? "" : "已关闭「关闭最小化到托盘」：关窗本身就会释放界面，无需轻量模式"
);

/** 轻量模式开关：开启前确认一次（重建窗口有秒级等待，且会重置界面内的临时状态） */
async function toggleLightweightMode(v: string | number | boolean | undefined) {
  if (v !== true) {
    app.config.schedule.lightweightMode = false;
    await toggleAppBehavior();
    return;
  }
  try {
    await ElMessageBox.confirm(
      "开启后，点关闭按钮会直接释放整个界面进程（实测省约 300 MB 内存），托盘与后台服务照常运行。\n" +
        "下次点托盘「显示主界面」需要重新加载界面，约 1~3 秒，界面内未保存的临时状态会重置。",
      "开启轻量模式？",
      { confirmButtonText: "开启", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return; // 用户取消：不开启
  }
  app.config.schedule.lightweightMode = true;
  await toggleAppBehavior();
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

// ===== 全局快捷键（默认 Alt+`，两键）=====
// 校验口径与后端一致（功能键+字符键），但**前端先拦一道**：非法值即时红字提示，
// 不让用户提交后才由后端拒绝（后端仍是权威，两边都校验）。
// 注意：前端只能做语法校验；「是否已被别的程序占用」只有主进程注册时才知道，
// 故冲突提示走系统气泡（见 shortcut.cjs 的 createRegistrar）。
const shortcutDraft = ref("");
const shortcutMsg = ref<{ ok: boolean; text: string } | null>(null);
const shortcutBusy = ref(false);

/** 是否桌面端：全局快捷键依赖窗口与 Electron 的 globalShortcut，
 *  Web/容器端（NAS）没有这些能力，该设置项必须隐藏而不是让用户点了没反应 */
const isDesktop = computed(() => api.isElectron());

const MODS = ["Ctrl", "Alt", "Shift", "Super"];
const KEY_ALIASES: Record<string, string> = {
  // ~ → ` ：与后端 shortcut.cjs 同口径（此表两边必须一致）。
  // ~ 在标准键盘要 Shift+`，Electron 会当成**三键**组合 —— 用户按两键没反应。
  // 故统一归一成不带 Shift 的 ` 键，保证「按两键」即可触发。
  "~": "`", "`": "`", "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\",
  ";": ";", "'": "'", ",": ",", ".": ".", "/": "/",
  space: "Space", tab: "Tab", enter: "Enter", return: "Enter",
  backspace: "Backspace", delete: "Delete", insert: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right",
  plus: "Plus", numpadadd: "numadd", numpadsub: "numsub",
};

/** 与 backend/shortcut.cjs 的 normalize 同口径（保持两边规则一致，改一处要改两处） */
function normalizeShortcut(input: string): { ok: boolean; accelerator?: string; message?: string } {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, message: "快捷键不能为空（留空表示不启用快捷键）" };
  const parts = raw.split("+").map((s) => s.trim()).filter((s) => s !== "");
  if (!parts.length) return { ok: false, message: "快捷键不能为空" };
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    const canon = MODS.find((m) => m.toLowerCase() === lower)
      || (lower === "option" ? "Alt" : lower === "cmd" || lower === "meta" || lower === "win" || lower === "command" ? "Super" : "");
    if (canon) { if (!mods.includes(canon)) mods.push(canon); }
    else keys.push(p);
  }
  if (!mods.length) return { ok: false, message: "必须包含至少一个功能键（Ctrl / Alt / Shift / Super）" };
  if (!keys.length) return { ok: false, message: "必须包含一个字符键（如 ~、A、1、F5）" };
  if (keys.length > 1) return { ok: false, message: `只能有一个字符键，当前给了 ${keys.length} 个` };
  let key = keys[0];
  if (/^[A-Za-z]$/.test(key)) key = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else {
    const alias = KEY_ALIASES[key.toLowerCase()] || KEY_ALIASES[key];
    if (alias) key = alias;
    else if (!/^[0-9]$/.test(key)) return { ok: false, message: `不支持的字符键「${keys[0]}」` };
  }
  return { ok: true, accelerator: [...MODS.filter((m) => mods.includes(m)), key].join("+") };
}

/** 保存快捷键：前端校验 → 落盘（主进程注册时才知道是否冲突，冲突会弹系统气泡） */
async function saveShortcut() {
  const v = normalizeShortcut(shortcutDraft.value);
  if (!v.ok) {
    shortcutMsg.value = { ok: false, text: v.message || "格式不正确" };
    return;
  }
  shortcutBusy.value = true;
  try {
    app.config.schedule.shortcutToggle = v.accelerator!;
    await app.save();
    shortcutDraft.value = v.accelerator!;
    shortcutMsg.value = { ok: true, text: `已设为 ${v.accelerator}（若已被其它程序占用，会弹气泡提示并自动重试）` };
  } finally {
    shortcutBusy.value = false;
  }
}

/** 清空 = 不启用快捷键 */
async function clearShortcut() {
  shortcutBusy.value = true;
  try {
    app.config.schedule.shortcutToggle = "";
    await app.save();
    shortcutDraft.value = "";
    shortcutMsg.value = { ok: true, text: "已关闭快捷键" };
  } finally {
    shortcutBusy.value = false;
  }
}

onMounted(() => {
  // 快捷键输入框初值 = 当前配置（用户直接看到现在生效的是哪个键）
  shortcutDraft.value = app.config.schedule.shortcutToggle || "";
});
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
          <div class="set-desc">点关闭按钮不退出，仅最小化到托盘（托盘菜单「退出」才是真正退出）</div>
        </div>
        <div
          class="switch"
          :class="{ on: app.config.schedule.minimizeToTray }"
          role="switch"
          :aria-checked="!!app.config.schedule.minimizeToTray"
          @click="app.config.schedule.minimizeToTray = !app.config.schedule.minimizeToTray; toggleAppBehavior()"
        ></div>
      </div>
      <!-- 全局快捷键：桌面专属（Web/容器端无全局快捷键概念） -->
      <div v-if="isDesktop" class="set-row">
        <div class="set-info">
          <div class="set-name">全局快捷键（唤起 / 收起界面）</div>
          <div class="set-desc">
            应用在后台或托盘时也能用。按下时：界面可见则收起，不可见则唤回。<br />
            必须是「功能键 + 字符键」，如 <code>Alt+`</code>、<code>Ctrl+Shift+K</code>；留空表示不启用。<br />
            <b>注意</b>：不要用 <code>~</code> —— 它需要 Shift，实际会变成三键（<code>Alt+Shift+`</code>）；填 <code>Alt+~</code> 会自动按 <code>Alt+`</code> 处理。
          </div>
          <div v-if="shortcutMsg" class="set-desc" :class="shortcutMsg.ok ? 'sc-ok' : 'sc-err'">{{ shortcutMsg.text }}</div>
        </div>
        <div class="sc-edit">
          <el-input
            v-model="shortcutDraft"
            class="sc-input"
            size="small"
            :placeholder="app.config.schedule.shortcutToggle || '未启用'"
            @keyup.enter="saveShortcut"
          />
          <el-button size="small" type="primary" :loading="shortcutBusy" @click="saveShortcut">保存</el-button>
          <el-button size="small" :disabled="shortcutBusy || !app.config.schedule.shortcutToggle" @click="clearShortcut">清除</el-button>
        </div>
      </div>
      <!-- 轻量模式：桌面专属（Web/容器端没有窗口，开关无意义，故整体不渲染） -->
      <div v-if="isDesktop" class="set-row">
        <div class="set-info">
          <div class="set-name">轻量模式（关窗释放界面内存）</div>
          <div class="set-desc">
            {{
              lightweightDisabledReason ||
              "点关闭按钮时销毁界面进程，托盘与后台服务（反代网关）照常运行；实测省约 300 MB 内存，唤回时重新加载界面"
            }}
          </div>
        </div>
        <el-tooltip :content="lightweightDisabledReason" :disabled="!lightweightDisabledReason" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.schedule.lightweightMode, disabled: !!lightweightDisabledReason }"
            role="switch"
            :aria-checked="!!app.config.schedule.lightweightMode"
            @click="!lightweightDisabledReason && toggleLightweightMode(!app.config.schedule.lightweightMode)"
          ></div>
        </el-tooltip>
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info"><div class="set-name">版本</div></div>
        <span class="num">{{ version }} · 作者 沐晖</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">数据目录</div>
          <div class="set-desc">{{ dataDir || "（浏览器预览）" }}</div>
        </div>
        <button class="btn btn-ghost" @click="openDataDir">打开目录</button>
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
/* 快捷键的编辑区：输入框 + 按钮横排，靠右不换行 */
.sc-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.sc-input {
  width: 168px;
}
/* 校验反馈：成功绿、失败红（与全局语义色一致） */
.sc-ok {
  color: var(--ok, #3ecf8e);
}
.sc-err {
  color: var(--danger, #f56c6c);
}
/* 描述里的按键示例：等宽、淡底，与正文区分 */
.set-desc code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--code-bg);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.94em;
}

/* 板块启停开关：切换进行中半透明防连点 */
.switch.busy {
  opacity: 0.5;
  pointer-events: none;
}
</style>
