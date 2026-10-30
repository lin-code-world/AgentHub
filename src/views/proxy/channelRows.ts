/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */

/** 渠道页的模型行输入：合并只需 id 与来源渠道 */
export interface ChannelRowModel {
  id: string;
  sources: string[];
}

import type { ModelCustomEntry } from "../../types";

/**
 * 渠道页：把「反向映射注入的别名行」合并进当前渠道的原生行。
 *
 * 只处理 sources 含当前渠道的行，且要求目标行也属于当前渠道——目标行不在该渠道时
 * 它本来就不会显示，再隐藏别名行等于让用户彻底看不到这个入口。
 * 大小写逐字比较：`deepseek-v4.1-flash` 与 `DeepSeek-V4.1-Flash` 是不同模型。
 */
export function mergeAliasRows(
  models: ChannelRowModel[],
  activeTab: string,
  reverseAliases: Record<string, Record<string, string>>
): { visibleIds: string[]; aliasOf: Record<string, string> } {
  if (!activeTab) return { visibleIds: models.map((m) => m.id), aliasOf: {} };
  const byId = new Map(models.map((m) => [m.id, m]));
  const hidden = new Set<string>();
  const aliasOf: Record<string, string> = {};
  for (const m of models) {
    if (!m.sources.includes(activeTab)) continue;
    const raw = (reverseAliases || {})[m.id]?.[activeTab];
    const target = typeof raw === "string" ? raw.trim() : "";
    if (!target || target === m.id) continue;
    const targetRow = byId.get(target);
    if (!targetRow || !targetRow.sources.includes(activeTab)) continue;
    hidden.add(m.id);
    aliasOf[target] = m.id;
  }
  return { visibleIds: models.map((m) => m.id).filter((id) => !hidden.has(id)), aliasOf };
}

/** 全部视图来源渠道行的最小形状（与后端 sourceDetails 对齐） */
export interface SourceDetailRow {
  channel: string;
  id: string;
  rate: number | null;
  contextLength: number;
  maxOutputTokens: number;
  capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean };
  custom?: ModelCustomEntry | null;
}

/**
 * 全部视图：按来源渠道展开行。
 *
 * 以 `sources` 为基准而不是只读 `sourceDetails`：后端只在「该渠道 catalog 有条目」时
 * 才产生明细，只按明细展开会让没有目录元数据的渠道整行消失（该来源入口就看不见了）。
 */
export function sourceRows(m: ChannelRowModel & { sourceDetails?: SourceDetailRow[] }): SourceDetailRow[] {
  const details = Array.isArray(m.sourceDetails) ? m.sourceDetails : [];
  return (m.sources || []).map((channel) => {
    const d = details.find((x) => x.channel === channel);
    return d || { channel, id: m.id, rate: null, contextLength: 0, maxOutputTokens: 0, capabilities: {} };
  });
}
