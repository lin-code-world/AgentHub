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
// 反代网关 · MonkeyCode 钱包（余额）
// GET /api/v1/users/wallet → { balance（积分）, daily_token_balance（今日额度剩余）, daily_token_limit（今日额度上限） }
// 实测（在线版）：免费账号每日额度 1000 万 token，额度每日自动发放、无需手动领取。
"use strict";

const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");
const models = require("./models.cjs");

/** 拉一次钱包（原始三项）。失败抛错（带 status；401/403 已由 requestJson 归一成 401）。 */
async function fetchWallet(deps, region, section, session) {
  const base = regionStore.baseUrl(region, section);
  const payload = await models.requestJson(deps, `${base}${endpoints.WALLET_PATH}`, session, section, region, "钱包查询");
  const data = (payload && payload.data) || payload || {};
  return {
    balance: Number(data.balance) || 0,
    dailyTokenBalance: Number(data.daily_token_balance) || 0,
    dailyTokenLimit: Number(data.daily_token_limit) || 0,
  };
}

module.exports = { fetchWallet };
