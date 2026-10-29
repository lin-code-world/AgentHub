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
// 反代网关 · 单来源无账号模型的自动关闭
//
// 规则：合并目录里一个模型只有一个来源渠道，而该渠道一个账号都没配时，模型默认关闭。
// 关闭直接写进现有 disabledModels 固化——之后新增账号不会自动打开（需用户手动开），
// 账号删光后下一次判定会重新关闭。判定幂等，不新增任何配置字段。
"use strict";
const config = require("../config.cjs");
const store = require("./store.cjs");
const adapters = require("./adapters.cjs");

/** 纯判定：单来源且该渠道账号条目数为 0 的模型 id（保留原始大小写）。
 *  冷却 / 余额耗尽 / token 失效都不算无账号——只看「配没配」，避免开关随账号状态抖动。 */
function accountlessIds(models, accountCountByChannel) {
  const out = new Set();
  for (const m of Array.isArray(models) ? models : []) {
    const sources = Array.isArray(m && m.sources) ? m.sources : [];
    if (sources.length !== 1) continue;
    if ((accountCountByChannel[sources[0]] || 0) > 0) continue;
    out.add(m.id);
  }
  return out;
}

/** 全量账号按渠道计数（自定义提供商的 Key 与内置渠道账号同表）。 */
function accountCounts() {
  const counts = Object.create(null);
  for (const a of store.listAccounts()) counts[a.channel] = (counts[a.channel] || 0) + 1;
  return counts;
}

/** 读磁盘配置 + 合并目录，把无账号单源模型幂等写入 disabledModels。
 *  返回本次判定用的目录与结果，供 proxy_models 复用，避免再算一遍 mergedModels。 */
function sync() {
  const cfg = config.loadConfig();
  const proxy = cfg.proxy || {};
  const models = adapters.mergedModels(proxy);
  const accountless = accountlessIds(models, accountCounts());
  const disabled = Array.isArray(proxy.disabledModels) ? proxy.disabledModels.slice() : [];
  const seen = new Set(disabled);
  let changed = false;
  for (const id of accountless) {
    if (seen.has(id)) continue;
    seen.add(id);
    disabled.push(id);
    changed = true;
  }
  if (changed) {
    // 以最新磁盘配置为底只改 disabledModels：同期用户可能刚保存过其它反代配置，
    // 用先前读到的 cfg 整份回写会把那些改动覆盖掉
    const disk = config.loadConfig();
    disk.proxy = disk.proxy || {};
    disk.proxy.disabledModels = disabled;
    config.saveConfig(disk);
  }
  return { models, accountless, disabledModels: disabled, changed };
}

module.exports = { accountlessIds, accountCounts, sync };
