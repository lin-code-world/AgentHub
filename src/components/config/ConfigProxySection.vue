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
<!-- 反代网关 · 设置弹窗板块：请求与路由
     设置读写框架整体配置（config.json 的 proxy 段）：桌面走整份 save_config，浏览器形态走 proxy_config_get / proxy_config_save 只读写反代段；
     端口 / 绑定已移入「设置 · 局域网访问」（那里保存并重启），预警阈值与保留期已移入「设置 · 监控与安全」，不在这里 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import * as api from "../../api/ipc";
import { isWebTransport } from "../../api/caps";
import type { ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const saving = ref(false);
const msg = ref("");
const msgErr = ref(false);
/** 浏览器托管形态：load_config / save_config 被 deny，反代配置段走 proxy_config_get / proxy_config_save */
const webForm = computed(() => isWebTransport());
// 优先渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
// 全局回退模型候选 = 合并模型目录
const models = ref<ProxyModel[]>([]);

// 渠道降级时长：后端存毫秒，界面按秒编辑（免敲六个零）。
// set 用 Number.isFinite 判数（|| 会把合法的 0 当 falsy 跳回默认），非法输入回默认再钳最小 10s
const channelCooldownSec = computed({
  get: () => Math.round((Number(app.config.proxy.channelCooldownMs) || 120000) / 1000),
  set: (v: number) => {
    const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : 120;
    app.config.proxy.channelCooldownMs = Math.max(10, n) * 1000;
  },
});
const channelCooldownCapSec = computed({
  get: () => Math.round((Number(app.config.proxy.channelCooldownCapMs) || 900000) / 1000),
  set: (v: number) => {
    const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : 900;
    app.config.proxy.channelCooldownCapMs = Math.max(10, n) * 1000;
  },
});

async function refresh() {
  try {
    // 浏览器托管形态拿不到整份配置（load_config 被 deny），反代配置段单独读真实值回填表单
    if (webForm.value) {
      const remote = await api.proxyConfigGet().catch(() => null);
      if (remote) app.config.proxy = remote;
    }
    channels.value = await api.proxyPool().catch(() => channels.value);
    models.value = await api.proxyModels().catch(() => models.value);
  } catch {
    /* 取不到就保留现有候选 */
  }
}

// 每次激活（设置弹窗打开且停在反代网关板块）都重拉渠道与模型目录（渠道 / 模型可能变动）
const active = computed(() => app.settingsOpen && app.settingsTab === "proxy");
watch(
  active,
  (v) => {
    if (v) refresh();
  },
  { immediate: true }
);

/** 请求与路由改动即存：桌面走整份 save_config，浏览器走 proxy_config_save 反代段；
 *  端口/绑定/调试端点已移入「局域网访问」板块（那里保存并重启），此处提交整份反代段仍保证端口合法 */
async function saveRoute() {
  if (saving.value) return;
  saving.value = true;
  msg.value = "";
  try {
    const port = Math.round(Number(app.config.proxy.port));
    if (!Number.isFinite(port) || port < 1 || port > 65534) {
      // 管理端口 = 反代端口 + 1：65535 会让管理端口越界，管理页静默消失（I2）
      msg.value = "端口非法（管理端口 = 端口 + 1，65535 会越界），请到「局域网访问」板块修正后再试";
      msgErr.value = true;
      return;
    }
    app.config.proxy.port = port;
    app.config.proxy.rateLimitPerMin = Math.max(0, Math.round(Number(app.config.proxy.rateLimitPerMin) || 0));
    app.config.proxy.concurrency = Math.max(1, Math.round(Number(app.config.proxy.concurrency) || 1));
    app.config.proxy.channelFailoverMax = Math.min(10, Math.max(1, Math.round(Number(app.config.proxy.channelFailoverMax) || 3)));
    // 判数用 Number.isFinite 而不是 ||：合法的 0（= 关闭预警）会被 || 当 falsy 跳回默认值
    const esd = Number(app.config.proxy.expiringSoonDays);
    app.config.proxy.expiringSoonDays = Math.min(3650, Math.max(0, Math.round(Number.isFinite(esd) ? esd : 1)));
    // 保留期只认 1~3650：非正值（0 / 负数 / 空串 / 垃圾）一律兜底默认 90，与 ConfigTimingSection 同口径
    const urd = Number(String(app.config.proxy.usageRetentionDays ?? "").trim() || NaN);
    app.config.proxy.usageRetentionDays = Number.isFinite(urd) && Math.round(urd) >= 1 ? Math.min(3650, Math.round(urd)) : 90;
    app.config.proxy.channelCooldownMs = Math.max(10000, Math.round(Number(app.config.proxy.channelCooldownMs) || 120000));
    app.config.proxy.channelCooldownCapMs = Math.max(app.config.proxy.channelCooldownMs, Math.round(Number(app.config.proxy.channelCooldownCapMs) || 900000));
    const r = webForm.value ? await api.proxyConfigSave(app.config.proxy).catch((e: Error) => ({ ok: false, message: String(e.message || e) })) : await app.save();
    if (r && r.ok === false) {
      msg.value = r.message || "保存失败";
      msgErr.value = true;
      return;
    }
    msg.value = "已保存";
    msgErr.value = false;
  } finally {
    saving.value = false;
    await refresh();
  }
}
</script>

<template>
  <div class="cfg-sec">
    <div class="card">
      <div class="card-title">
        请求与路由
        <span v-if="msg" class="tag" :class="msgErr ? 'tag-err' : 'tag-ok'" style="margin-left: 8px">{{ msg }}</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">默认路由策略</div>
          <div class="set-desc">模型仅存在于单渠道时强制走该渠道，此策略处理多源重叠</div>
        </div>
        <el-select v-model="app.config.proxy.routeStrategy" class="f-el-select" popper-class="glass-popper" style="width: 208px" @change="saveRoute">
          <el-option value="smart" label="智能路由（健康度 × 余额打分）" />
          <el-option value="fixed" label="指定渠道优先" />
        </el-select>
      </div>
      <div class="set-row" v-if="app.config.proxy.routeStrategy === 'fixed'">
        <div class="set-info"><div class="set-name">优先渠道</div></div>
        <el-select v-model="app.config.proxy.fixedChannel" class="f-el-select" popper-class="glass-popper" style="width: 208px" @change="saveRoute">
          <el-option v-for="c in channels" :key="c.id" :value="c.id" :label="c.display" />
        </el-select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">渠道优先顺序</div>
          <div class="set-desc">智能打分 = 按健康度 × 余额排序（默认）；免费优先 = 魔搭等免费/低成本渠道的额度优先消耗，不可用（耗尽/降级）时自动落付费渠道，恢复后自动回切。免费额度每日限量，耗尽属正常现象；Key 上可单独覆盖</div>
        </div>
        <el-select v-model="app.config.proxy.routeOrder" class="f-el-select" popper-class="glass-popper" style="width: 208px" @change="saveRoute">
          <el-option value="score" label="智能打分（默认）" />
          <el-option value="cost-first" label="免费 / 低成本优先" />
        </el-select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">单 Key 限速</div>
          <div class="set-desc">令牌桶；新 Key 默认继承，Key 上可单独覆盖</div>
        </div>
        <input v-model.number="app.config.proxy.rateLimitPerMin" class="input mono" style="width: 90px" type="number" min="0" @change="saveRoute" />
        <span style="font-size: 11px; color: var(--text-3)">次 / 分钟</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">单渠道并发上限</div>
          <div class="set-desc">每个渠道同时打上游的请求数；打满只跳备选渠道，不拒绝请求（旧版按全渠道合计、会误伤空闲渠道）</div>
        </div>
        <input v-model.number="app.config.proxy.concurrency" class="input mono" style="width: 90px" type="number" min="1" @change="saveRoute" />
        <span style="font-size: 11px; color: var(--text-3)">并发</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">拟人抖动（防监测）</div>
          <div class="set-desc">每次上游请求前随机停 40~220ms，模拟真实客户端节奏，降低被风控识别为反代的概率</div>
        </div>
        <button
          class="switch"
          :class="{ on: app.config.proxy.humanizeJitter }"
          @click="
            app.config.proxy.humanizeJitter = !app.config.proxy.humanizeJitter;
            saveRoute();
          "
        ></button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">跨渠道故障转移</div>
          <div class="set-desc">渠道报 503/429 或号池耗尽时，请求内自动跳到其他渠道（按余额充足度排序），客户端无感；关闭后只在单渠道内换号</div>
        </div>
        <button
          class="switch"
          :class="{ on: app.config.proxy.channelFailover !== false }"
          @click="
            app.config.proxy.channelFailover = app.config.proxy.channelFailover === false;
            saveRoute();
          "
        ></button>
      </div>
      <template v-if="app.config.proxy.channelFailover !== false">
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">单请求最多尝试渠道数</div>
            <div class="set-desc">范围 1~10；超出上限按 10 保存（上游尝试预算随上限放大：每模型 上限+1 次、最低 6 次）</div>
          </div>
          <input v-model.number="app.config.proxy.channelFailoverMax" class="input mono" style="width: 90px" type="number" min="1" max="10" @change="saveRoute" />
          <span style="font-size: 11px; color: var(--text-3)">个（含主渠道）</span>
        </div>
        <div class="set-row">
          <div class="set-info"><div class="set-name">降级基础时长</div></div>
          <input v-model.number="channelCooldownSec" class="input mono" style="width: 90px" type="number" min="10" @change="saveRoute" />
          <span style="font-size: 11px; color: var(--text-3)">秒（失败翻倍）</span>
        </div>
        <div class="set-row">
          <div class="set-info"><div class="set-name">降级时长封顶</div></div>
          <input v-model.number="channelCooldownCapSec" class="input mono" style="width: 90px" type="number" min="10" @change="saveRoute" />
          <span style="font-size: 11px; color: var(--text-3)">秒</span>
        </div>
      </template>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">不可用时自动切换模型</div>
          <div class="set-desc">统一设置（默认开）：模型未知或号池耗尽时自动切到下方回退模型，客户端无感（响应模型字段保持请求值）</div>
        </div>
        <button
          class="switch"
          :class="{ on: app.config.proxy.autoFallbackEnabled !== false }"
          @click="
            app.config.proxy.autoFallbackEnabled = app.config.proxy.autoFallbackEnabled === false;
            saveRoute();
          "
        ></button>
      </div>
      <div class="set-row" v-if="app.config.proxy.autoFallbackEnabled !== false">
        <div class="set-info">
          <div class="set-name">全局回退模型</div>
          <div class="set-desc">候选来自合并模型目录；留空则不切换</div>
        </div>
        <el-select v-model="app.config.proxy.fallbackModel" class="f-el-select" popper-class="glass-popper" style="width: 208px" filterable @change="saveRoute">
          <el-option value="" label="（不回退）" />
          <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.id" />
        </el-select>
      </div>
    </div>
  </div>
</template>
