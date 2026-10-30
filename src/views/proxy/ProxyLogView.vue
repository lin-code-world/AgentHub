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
<script setup lang="ts">
// 反代网关 · 操作日志（「日志」页签）：反代网关各项操作一条一条落库（op_logs 表，stats.db），
// 这里分页展示 + 时间段/等级/操作筛选 + 导出 Excel。写入点见 backend/proxy/oplog.cjs 模块头。
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { denyState } from "../../api/caps";
import { coalesceAsync } from "../../utils/timing";
import { applyIncrement, isSnapshotCurrent, planIncrement, snapshotKey } from "../../utils/oplogIncrement";
import type { IncrementSnapshot } from "../../utils/oplogIncrement";
import { loadPhaseOf } from "./loadState";
import { fmtInt } from "./format";
import { toast as ElMessage } from "../../utils/toast";
import type { ProxyOpLogRow } from "../../types";

const app = useAppStore();
/** 「导出 Excel」门控：浏览器形态服务端 deny 时置灰 + 展示下发原因，桌面（无 caps）不置灰 */
const exportGate = denyState("proxy_oplog_export");

const filter = reactive({
  from: "", // "YYYY-MM-DD"，空为不限
  to: "",
  level: "", // info / warn / error，空为全部
  op: "", // 操作分类，空为全部
  channel: "", // 渠道 id；"__none__" = 无渠道档（网关启停/配置类日志）；空 = 全部
});

const rows = ref<ProxyOpLogRow[]>([]);
const total = ref(0);
/** 增量基线：当前页已知的最大日志 id（第 0 页即全表最新一条），准实时刷新用它拉 sinceId 增量；只增不减 */
const lastId = ref(0);
/** 一次增量最多拉这么多（store.listOpLogs 同封顶）：触顶 = 一次没追完，回退全量拿到最新一页 */
const INC_LIMIT = 200;
/** 请求序号 + 筛选快照：load / 增量共用一套守卫，过期响应（期间有更新请求、筛选或翻页已变）整份丢弃 */
let fetchSeq = 0;

function snapshotNow(): IncrementSnapshot {
  const { from, to } = rangeToMs();
  return { seq: fetchSeq, key: snapshotKey({ from, to, level: filter.level, op: filter.op, channel: filter.channel, page: page.value }) };
}

function beginFetch(): IncrementSnapshot {
  fetchSeq++;
  return snapshotNow();
}
/** 最近一次成功全量对应的筛选/分页指纹：与当前 key 不一致时 rows 不是当前视图的基底，增量必须回退全量（Ruling 35） */
let rowsKey = "";
/** 全量在飞标志：期间增量让路（不递增序号、不改 rows），防止增量抢序号把全量挤成过期响应、旧行残留不自愈（Ruling 35） */
let fullLoading = false;
const error = ref("");
/** 增量刷新失败提示（rows 非空时用）：旧行保留，顶部粘性小条提示，刷新恢复即消失。
 *  不用 toast——15s 兜底轮询会反复失败，逐次弹窗只会刷屏 */
const incError = ref("");
/** 全量在飞（首屏 / 筛选切换）：空表期间要显示「加载中」而不是「没有日志」（I6 空态三态） */
const busy = ref(false);
/** 空态三态：加载中 / 确实没有 / 加载失败（失败给重试入口，别把断网写成「暂无数据」） */
const phase = computed(() => loadPhaseOf({ loading: busy.value, error: error.value, count: rows.value.length }));
const page = ref(0);
const pageSize = 20;
const opOptions = ref<string[]>([]);
const exportMsg = ref<{ ok: boolean; text: string } | null>(null);
let exportMsgTimer = 0;

const LEVELS: Record<string, { label: string; cls: string }> = {
  info: { label: "信息", cls: "ok" },
  warn: { label: "警告", cls: "warn" },
  error: { label: "错误", cls: "err" },
};

/** 日期串 → 当日毫秒区间（本地时区），空为 null（与用量明细页同一套语义） */
function rangeToMs() {
  return {
    from: filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null,
    to: filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : null,
  };
}

function formatTs(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load() {
  const issued = beginFetch();
  fullLoading = true;
  busy.value = true;
  const { from, to } = rangeToMs();
  try {
    const r = await api.proxyOpLogList({ from, to, level: filter.level || undefined, op: filter.op || undefined, channel: filter.channel || undefined, limit: pageSize, offset: page.value * pageSize });
    if (!isSnapshotCurrent(issued, snapshotNow())) return; // 过期响应丢弃：期间已发起新请求 / 筛选或翻页已变
    rows.value = r?.rows || [];
    total.value = r?.total || 0;
    error.value = "";
    incError.value = "";
    rowsKey = issued.key; // rows 从此对应这份筛选/分页
    if (page.value === 0 && rows.value.length) lastId.value = Math.max(lastId.value, rows.value[0].id);
  } catch (e) {
    if (!isSnapshotCurrent(issued, snapshotNow())) return;
    error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    // 只有最新一次全量收尾才放行增量：并发 load 时提前清标志，会让增量插进未完成的全量里
    if (issued.seq === fetchSeq) {
      fullLoading = false;
      busy.value = false;
    }
  }
}

async function loadOps() {
  // 操作类型下拉从真实数据动态生成，避免硬编码漏项；失败保留旧选项
  try {
    opOptions.value = await api.proxyOpLogOps();
  } catch {
    /* 下拉选项加载失败不阻断列表使用 */
  }
}

/** 渠道下拉选项：「上游启闭」里已开启的渠道（proxy_channel_list，enabled !== false）；失败保留旧选项不阻断列表 */
const channelOptions = ref<{ id: string; display: string }[]>([]);
async function loadChannels() {
  try {
    const list = await api.proxyChannelList();
    channelOptions.value = list.filter((c) => c.enabled !== false).map((c) => ({ id: c.id, display: c.display }));
  } catch {
    /* 渠道选项加载失败不阻断列表使用 */
  }
}

/** 增量拉取：入口先走 planIncrement（Ruling 35）——全量在飞让路、基底不匹配回退全量；可增量才拉 sinceId 交给 applyIncrement 去重拼表头 */
async function loadIncremental() {
  const plan = planIncrement({ fullLoading, rowsKey, currentKey: snapshotNow().key, lastId: lastId.value, page: page.value });
  if (plan === "skip") return; // 全量在飞：不递增序号、不改 rows
  if (plan === "full") return load(); // rows 不是当前视图基底（含非第 0 页 / 无基线）：回退全量
  const issued = beginFetch();
  const { from, to } = rangeToMs();
  try {
    const r = await api.proxyOpLogList({ from, to, level: filter.level || undefined, op: filter.op || undefined, channel: filter.channel || undefined, sinceId: lastId.value, limit: INC_LIMIT });
    // 过期增量（筛选切换 / 翻页 / 期间有新请求）整份丢弃；可应用才改行与基线（去重、lastId 单调见纯函数）
    const res = applyIncrement({ issued, current: snapshotNow(), rows: rows.value, added: r?.rows || [], lastId: lastId.value, pageSize, limit: INC_LIMIT });
    if (!res.applied) return;
    rows.value = res.rows;
    lastId.value = res.lastId;
    total.value = r?.total ?? total.value;
    error.value = "";
    incError.value = ""; // 刷新恢复正常：撤掉「已保留上次数据」提示条
    if (res.needFullReload) void load(); // 一次增量触顶 = 没追完，回退全量拿到最新一页
  } catch (e) {
    if (!isSnapshotCurrent(issued, snapshotNow())) return;
    const msg = e instanceof Error ? e.message : "加载失败";
    error.value = msg;
    // rows 非空：旧行保留（不改 rows），另给一条可见提示（顶部小条）
    if (rows.value.length) incError.value = msg;
  }
}

/** 本页是否处于前台：页面经 v-show 保活，事件刷新只在激活时跑，切走即停 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "proxylog");
// 事件与 15s 兜底轮询共用一条 2s 节流（准实时也「最多 2 秒刷新一次」）
const scheduleLiveRefresh = coalesceAsync(loadIncremental, 2000);
let liveTimer = 0;
let offEvent: (() => void) | undefined;

onMounted(() => {
  load();
  loadOps();
  loadChannels();
  // 新日志落库（后端 300ms 节流为 {type:"oplog"}，事件体不带内容）→ 拉增量，页面不可见不处理；
  // resync = SSE 断线重连后的补偿信号（断线期间可能漏了事件，也可能被清理过），走一次全量
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if (p.type === "resync") {
      if (active.value) load();
      return;
    }
    if (p.type !== "oplog") return;
    if (!active.value) return;
    scheduleLiveRefresh();
  });
  // 15s 兜底轮询：事件丢失（断流 / 休眠唤醒）时补一针，页面不可见不执行
  liveTimer = window.setInterval(() => {
    if (active.value) scheduleLiveRefresh();
  }, 15000);
});

onUnmounted(() => {
  window.clearInterval(liveTimer);
  scheduleLiveRefresh.cancel();
  if (offEvent) offEvent();
});

// v-show 常驻页：切回该页时刷新（新操作随时产生，重进页面就要看到最新）
watch(
  () => app.activePage,
  (p) => {
    if (p === "proxylog") {
      // 号池页「日志」按钮跳转：筛选全部重置为默认后按传入渠道查询（页码归 0；消费在前，load 才会用新筛选发请求）
      if (app.pendingLogChannel) {
        filter.from = "";
        filter.to = "";
        filter.level = "";
        filter.op = "";
        filter.channel = app.pendingLogChannel;
        app.pendingLogChannel = "";
        page.value = 0;
      }
      load();
      loadOps();
      loadChannels();
    }
  }
);

function pickLevel(v: string) { filter.level = v || ""; page.value = 0; load(); }
function pickOp(v: string) { filter.op = v || ""; page.value = 0; load(); }
function pickChannel(v: string) { filter.channel = v || ""; page.value = 0; load(); }
function pickFrom(v: string) { filter.from = v || ""; page.value = 0; load(); }
function pickTo(v: string) { filter.to = v || ""; page.value = 0; load(); }

async function doExport() {
  try {
    const { from, to } = rangeToMs();
    const r = await api.proxyOpLogExport({ from, to, level: filter.level || undefined, op: filter.op || undefined, channel: filter.channel || undefined });
    exportMsg.value = { ok: !!r?.ok, text: r?.message || (r?.ok ? "导出成功" : "导出失败") };
  } catch (e) {
    exportMsg.value = { ok: false, text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` };
  }
  window.clearTimeout(exportMsgTimer);
  exportMsgTimer = window.setTimeout(() => { exportMsg.value = null; }, 6000);
}

// ===== 清理操作日志：交互与总览页的清理一致（仅超期 / 全部），清的就是本页展示的数据（op_logs 表）。
// 保留期固定 30 天（与启动 GC 同口径，op_logs 没有可配的保留期），不可恢复所以先问一道。
const cleanOpen = ref(false);
const cleanScope = ref<"expired" | "all">("expired");
const cleaning = ref(false);
function openClean() {
  cleanScope.value = "expired"; // 每次打开回默认档，防上次选的「全部」被顺手确认
  cleanOpen.value = true;
}
async function doCleanup() {
  cleaning.value = true;
  try {
    const all = cleanScope.value === "all";
    const r = await api.proxyOpLogCleanup(undefined, all);
    ElMessage.success(all ? `已清空全部日志 ${fmtInt(r.deleted)} 条` : `已清理 30 天之前的日志 ${fmtInt(r.deleted)} 条`);
    cleanOpen.value = false;
    page.value = 0; // 与总览一致：清理后回到第一页，避免当前页已超范围
    load();
    loadOps();
  } catch (e) {
    ElMessage.error(`清理失败：${e instanceof Error ? e.message : "未知错误"}`);
  } finally {
    cleaning.value = false;
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">日志</div>
        <div class="page-sub">反代网关各项操作记录（代理请求 / 签到 / 账号 / 配置等），本地存储 30 天；等级：信息=成功 · 警告=需人工/4xx · 错误=失败</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" @click="load(); loadOps()">刷新</button>
        <button class="btn" @click="openClean"><i class="ph ph-broom"></i> 清理</button>
      </div>
    </div>
    <div class="page-body">
      <div class="log-filters">
        <div class="log-fgroup"><label>开始日期</label>
          <el-date-picker
            :model-value="filter.from"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不限"
            popper-class="glass-popper"
            class="f-date"
            @update:model-value="pickFrom"
          />
        </div>
        <div class="log-fgroup"><label>结束日期</label>
          <el-date-picker
            :model-value="filter.to"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不限"
            popper-class="glass-popper"
            class="f-date"
            @update:model-value="pickTo"
          />
        </div>
        <div class="log-fgroup"><label>等级</label>
          <el-select :model-value="filter.level" placeholder="全部等级" popper-class="glass-popper" class="f-el-select" @update:model-value="pickLevel">
            <el-option value="" label="全部等级" />
            <el-option value="info" label="信息" />
            <el-option value="warn" label="警告" />
            <el-option value="error" label="错误" />
          </el-select>
        </div>
        <div class="log-fgroup"><label>操作</label>
          <el-select :model-value="filter.op" placeholder="全部操作" popper-class="glass-popper" class="f-el-select" @update:model-value="pickOp">
            <el-option value="" label="全部操作" />
            <el-option v-for="o in opOptions" :key="o" :value="o" :label="o" />
          </el-select>
        </div>
        <div class="log-fgroup"><label>渠道</label>
          <el-select :model-value="filter.channel" placeholder="全部渠道" popper-class="glass-popper" class="f-el-select" @update:model-value="pickChannel">
            <el-option value="" label="全部渠道" />
            <el-option v-for="c in channelOptions" :key="c.id" :value="c.id" :label="c.display" />
            <el-option value="__none__" label="其他" />
          </el-select>
        </div>
        <div style="flex: 1"></div>
        <span v-if="error" style="font-size: 12px; color: var(--err)">{{ error }}</span>
        <el-tooltip v-else-if="exportMsg" :content="exportMsg.text" placement="top">
          <span :style="{ fontSize: '12px', color: exportMsg.ok ? 'var(--ok)' : 'var(--err)', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }">{{ exportMsg.text }}</span>
        </el-tooltip>
        <el-tooltip :content="exportGate.reason || ''" :disabled="!exportGate.disabled" placement="top">
          <span><button class="btn-outline" :disabled="exportGate.disabled" @click="doExport">导出 Excel</button></span>
        </el-tooltip>
      </div>

      <div class="card">
        <!-- 增量刷新失败但表里还有旧数据：旧行保留 + 顶部小条提示（刷新恢复即消失，不逐次弹窗） -->
        <div v-if="incError" class="inc-warn">日志增量刷新失败，已保留上次数据：{{ incError }} <button class="btn-link btn-sm" @click="incError = ''; load()">重试</button></div>
        <div class="table-scroll">
          <table class="table log-table">
            <thead><tr>
              <th>时间</th><th>等级</th><th>操作</th><th>渠道</th><th>对象</th><th>内容</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.id">
                <td class="mono nowrap">{{ formatTs(r.ts) }}</td>
                <td><span class="log-pill" :class="LEVELS[r.level]?.cls || 'ok'">{{ LEVELS[r.level]?.label || r.level }}</span></td>
                <td class="nowrap">{{ r.op }}</td>
                <td class="nowrap">{{ r.channel || "—" }}</td>
                <td class="nowrap" :title="r.target">{{ r.target || "—" }}</td>
                <td class="log-msg">
                  <el-tooltip :content="r.detail || r.message" :disabled="!(r.detail && r.detail !== r.message)" placement="top">
                    <span>{{ r.message }}<template v-if="r.detail && r.detail !== r.message"> <span class="log-detail">· {{ r.detail }}</span></template></span>
                  </el-tooltip>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" class="empty">
                  <template v-if="phase === 'loading'">加载中…</template>
                  <template v-else-if="phase === 'failed'">加载失败：{{ error }} <button class="btn-link btn-sm" @click="load">重试</button></template>
                  <template v-else>当前筛选条件下没有日志（改一下筛选或点「刷新」）</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span class="pg-info">共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages }} 页</span>
          <button class="btn-ghost" :disabled="page === 0" @click="page--; load()">上一页</button>
          <button class="btn-ghost" :disabled="(page + 1) * pageSize >= total" @click="page++; load()">下一页</button>
        </div>
      </div>
    </div>

    <!-- 清理确认弹窗：与总览页同一套版式与文案（删的是不可恢复的请求流水） -->
    <Teleport to="body">
      <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">清理操作日志</div>
          <div class="chips" style="margin-bottom: 8px">
            <button class="chip" :class="{ active: cleanScope === 'expired' }" @click="cleanScope = 'expired'">仅超期日志</button>
            <button class="chip" :class="{ active: cleanScope === 'all' }" @click="cleanScope = 'all'">全部日志</button>
          </div>
          <div class="set-desc">
            <template v-if="cleanScope === 'expired'"> 将删除 30 天之前的全部操作日志（与启动时自动回收的保留期一致），此操作不可恢复。 </template>
            <template v-else> 将清空<b>整张操作日志表</b>（含当前筛选范围之外的全部记录），此操作不可恢复。 </template>
          </div>
          <div class="p-actions">
            <button class="btn" @click="cleanOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">{{ cleaning ? "清理中…" : cleanScope === "all" ? "全部清空" : "确认清理" }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方表格区（对齐用量明细页的筛选栏配方）；
   .filters/.f-group 被用量模块的 sync-scope 作用域占用，这里自备同款配方 */
.log-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
  padding: 12px 14px;
  background: var(--glass-bg);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.log-fgroup {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.log-fgroup label {
  font-size: 11px;
  color: var(--text-3);
}

/* 筛选区的 el 控件：宽度对齐 f-el-select（el 组件模板根是多节点结构，scoped data-v
   透传不到 .el-select/.el-date-editor 根上，必须借后代 :deep 穿透） */
.log-filters :deep(.f-date),
.log-filters :deep(.f-el-select) {
  width: 150px;
}
.log-filters :deep(.f-date .el-input__wrapper),
.log-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 34px;
  font-size: 13px;
}

/* 等级胶囊（.pill 被用量模块的 sync-scope 作用域占用，这里自备同款配方） */
.log-pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  white-space: nowrap;
}
.log-pill.ok {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}
.log-pill.warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.log-pill.err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

/* 非内容列（时间/等级/操作/渠道/对象）的值居中；表头本就全局居中（global.css） */
.log-table td:not(.log-msg) {
  text-align: center;
}

/* 内容列吃剩余宽度、宽度加大（其他列 nowrap 自然收缩到内容宽度），长文本省略号（悬停 tooltip 看全） */
.log-msg {
  width: 100%;
  min-width: 340px;
}
.log-msg span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-detail {
  color: var(--text-3);
}
.nowrap {
  white-space: nowrap;
}
.mono {
  font-family: var(--font-mono, monospace);
}
/* 增量刷新失败提示条（rows 非空时的可见兜底，刷新恢复即消失） */
.inc-warn {
  margin: 10px 12px 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}
.empty {
  text-align: center;
  color: var(--text-3);
  padding: 24px 0;
}
</style>
