/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 模型目录的「无倍率模型」隐藏规则：按来源渠道逐个判断。
// 合并视图按精确写法分行后，一行就是一个模型（各来源写法一致），但各渠道目录的标价口径不同：
// 渠道有价而该模型没价 → 这行在它这里是查不到价格的，隐藏；
// 渠道本身不标价（Trae / ZCode / 魔搭 / Cline / 小浣熊）→ 保留，否则整渠道会被清空。
export interface RateSource {
  channel: string;
  rate: number | null;
}

/** 该行是否因「渠道有价但模型没价」而隐藏；activeTab 为空表示全部视图 */
export function hiddenByRate(sources: RateSource[], activeTab: string, channelRateFlags: Record<string, boolean>): boolean {
  const check = (d: RateSource) => channelRateFlags[d.channel] === true && d.rate == null;
  if (activeTab) {
    const d = sources.find((x) => x.channel === activeTab);
    return !!d && check(d);
  }
  return sources.some(check);
}
