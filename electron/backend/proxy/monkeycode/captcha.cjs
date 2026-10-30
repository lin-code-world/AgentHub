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
// 反代网关 · MonkeyCode 签到验证码（Cap.js 工作量证明）
//
// 上游签到要先过一次人机校验：POST /api/v1/public/captcha/challenge 取题（c 个子挑战、
// salt 与 target 的长度 s/d），本地对每个子挑战挖出满足「sha256(salt+nonce) 的十六进制前缀 ==
// target」的 nonce，再 POST /api/v1/public/captcha/redeem 换取签到用的 captcha_token。
//
// 随机数发生器必须与上游 widget 的 FNV-1a + xorshift32 逐位一致（否则挖出来的解上游不认）。
// 两个端点都是公开的（不带登录态）。实测难度 c=50 / s=32 / d=3，本地同步求解约 0.6 秒。
"use strict";

const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");

const FNV_OFFSET = 0x811c9dc5;
const MAX_NONCE = 1 << 26; // 单个子挑战的 nonce 搜索上限（d 升到 6 也够用）

/** FNV-1a 32bit（与 cap.js 实现一致） */
function fnv1a(text) {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
  }
  return h >>> 0;
}

/** 确定性 PRNG：FNV-1a 播种 + xorshift32，输出 length 位十六进制串 */
function prng(seed, length) {
  let state = fnv1a(seed);
  let out = "";
  while (out.length < length) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/** 求单个子挑战的 nonce */
function solveSub(token, idx, saltLen, targetLen) {
  const salt = prng(token + String(idx), saltLen);
  const target = prng(token + String(idx) + "d", targetLen);
  for (let n = 0; n < MAX_NONCE; n++) {
    const digest = crypto.createHash("sha256").update(salt + String(n)).digest("hex");
    if (digest.slice(0, targetLen) === target) return n;
  }
  throw new Error(`验证码子挑战 ${idx} 未在 ${MAX_NONCE} 次内解出`);
}

/**
 * 完成一次完整验证码流程，返回可交给签到的 captcha_token。
 * 失败一律抛错（带可读文案）。两个端点公开，不需要 session。
 */
async function solveCaptcha(deps, region, section) {
  const base = regionStore.baseUrl(region, section);
  const ch = await deps.httpJson(`${base}${endpoints.CAPTCHA_CHALLENGE_PATH}`, { method: "POST" });
  if (!ch || !ch.ok) throw new Error(`验证码取题失败（HTTP ${(ch && ch.status) || 0}）`);
  const body = ch.data || {};
  const cfg = body.challenge || {};
  const c = Number(cfg.c) || 0;
  const s = Number(cfg.s) || 0;
  const d = Number(cfg.d) || 0;
  const token = String(body.token || "");
  if (!token || c <= 0 || s <= 0 || d <= 0) throw new Error("验证码取题响应不完整（上游形态变化？）");
  const solutions = [];
  for (let i = 1; i <= c; i++) solutions.push(solveSub(token, i, s, d));
  const rd = await deps.httpJson(`${base}${endpoints.CAPTCHA_REDEEM_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, solutions }),
  });
  if (!rd || !rd.ok) throw new Error(`验证码兑换失败（HTTP ${(rd && rd.status) || 0}）`);
  const redeem = rd.data || {};
  if (redeem.success !== true || !redeem.token) throw new Error("验证码兑换未通过（上游拒绝）");
  return String(redeem.token);
}

module.exports = { solveCaptcha, fnv1a, prng, solveSub };
