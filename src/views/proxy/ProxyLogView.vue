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
import { applyIncrement, isSnapshotCurrent, snapshotKey } from "../../utils/oplogIncrement";
import type { IncrementSnapshot } from "../../utils/oplogIncrement";
import type { ProxyOpLogRow } from "../../types";

const app = useAppStore();
/** 「导出 Excel」门控：浏览器形态服务端 deny 时置灰 + 展示下发原因，桌面（无 caps）不置灰 */
const exportGate = denyState("proxy_oplog_export");

const filter = reactive({
  from: "", // "YYYY-MM-DD"，空为不限
  to: "",
  level: "", // info / warn / error，空为全部
  op: "", // 操作分类，空为全部
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
  return { seq: fetchSeq, key: snapshotKey({ from, to, level: filter.level, op: filter.op, page: page.value }) };
}

function beginFetch(): IncrementSnapshot {
  fetchSeq++;
  return snapshotNow();
}
const error = ref("");
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
  const { from, to } = rangeToMs();
  try {
    const r = await api.proxyOpLogList({ from, to, level: filter.level || undefined, op: filter.op || undefined, limit: pageSize, offset: page.value * pageSize });
    if (!isSnapshotCurrent(issued, snapshotNow())) return; // 过期响应丢弃：期间已发起新请求 / 筛选或翻页已变
    rows.value = r?.rows || [];
    total.value = r?.total || 0;
    error.value = "";
    if (page.value === 0 && rows.value.length) lastId.value = Math.max(lastId.value, rows.value[0].id);
  } catch (e) {
    if (!isSnapshotCurrent(issued, snapshotNow())) return;
    error.value = e instanceof Error ? e.message : "加载失败";
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

/** 增量拉取：第 0 页用 sinceId 只取新日志（id 升序）交给 applyIncrement 去重拼表头；其它页新行会挤动分页，整页重拉 */
async function loadIncremental() {
  if (page.value !== 0 || lastId.value <= 0) return load();
  const issued = beginFetch();
  const { from, to } = rangeToMs();
  try {
    const r = await api.proxyOpLogList({ from, to, level: filter.level || undefined, op: filter.op || undefined, sinceId: lastId.value, limit: INC_LIMIT });
    // 过期增量（筛选切换 / 翻页 / 期间有新请求）整份丢弃；可应用才改行与基线（去重、lastId 单调见纯函数）
    const res = applyIncrement({ issued, current: snapshotNow(), rows: rows.value, added: r?.rows || [], lastId: lastId.value, pageSize, limit: INC_LIMIT });
    if (!res.applied) return;
    rows.value = res.rows;
    lastId.value = res.lastId;
    total.value = r?.total ?? total.value;
    error.value = "";
    if (res.needFullReload) void load(); // 一次增量触顶 = 没追完，回退全量拿到最新一页
  } catch (e) {
    if (!isSnapshotCurrent(issued, snapshotNow())) return;
    error.value = e instanceof Error ? e.message : "加载失败";
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
  // 新日志落库（后端 300ms 节流为 {type:"oplog"}，事件体不带内容）→ 拉增量，页面不可见不处理
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy" || p.type !== "oplog") return;
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
      load();
      loadOps();
    }
  }
);

function pickLevel(v: string) { filter.level = v || ""; page.value = 0; load(); }
function pickOp(v: string) { filter.op = v || ""; page.value = 0; load(); }
function pickFrom(v: string) { filter.from = v || ""; page.value = 0; load(); }
function pickTo(v: string) { filter.to = v || ""; page.value = 0; load(); }

async function doExport() {
  try {
    const { from, to } = rangeToMs();
    const r = await api.proxyOpLogExport({ from, to, level: filter.level || undefined, op: filter.op || undefined });
    exportMsg.value = { ok: !!r?.ok, text: r?.message || (r?.ok ? "导出成功" : "导出失败") };
  } catch (e) {
    exportMsg.value = { ok: false, text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` };
  }
  window.clearTimeout(exportMsgTimer);
  exportMsgTimer = window.setTimeout(() => { exportMsg.value = null; }, 6000);
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
        <div class="table-scroll">
          <table class="table">
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
                <td colspan="6" class="empty">当前筛选条件下没有日志{{ error ? "" : "（改一下筛选或点「刷新」）" }}</td>
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
  align-items: flex-end;
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

/* 内容列吃剩余宽度，长文本省略号（悬停 tooltip 看全） */
.log-msg {
  max-width: 0;
  min-width: 220px;
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
.empty {
  text-align: center;
  color: var(--text-3);
  padding: 24px 0;
}
</style>
