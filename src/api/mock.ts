/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 浏览器 mock：dev:web 纯前端预览用；配置落 localStorage，语义与主进程 config.cjs 对齐
// 未覆盖的命令返回 null 让页面降级
import type { AppConfig } from "../types";
import { MODULES } from "../types";
// 版本号唯一事实源 = 仓库根 package.json 的 version（与桌面端 app.getVersion 同源）
import pkg from "../../package.json";

const KEY = "agenthub-config";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
/** 本地时区的今天（YYYY-MM-DD）：与后端 store.dayStr 同口径，签到记录的跨天判定用 */
const TODAY = (() => {
  const d = new Date(NOW);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

function defaultConfig(): AppConfig {
  return {
    theme: "dark",
    admin: { token: "" },
    schedule: { minimizeToTray: true, autoStart: true },
    proxy: {
      port: 9527,
      bind: "127.0.0.1",
      routeStrategy: "smart",
      fixedChannel: "trae",
      routeOrder: "score",
      rateLimitPerMin: 120,
      concurrency: 8,
    creditsRefreshMin: 30,
    usageRetentionDays: 90,
    expiringSoonDays: 1,
    debugStatus: false,
      modelOverrides: {},
      humanizeJitter: true,
      disabledModels: [],
      modelFallback: {},
      modelAliases: { "gpt-4o": "kimi-k3" },
      modelReverseAliases: {},
      modelCustom: {},
      autoFallbackEnabled: true,
      fallbackModel: "glm-5.2",
      channelFailover: true,
      channelFailoverMax: 3,
      channelCooldownMs: 120000,
      channelCooldownCapMs: 900000,
      channelEnabled: {},
      checkinAutoRules: {},
    },
  };
}

function read(): AppConfig {
  const def = defaultConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "");
    if (!saved || typeof saved !== "object") return def;
    const theme = saved.theme === "light" ? "light" : "dark";
    return { ...def, ...saved, theme };
  } catch {
    return def;
  }
}

// ===== 反代网关样例数据（浏览器预览；桌面端数据来自主进程 SQLite） =====

const PROXY_KEYS = [
  { id: "k1", name: "本地主 Key", mask: "sk-9f2c···d41a", secret: "sk-9f2c1e5b8a4d47c2b6f0e3d1a9c87b52e4f6a0d3c1b2a4e6", route: "auto", routeOrder: "", dailyQuota: 2000, rateLimit: 0, enabled: true, createdAt: NOW - 12 * 86400000, todayReq: 612, todayTokens: 148200 },
  { id: "k2", name: "Trae 专用", mask: "sk-31bc···77e0", secret: "sk-31bc74f0d9e2a6c8b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a1", route: "trae", routeOrder: "", dailyQuota: 1000, rateLimit: 0, enabled: true, createdAt: NOW - 9 * 86400000, todayReq: 403, todayTokens: 96400 },
  { id: "k3", name: "WorkBuddy 专用", mask: "sk-d07e···a2c9", secret: "sk-d07e2b8d4f6a9c1e3b5d7f9a2c4e6b8d0f2a4c6e8b1d3f5a", route: "workbuddy", routeOrder: "", dailyQuota: 800, rateLimit: 60, enabled: true, createdAt: NOW - 5 * 86400000, todayReq: 269, todayTokens: 67800 },
  // 旧版本创建的 Key（无加密存档）：列表不带 secret，不能反查完整 Key
  { id: "k4", name: "旧测试 Key", mask: "sk-4419···0b3f", secret: "", route: "auto", routeOrder: "", dailyQuota: 100, rateLimit: 0, enabled: false, createdAt: NOW - 30 * 86400000, todayReq: 0, todayTokens: 0 },
];

const PROXY_POOL = [
  {
    id: "trae", display: "Trae SOLO CN", domain: "api.trae.cn", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: true, time: "08:30", jitterMin: 15 },
    summary: { channel: "trae", totalCredits: 72480, accountCount: 2, onlineCount: 2, earliestExpire: NOW + 48 * 86400000, expiringSoon: false, todayReq: 412, todayTokens: 96400, lastCreditsAt: ago(25) },
    accounts: [
      // 今日已签到（行内按钮"已签到"态；点开看今日详情）
      { id: "a1", channel: "trae", uid: "88213476", name: "主账号 · 沐", status: "online", credits: 51230, creditsAt: ago(25), expiresAt: NOW + 48 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(3), todayReq: 301, todayTokens: 70200, createdAt: NOW - 20 * 86400000, hasToken: true, packages: [{ code: "trae-solo", name: "SOLO 基础包", total: 40000, used: 0, remaining: 40000, expiresAt: NOW + 48 * 86400000, expired: false, expiringSoon: false }, { code: "trae-boost", name: "SOLO 加油包", total: 20000, used: 8770, remaining: 11230, expiresAt: NOW + 12 * 86400000, expired: false, expiringSoon: false }], checkin: { day: TODAY, at: NOW - 3600000, action: "checkin", ok: true, credit: 100, streakDays: 5, message: "签到成功" } },
      // 今日签到失败（行内按钮"签到失败"态；点开看失败原因）
      { id: "a2", channel: "trae", uid: "90247811", name: "备用号", status: "online", credits: 21250, creditsAt: ago(25), expiresAt: NOW + 21 * 86400000, coolUntil: 0, coolReason: "", source: "paste", lastUsed: ago(40), todayReq: 111, todayTokens: 26200, createdAt: NOW - 6 * 86400000, hasToken: true, packages: [{ code: "trae-old", name: "去年双十一赠送包", total: 5000, used: 0, remaining: 5000, expiresAt: NOW - 3 * 86400000, expired: true, expiringSoon: false }, { code: "trae-solo2", name: "SOLO 基础包", total: 25000, used: 3750, remaining: 21250, expiresAt: NOW + 21 * 86400000, expired: false, expiringSoon: false }], checkin: { day: TODAY, at: NOW - 3000000, action: "checkin", ok: false, message: "上游 429：签到请求过于频繁，请稍后重试" } },
    ],
  },
  {
    id: "workbuddy", display: "WorkBuddy CN", domain: "copilot.tencent.com", costTier: "", poolStrategy: "credit_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "workbuddy", totalCredits: 34120, accountCount: 2, onlineCount: 1, earliestExpire: NOW + 12 * 86400000, expiringSoon: false, todayReq: 203, todayTokens: 41200, lastCreditsAt: ago(40) },
    accounts: [
      // 该渠道今日已全部签完（工具栏按钮应显示"签到成功"完成态）
      { id: "a3", channel: "workbuddy", uid: "wb_7c21", name: "工作号", status: "online", credits: 34120, creditsAt: ago(40), expiresAt: NOW + 12 * 86400000, coolUntil: 0, coolReason: "", source: "scan", lastUsed: ago(8), todayReq: 203, todayTokens: 41200, createdAt: NOW - 15 * 86400000, hasToken: true, packages: [{ code: "wb-base", name: "CodeBuddy 个人版月度包", total: 30000, used: 0, remaining: 30000, expiresAt: NOW + 12 * 86400000, expired: false, expiringSoon: false }, { code: "wb-fission", name: "国内运营裂变包", total: 5000, used: 880, remaining: 4120, expiresAt: NOW + 6 * 86400000, expired: false, expiringSoon: false }], checkin: { day: TODAY, at: NOW - 4000000, action: "checkin", ok: true, already: true, streakDays: 12, message: "今日已签到" } },
      { id: "a4", channel: "workbuddy", uid: "wb_9e05", name: "历史快照", status: "cooling", credits: 0, creditsAt: ago(300), expiresAt: 0, coolUntil: NOW + 42000, coolReason: "上游限流", source: "scan", lastUsed: ago(55), todayReq: 0, todayTokens: 0, createdAt: NOW - 15 * 86400000, hasToken: true, checkin: { day: TODAY, at: NOW - 4000000, action: "checkin", ok: true, credit: 50, streakDays: 3, message: "签到成功" } },
    ],
  },
  {
    id: "workbuddy_ai", display: "WorkBuddy AI", domain: "www.workbuddy.ai", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "workbuddy_ai", totalCredits: 8120, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 33 * 86400000, expiringSoon: false, todayReq: 66, todayTokens: 14800, lastCreditsAt: ago(70) },
    accounts: [
      // 一次性加油包已领（行内按钮应显示"已领取"）
      { id: "a5", channel: "workbuddy_ai", uid: "wba_3d88", name: "Trial 加油包", status: "online", credits: 8120, creditsAt: ago(70), expiresAt: NOW + 33 * 86400000, coolUntil: 0, coolReason: "", source: "paste", lastUsed: ago(30), todayReq: 66, todayTokens: 14800, createdAt: NOW - 4 * 86400000, hasToken: true, packages: [{ code: "wba-bonus", name: "Bonus Pack", total: -1, used: 0, remaining: 8120, expiresAt: NOW + 33 * 86400000, expired: false, expiringSoon: false }], checkin: { day: TODAY, at: NOW - 5000000, action: "trial", ok: true, already: true, credit: 500, message: "加油包已领取" } },
    ],
  },
  {
    id: "raccoon", display: "商汤小浣熊", domain: "xiaohuanxiong.com", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "raccoon", totalCredits: 9800, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 29 * 86400000, expiringSoon: true, todayReq: 18, todayTokens: 5200, lastCreditsAt: ago(12) },
    accounts: [
      { id: "a6", channel: "raccoon", uid: "rc_88213", name: "小浣熊 1 号", status: "online", credits: 9800, creditsAt: ago(12), expiresAt: NOW + 29 * 86400000, coolUntil: 0, coolReason: "", source: "json", lastUsed: ago(9), todayReq: 18, todayTokens: 5200, createdAt: NOW - 3 * 86400000, hasToken: true },
    ],
  },
  {
    id: "modelscope", display: "ModelScope（魔搭）", domain: "api-inference.modelscope.cn", costTier: "free", poolStrategy: "credit_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "modelscope", totalCredits: 341, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 86400000, expiringSoon: true, todayReq: 5, todayTokens: 1200, lastCreditsAt: ago(2) },
    accounts: [
      { id: "a9", channel: "modelscope", uid: "demo-user", name: "魔搭主号", status: "online", credits: 341, creditsAt: ago(2), expiresAt: NOW + 86400000, coolUntil: 0, coolReason: "", source: "token", lastUsed: ago(1), todayReq: 5, todayTokens: 1200, createdAt: NOW - 86400000, hasToken: true },
    ],
  },
  {
    id: "lobster", display: "LobsterAI（有道）", domain: "lobsterai-server.youdao.com", costTier: "low", poolStrategy: "credit_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "lobster", totalCredits: 300, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 14 * 86400000, expiringSoon: true, todayReq: 6, todayTokens: 1800, lastCreditsAt: ago(4) },
    accounts: [
      { id: "a8", channel: "lobster", uid: "lb_20481", name: "龙虾主号", status: "online", credits: 300, creditsAt: ago(4), expiresAt: NOW + 14 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(3), todayReq: 6, todayTokens: 1800, createdAt: NOW - 2 * 86400000, hasToken: true },
    ],
  },
  {
    id: "zcode", display: "ZCode（智谱）", domain: "zcode.z.ai", costTier: "", poolStrategy: "expire_first",
    // 演示降级态：浏览器预览里能看到渠道卡降级徽标与回切倒计时的样式
    health: { until: NOW + 95_000, reason: "上游 5xx，流量已走其他渠道", streak: 1 } as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "zcode", totalCredits: 150000000, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 90 * 86400000, expiringSoon: false, todayReq: 12, todayTokens: 250000, lastCreditsAt: ago(10) },
    accounts: [
      { id: "a7", channel: "zcode", uid: "zc_1001", name: "智谱主号", status: "online", credits: 150000000, creditsAt: ago(10), expiresAt: NOW + 90 * 86400000, coolUntil: 0, coolReason: "", source: "json", lastUsed: ago(5), todayReq: 12, todayTokens: 250000, createdAt: NOW - 5 * 86400000, hasToken: true },
    ],
  },
  {
    // Qoder 双区：credits 用浮点演示（整数化会丢计量，见 format.ts fmtCredits）
    id: "qoder", display: "Qoder CN", domain: "gateway.qoder.com.cn", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "qoder", totalCredits: 199.9934, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 30 * 86400000, expiringSoon: false, todayReq: 9, todayTokens: 48200, lastCreditsAt: ago(6) },
    accounts: [
      { id: "a8", channel: "qoder", uid: "qd_3001", name: "Qoder 主号", status: "online", credits: 199.9934, creditsAt: ago(6), expiresAt: NOW + 30 * 86400000, coolUntil: 0, coolReason: "", source: "scan", lastUsed: ago(4), todayReq: 9, todayTokens: 48200, createdAt: NOW - 2 * 86400000, hasToken: true },
    ],
  },
  {
    id: "qoder_intl", display: "Qoder International", domain: "api2.qoder.sh", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "qoder_intl", totalCredits: 0.0066, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 30 * 86400000, expiringSoon: false, todayReq: 1, todayTokens: 2100, lastCreditsAt: ago(30) },
    accounts: [
      // 服务不开放（unavailable）：行内按钮应显示「不开放」而不是「已领取」
      { id: "a9", channel: "qoder_intl", uid: "qd_2001", name: "Qoder INTL", status: "online", credits: 0.0066, creditsAt: ago(30), expiresAt: NOW + 30 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(30), todayReq: 1, todayTokens: 2100, createdAt: NOW - 86400000, hasToken: true, checkin: { day: TODAY, at: NOW - 6000000, action: "checkin", ok: true, unavailable: true, message: "该账号的服务未开放" } },
    ],
  },
  {
    // AutoClaw 双区（国内/国际）：积分口径，国内演示今日签到已领、国际演示昨日领取
    id: "autoclaw", display: "AutoClaw 国内版", domain: "autoglm-acceleration-api.zhipuai.cn", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: true, time: "09:00", jitterMin: 0 },
    summary: { channel: "autoclaw", totalCredits: 3200, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 12, todayTokens: 31800, lastCreditsAt: ago(3) },
    accounts: [
      { id: "a11", channel: "autoclaw", uid: "ac_10086", name: "手机 138****8000", status: "online", credits: 3200, creditsAt: ago(3), expiresAt: 0, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(1), todayReq: 12, todayTokens: 31800, createdAt: NOW - 4 * 86400000, hasToken: true, checkin: { day: TODAY, at: NOW - 3600000, action: "checkin", ok: true, already: true, credit: 20, message: "签到成功，获得 20 积分" } },
    ],
  },
  {
    id: "autoclaw_intl", display: "AutoClaw 国际版", domain: "autoglm-api.autoglm.ai", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "autoclaw_intl", totalCredits: 1450, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 3, todayTokens: 8600, lastCreditsAt: ago(26) },
    accounts: [
      { id: "a12", channel: "autoclaw_intl", uid: "ac_9001", name: "tester@example.com", status: "online", credits: 1450, creditsAt: ago(26), expiresAt: 0, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(5), todayReq: 3, todayTokens: 8600, createdAt: NOW - 6 * 86400000, hasToken: true },
    ],
  },
  {
    // CatPaw（美团）：凭据取自桌面端登录态（meta.desktop），演示里给一条导入来源为 scan 的账号
    id: "catpaw", display: "CatPaw（美团）", domain: "ai.catpaw.meituan.com", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "catpaw", totalCredits: 8600, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 24, todayTokens: 62400, lastCreditsAt: ago(8) },
    accounts: [
      { id: "a10", channel: "catpaw", uid: "cp_57130", name: "猫爪主号", status: "online", credits: 8600, creditsAt: ago(8), expiresAt: 0, coolUntil: 0, coolReason: "", source: "scan", lastUsed: ago(2), todayReq: 24, todayTokens: 62400, createdAt: NOW - 3 * 86400000, hasToken: true },
    ],
  },
  {
    // Cline 双池：credit 是浮点计量（微 credit ÷1e6），演示免费池正常余量 / 订阅池订阅到期中；
    // 无签到活动（checkinAuto 恒关，前端也不渲染入口）
    id: "cline_free", display: "Cline Free", domain: "api.cline.bot", costTier: "free", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "cline_free", totalCredits: 12.5, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 9, todayTokens: 21400, lastCreditsAt: ago(4) },
    accounts: [
      { id: "a13", channel: "cline_free", uid: "usr-01M2VWEDWF", name: "demo@example.com", status: "online", credits: 12.5, creditsAt: ago(4), expiresAt: NOW + 3600000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(1), todayReq: 9, todayTokens: 21400, createdAt: NOW - 2 * 86400000, hasToken: true },
    ],
  },
  {
    id: "cline_pass", display: "Cline Pass", domain: "api.cline.bot", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "cline_pass", totalCredits: 128.75, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 30 * 86400000, expiringSoon: false, todayReq: 15, todayTokens: 46200, lastCreditsAt: ago(6) },
    accounts: [
      { id: "a14", channel: "cline_pass", uid: "usr-01M2VWEDWF", name: "demo@example.com", status: "online", credits: 128.75, creditsAt: ago(6), expiresAt: NOW + 30 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(3), todayReq: 15, todayTokens: 46200, createdAt: NOW - 5 * 86400000, hasToken: true },
    ],
  },
  {
    // Accio（阿里）双区：额度是「用量百分比」而非积分（credits 存 0-100 的余量百分比），
    // 国际版演示有订阅、国内版演示免费账号（无订阅）。无签到活动。
    id: "accio", display: "Accio", domain: "phoenix-gw.alibaba.com", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "accio", totalCredits: 62, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 18, todayTokens: 40200, lastCreditsAt: ago(2) },
    accounts: [
      { id: "a15", channel: "accio", uid: "acc_55001", name: "accio-work 主号", status: "online", credits: 62, creditsAt: ago(2), expiresAt: NOW + 20 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(1), todayReq: 18, todayTokens: 40200, createdAt: NOW - 12 * 86400000, hasToken: true },
    ],
  },
  {
    id: "accio_cn", display: "Accio 国内版", domain: "phoenix-gw.alibaba.com", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "accio_cn", totalCredits: 35, accountCount: 1, onlineCount: 1, earliestExpire: 0, expiringSoon: false, todayReq: 6, todayTokens: 12800, lastCreditsAt: ago(5) },
    accounts: [
      { id: "a16", channel: "accio_cn", uid: "acc_77002", name: "accio 国内号", status: "online", credits: 35, creditsAt: ago(5), expiresAt: 0, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(2), todayReq: 6, todayTokens: 12800, createdAt: NOW - 9 * 86400000, hasToken: true },
    ],
  },
  {
    // CodeArts（华为云）：临时凭据（AK/SK/STS）1 小时级到期、提前 15 分钟续；福利是独立「领取」入口，
    // 不进每日签到。演示账号临期（expiringSoon）。
    id: "codearts", display: "CodeArts（华为云）", domain: "snap-access.cn-north-4.myhuaweicloud.com", costTier: "", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: false, time: "09:00", jitterMin: 0 },
    summary: { channel: "codearts", totalCredits: 4800, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 14 * 60000, expiringSoon: true, todayReq: 11, todayTokens: 27600, lastCreditsAt: ago(1) },
    accounts: [
      { id: "a17", channel: "codearts", uid: "ca_domain:user_88", name: "华为云主账号", status: "online", credits: 4800, creditsAt: ago(1), expiresAt: NOW + 14 * 60000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(1), todayReq: 11, todayTokens: 27600, createdAt: NOW - 7 * 86400000, hasToken: true },
    ],
  },
  {
    // Loomy（讯飞）：积分口径（永久 + 每日赠送），每日「签到」= 每日首次登录刷新赠送积分（按天幂等报成功）。
    id: "loomy", display: "Loomy（讯飞）", domain: "loomyad.xunfei.cn", costTier: "low", poolStrategy: "expire_first",
    health: null as { until: number; reason: string; streak: number } | null,
    checkinAuto: { enabled: true, time: "09:00", jitterMin: 0 },
    summary: { channel: "loomy", totalCredits: 10000, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 6 * 86400000, expiringSoon: false, todayReq: 21, todayTokens: 51800, lastCreditsAt: ago(0) },
    accounts: [
      { id: "a18", channel: "loomy", uid: "lm_139****8000", name: "手机 139****8000", status: "online", credits: 10000, creditsAt: ago(0), expiresAt: NOW + 6 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(1), todayReq: 21, todayTokens: 51800, createdAt: NOW - 6 * 86400000, hasToken: true, checkin: { day: TODAY, at: NOW - 1800000, action: "checkin", ok: true, already: false, credit: 5000, message: "每日赠送积分已刷新" } },
    ],
  },
];

// 自定义提供商：一启用一停用，列表两态 + Key 管理弹窗的 online/cooling 两态都能在预览里看到
const MOCK_PROXY_PROVIDERS: {
  id: string; display: string; domain: string; kind: string; enabled: boolean; baseUrl: string;
  models: unknown[]; extraHeaders: Record<string, string>; extraBody: Record<string, unknown>;
  updatedAt: number; keyCount: number; onlineCount: number;
  keys: { id: string; name: string; status: string; hasToken: boolean; coolUntil: number; coolReason: string; todayReq: number; lastUsed: number }[];
}[] = [
  {
    id: "myrelay", display: "我的中转站", domain: "relay.example.com", kind: "openai_compat", enabled: true,
    baseUrl: "https://relay.example.com",
    models: [{ model: "gpt-4o", upstream: "gpt-4o-2024-11-20", aliases: ["gpt-4o-turbo"], contextLength: 128000, reasoning: { supportedEfforts: ["low", "high"] } }, "deepseek-v3.2"],
    extraHeaders: {}, extraBody: {}, updatedAt: NOW - 30 * 60000, keyCount: 2, onlineCount: 1,
    keys: [
      { id: "pk1", name: "主 Key", status: "online", hasToken: true, coolUntil: 0, coolReason: "", todayReq: 37, lastUsed: NOW - 3 * 60000 },
      { id: "pk2", name: "Key 2", status: "cooling", hasToken: true, coolUntil: NOW + 9 * 60000, coolReason: "上游 429 限流", todayReq: 12, lastUsed: NOW - 18 * 60000 },
    ],
  },
  {
    id: "office", display: "公司自建网关", domain: "llm.corp.example", kind: "openai_compat", enabled: false,
    baseUrl: "https://llm.corp.example/v1", models: ["qwen3-max"],
    extraHeaders: { "X-Channel": "agenthub" }, extraBody: {}, updatedAt: NOW - 2 * 3600000, keyCount: 0, onlineCount: 0, keys: [],
  },
];

// 预览态的 Key 内容判重表（真机 addKey 按 Key 内容的 SHA-256 判重，不看名称）。
// 刻意不进 provider 对象：那是 hasToken 脱敏视图，塞明文进去会与真机形状分叉
const MOCK_PROVIDER_SECRETS = new Map<string, Set<string>>();

/** 真机的 create/update 只回渠道视图（keys / keyCount / onlineCount 是 list 才补的），这里保持同形 */
function providerView(p: (typeof MOCK_PROXY_PROVIDERS)[number]) {
  return {
    id: p.id, display: p.display, domain: p.domain, kind: p.kind, enabled: p.enabled,
    baseUrl: p.baseUrl, models: p.models, extraHeaders: p.extraHeaders, extraBody: p.extraBody, updatedAt: p.updatedAt,
  };
}

const PROXY_USAGE = [
  { id: 5, ts: NOW - 60000, reqId: "r5", keyId: "k1", keyName: "本地主 Key", channel: "trae", accountId: "a1", accountName: "主账号 · 沐", model: "deepseek-v4-flash", promptTokens: 1204, completionTokens: 3841, ttftMs: 820, latencyMs: 1200, status: 200, error: "" },
  { id: 4, ts: NOW - 89000, reqId: "r4", keyId: "k2", keyName: "Trae 专用", channel: "trae", accountId: "a1", accountName: "主账号 · 沐", model: "glm-4.6", promptTokens: 2010, completionTokens: 6233, ttftMs: 1500, latencyMs: 2800, status: 200, error: "" },
  { id: 3, ts: NOW - 140000, reqId: "r3", keyId: "k3", keyName: "WorkBuddy 专用", channel: "workbuddy", accountId: "a3", accountName: "工作号", model: "claude-sonnet-4.5", promptTokens: 890, completionTokens: 2210, ttftMs: 640, latencyMs: 1900, status: 200, error: "" },
  { id: 2, ts: NOW - 220000, reqId: "r2", keyId: "k1", keyName: "本地主 Key", channel: "workbuddy_ai", accountId: "a5", accountName: "Trial 加油包", model: "gpt-5", promptTokens: 312, completionTokens: 0, ttftMs: 0, latencyMs: 300, status: 429, error: "rate limited" },
  { id: 1, ts: NOW - 310000, reqId: "r1", keyId: "k1", keyName: "本地主 Key", channel: "trae", accountId: "a2", accountName: "备用号", model: "kimi-k2", promptTokens: 1560, completionTokens: 4120, ttftMs: 910, latencyMs: 2400, status: 200, error: "" },
];

const PROXY_TREND = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(NOW - (6 - i) * 86400000);
  return { day: d.toISOString().slice(0, 10), req: [186, 242, 210, 305, 268, 391, 681][i], tokens: [42, 55, 48, 71, 60, 88, 156][i] * 1000 };
});

// ===== 预览用：区间化统计总览（与真实后端契约一致） =====
/** 富字段排行行：由「请求数 + 总 Token」派生出输入/输出/缓存与成功率，形状与后端 statsTopRich 对齐。
 *  id 是分组身份：channel/model 就是值本身，key/account 是 key_id/account_id（名字可改、可能撞名，
 *  列表 v-for 绑的是它），所以这里允许单独指定，缺省才回落成 name */
function mockTopRow(name: string, req: number, tokens: number, id = name) {
  const ok = Math.round(req * 0.99);
  return {
    id, name, req, ok, err: req - ok, successRate: req ? Math.round((ok / req) * 1000) / 10 : 0,
    promptTokens: Math.round(tokens * 0.78), completionTokens: Math.round(tokens * 0.22),
    cacheReadTokens: Math.round(tokens * 0.28), cacheCreationTokens: 0, tokens,
    ttftAvg: 820, latencyAvg: 1900,
  };
}

function mockProxyOverview(args?: { from?: number; to?: number; granularity?: string }) {
  const to = Number(args?.to) || NOW;
  const from = Number(args?.from) || NOW - 6 * 86400000;
  const granularity = args?.granularity === "day" ? "day" : args?.granularity === "hour" ? "hour" : to - from <= 2 * 86400000 ? "hour" : "day";
  const series = PROXY_TREND.map((d, i) => {
    const ok = Math.round(d.req * 0.99);
    return {
      t: new Date(`${d.day}T00:00:00`).getTime(), label: d.day,
      req: d.req, ok, err: d.req - ok,
      promptTokens: Math.round(d.tokens * 0.78), completionTokens: Math.round(d.tokens * 0.22),
      cacheReadTokens: Math.round(d.tokens * 0.28), cacheCreationTokens: 0, tokens: d.tokens,
      ttftAvg: 800 + i * 12, latencyAvg: 1850, successRate: d.req ? Math.round((ok / d.req) * 1000) / 10 : 0,
    };
  });
  const req = 1284;
  const ok = 1276;
  const totalTokens = 312400;
  return {
    range: { from, to, granularity },
    summary: {
      req, ok, err: req - ok, successRate: Math.round((ok / req) * 1000) / 10,
      promptTokens: Math.round(totalTokens * 0.78), completionTokens: Math.round(totalTokens * 0.22),
      cacheReadTokens: Math.round(totalTokens * 0.28), cacheCreationTokens: 0, totalTokens,
      ttftAvg: 820, ttftP50: 690, latencyAvg: 1900,
      channels: 3, models: 4, keys: 3, accounts: 3,
    },
    series,
    tops: {
      channel: [mockTopRow("trae", 745, 182000), mockTopRow("workbuddy", 421, 96000), mockTopRow("workbuddy_ai", 118, 34400)],
      model: [mockTopRow("deepseek-v4-flash", 512, 120000), mockTopRow("glm-4.6", 233, 62000), mockTopRow("claude-sonnet-4.5", 301, 88000)],
      key: [mockTopRow("本地主 Key", 612, 148200, "k1"), mockTopRow("Trae 专用", 403, 96400, "k2"), mockTopRow("WorkBuddy 专用", 269, 67800, "k3")],
      account: [mockTopRow("主账号 · 沐", 560, 132000), mockTopRow("工作号", 421, 96000), mockTopRow("备用号", 185, 50000)],
    },
    keys: [
      { keyId: "k1", lastTs: NOW - 60000, ...mockTopRow("本地主 Key", 612, 148200, "k1") },
      { keyId: "k2", lastTs: NOW - 89000, ...mockTopRow("Trae 专用", 403, 96400, "k2") },
      { keyId: "k3", lastTs: NOW - 140000, ...mockTopRow("WorkBuddy 专用", 269, 67800, "k3") },
    ],
    status: [
      { name: "成功 2xx", key: "ok", value: 1276 },
      { name: "客户端 4xx", key: "4xx", value: 6 },
      { name: "服务端 5xx", key: "5xx", value: 2 },
      { name: "无响应", key: "other", value: 0 },
    ],
    tokenMix: [
      { name: "输入 Token", key: "prompt", value: Math.round(totalTokens * 0.78) },
      { name: "输出 Token", key: "completion", value: Math.round(totalTokens * 0.22) },
    ],
  };
}

const PROXY_MODELS = [
  { id: "deepseek-v4-flash", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "DeepSeek-V4-Flash", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "glm-4.6", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "GLM-4.6", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "kimi-k2", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "Kimi-K2", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "claude-sonnet-4.5", object: "model", created: 0, owned_by: "workbuddy", sources: ["workbuddy", "workbuddy_ai"], name: "Claude Sonnet 4.5", rate: 1, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 64000, enabled: true, override: "", fallback: "" },
  { id: "gpt-5", object: "model", created: 0, owned_by: "workbuddy", sources: ["workbuddy", "workbuddy_ai"], name: "GPT-5", rate: 0.5, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 32000, enabled: true, override: "", fallback: "" },
  { id: "gemini-2.5-pro", object: "model", created: 0, owned_by: "workbuddy_ai", sources: ["workbuddy_ai"], name: "Gemini 2.5 Pro", rate: 0.05, capabilities: { images: true, tools: true }, contextLength: 1000000, maxOutputTokens: 64000, enabled: false, override: "", fallback: "" },
  { id: "raccoon-chat-ml-5-5", object: "model", created: 0, owned_by: "raccoon", sources: ["raccoon"], name: "Raccoon Chat ML 5.5", rate: null, capabilities: { reasoning: true, tools: true }, contextLength: 180000, maxOutputTokens: 80000, enabled: true, override: "", fallback: "" },
  { id: "glm-5.3-flash", object: "model", created: 0, owned_by: "catpaw", sources: ["catpaw"], name: "GLM-5.3-Flash", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1024000, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "kimi-k3", object: "model", created: 0, owned_by: "catpaw", sources: ["catpaw"], name: "Kimi-K3", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  // Cline 双池：模型 id 带池前缀（上游的计费通道选择器，原样转发）
  { id: "cline-free/deepseek-v4.1-flash", object: "model", created: 0, owned_by: "cline_free", sources: ["cline_free"], name: "DeepSeek V4.1 Flash（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "z-ai/glm-5.3-flash", object: "model", created: 0, owned_by: "cline_free", sources: ["cline_free"], name: "GLM-5.3-Flash（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1310720, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "cline-pass/deepseek-v4.1-flash", object: "model", created: 0, owned_by: "cline_pass", sources: ["cline_pass"], name: "DeepSeek V4.1 Flash（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "cline-pass/glm-5.3", object: "model", created: 0, owned_by: "cline_pass", sources: ["cline_pass"], name: "GLM-5.3（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
];

const PROXY_RULES = [  { file: "model_map.json", desc: "Trae 模型映射（显示名 → config_name/model_name）", size: 642, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "wb_models.json", desc: "WorkBuddy 双区模型目录（兜底，catalog.json 优先）", size: 318, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "catalog.json", desc: "模型权威目录（拉取模型写回：倍率/能力/上下文，可手编）", size: 2048, mtimeMs: NOW - 3600000, ok: true, error: "" },
  { file: "wb_template_map.json", desc: "WorkBuddy 审核模板最小改写表", size: 274, mtimeMs: NOW - 2 * 86400000, ok: true, error: "" },
  { file: "headers.json", desc: "渠道默认头 / UA / 上游域", size: 1204, mtimeMs: NOW - 86400000, ok: true, error: "" },
];

// 浏览器预览 mock：invoke 按 case 返回样例数据（结构对齐主进程真实返回）
export const mock = {
  async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      // ===== 框架 =====
      case "load_config":
        return read();
      case "save_config":
        localStorage.setItem(KEY, JSON.stringify(args?.config ?? {}));
        return { ok: true, message: "设置保存成功" };
      case "get_app_version":
        return pkg.version;
      case "get_data_dir":
        return "(浏览器预览)";
      case "open_data_dir":
        return;
      case "browse_dir":
        return { ok: true, canceled: true, path: null };
      case "admin_access_info": {
        const adminPort = (read().proxy.port || 9527) + 1;
        return {
          available: true,
          message: "",
          url: `http://192.168.1.24:${adminPort}`,
          loopbackUrl: `http://127.0.0.1:${adminPort}`,
          lanUrl: `http://192.168.1.24:${adminPort}`,
          token: "mock-admin-token-0123456789abcdef",
        };
      }
      case "admin_set_token":
        return String(args?.token || "").trim().length >= 16 ? { ok: true, message: "令牌已更新，浏览器需重新登录" } : { ok: false, message: "令牌至少 16 位" };

      // ===== 反代网关（预览数据，语义对齐 backend/proxy） =====
      case "proxy_config_get":
        return read().proxy;
      case "proxy_config_save": {
        // 纯预览：proxy 段落 mock 配置（localStorage），不碰真实网关
        const cfg = read();
        const incoming = (args?.config || {}) as Partial<AppConfig["proxy"]>;
        cfg.proxy = { ...cfg.proxy, ...incoming };
        localStorage.setItem(KEY, JSON.stringify(cfg));
        return { ok: true, message: "设置保存成功" };
      }
      case "proxy_status":
        return {
          running: true, port: 9527, bind: "127.0.0.1", baseUrl: "http://127.0.0.1:9527/v1",
          uptime: 3 * 3600000, active: 1,
          today: { req: 1284, tokens: 312400, successRate: 99.4, ttftAvg: 820 },
          // 关闭的渠道不出现在网关状态里（语义对齐 backend poolView/gatewayStatus 的过滤）
          channels: PROXY_POOL.filter((c) => (read().proxy.channelEnabled || {})[c.id] !== false).map((c) => ({ id: c.id, display: c.display, ...c.summary, health: c.health })),
          keyCount: PROXY_KEYS.length, vaultOk: true, dbDriver: "node:sqlite",
        };
      case "proxy_start":
        return { ok: true, port: 9527 };
      case "proxy_stop":
      case "proxy_restart":
        return { ok: true, port: 9527 };
      case "proxy_keys_list":
        return JSON.parse(JSON.stringify(PROXY_KEYS));
      case "proxy_key_create":
        return { id: "k-new", name: String(args?.name || "新 Key"), mask: "sk-demo···0000", route: args?.route || "auto", routeOrder: args?.routeOrder || "", dailyQuota: args?.dailyQuota || 0, rateLimit: 0, enabled: true, createdAt: NOW, todayReq: 0, todayTokens: 0, secret: "sk-demo0000000000000000000000000000000000000000000000" };
      case "proxy_key_update":
      case "proxy_key_delete":
      case "proxy_keys_delete":
      case "proxy_pool_strategy":
      case "proxy_pool_tier":
      case "proxy_account_remove":
      case "proxy_account_remove_batch":
      case "proxy_account_note":
      case "proxy_account_toggle":
      case "proxy_oauth_cancel":
      case "proxy_oauth_submit_callback":
        return { ok: true };
      // 明文导出（预览）：形状与主进程一致，凭据是占位明文
      case "proxy_account_export_plain":
        return {
          ok: true,
          exportedAt: NOW,
          missing: [],
          accounts: [
            {
              channel: "trae",
              uid: "demo-uid-0001",
              name: "演示账号",
              note: "",
              token: "demo-access-token",
              refreshToken: "demo-refresh-token",
              tokenExp: NOW + 3600000,
              expiresAt: 0,
              credits: 1000,
              status: "online",
              source: "paste",
              createdAt: NOW,
              updatedAt: NOW,
              meta: {},
            },
          ],
        };
      case "proxy_pool":
        return JSON.parse(JSON.stringify(PROXY_POOL));
      // 渠道启闭（预览）：list 全量带 enabled；toggle 写 mock 配置即生效
      case "proxy_channel_list":
        return JSON.parse(JSON.stringify(PROXY_POOL)).map((c: Record<string, unknown>) => ({
          ...c,
          enabled: (read().proxy.channelEnabled || {})[c.id as string] !== false,
        }));
      case "proxy_channel_toggle": {
        const cfg = read();
        const map = { ...(cfg.proxy.channelEnabled || {}) } as Record<string, boolean>;
        const ch = String(args?.channel || "");
        if (args?.enabled === false) map[ch] = false;
        else delete map[ch];
        cfg.proxy.channelEnabled = map;
        localStorage.setItem(KEY, JSON.stringify(cfg));
        return { ok: true, channel: ch, enabled: args?.enabled !== false };
      }
      case "proxy_account_add":
        return { ok: true, id: "a-new" };
      case "proxy_account_refresh":
        return { ok: true, id: args?.id, credits: 51230, expiresAt: NOW + 48 * 86400000 };
      case "proxy_credits_refresh":
        return { ok: true, total: 5, failed: 0 };
      case "proxy_credits_refresh_channel":
        return { ok: true, total: 3, failed: 0, results: [] };
      case "proxy_checkin_status":
        return {
          ok: true,
          action: "status",
          total: 3,
          okCount: 3,
          rows: [
            { accountId: "a1", channel: "trae", name: "主账号 · 沐", uid: "88213476", ok: true, checkedIn: false, enable: true, credits: 120, message: "今日未签到" },
            { accountId: "a2", channel: "workbuddy", name: "工作号", uid: "wb_7c21", ok: true, active: true, checkedIn: true, streakDays: 3, dailyCredit: 100, message: "今日已签到" },
            { accountId: "a3", channel: "workbuddy_ai", name: "国际版号", uid: "wb_9e05", ok: true, unavailable: true, message: "国际版无签到体系" },
          ],
        };
      case "proxy_checkin_run": {
        // 按渠道返回该渠道账号的签到结果，并把结果写回池视图（模拟主进程 meta.checkin 落库）：
        // 预览里点完「一键签到」行内按钮随即变「已签到/已领取」，工具栏进完成态
        type MockAcct = { id: string; channel: string; name: string; uid: string; checkin?: unknown };
        const pools = PROXY_POOL as unknown as { id: string; accounts: MockAcct[] }[];
        const ch = pools.find((c) => c.id === String(args?.channel || "trae")) || pools[0];
        const action = args?.action === "trial" ? "trial" : "checkin";
        const rows = ch.accounts.map((a) => ({ accountId: a.id, channel: a.channel, name: a.name, uid: a.uid, ok: true, message: action === "trial" ? "加油包已领取" : "签到成功", credit: 100 }));
        for (const a of ch.accounts) a.checkin = { day: TODAY, at: Date.now(), action, ok: true, credit: 100, streakDays: 1, message: action === "trial" ? "加油包已领取" : "签到成功" };
        return { ok: true, action, total: rows.length, okCount: rows.length, rows };
      }
      case "proxy_checkin_auto_set": {
        const chId = String(args?.channel || "");
        const pools = PROXY_POOL as unknown as { id: string; checkinAuto?: { enabled: boolean; time: string; jitterMin: number } }[];
        const ch = pools.find((c) => c.id === chId);
        const rule = { enabled: !!args?.enabled, time: String(args?.time || "09:00"), jitterMin: Number(args?.jitterMin || 0) };
        if (ch) ch.checkinAuto = rule;
        return { ok: true, channel: chId, ...rule };
      }
      case "proxy_scan":
        return [
          { channel: "workbuddy", uid: "wb_7c21", name: "工作号", source: "scan", file: "workbuddy-desktop.info", imported: true },
          { channel: "workbuddy_ai", uid: "wb_9e05", name: "国际版号", source: "scan", file: "workbuddy-desktop-ai.info", imported: false },
          { channel: "trae", uid: "88213476", name: "huihui", source: "scan", file: "TRAE SOLO CN · storage.json", imported: false, credits: 51230 },
        ];
      case "proxy_scan_import":
        return { ok: true, id: "a-imp", updated: false };
      case "proxy_oauth_begin":
        // Cline 设备授权：演示用户码形态（前端会显示「用户码：XXXX」一行）
        if (args?.channel === "cline_free" || args?.channel === "cline_pass") {
          return { ok: true, url: "https://authkit.cline.bot/device?user_code=PXQF-MWRC（预览）", mode: "device", userCode: "PXQF-MWRC" };
        }
        return { ok: true, url: "https://www.trae.cn/authorization?...（预览）", mode: args?.channel === "trae" ? "loopback" : "poll" };
      case "proxy_account_import_json":
        return { ok: true, added: 2, dup: 1, invalid: 0, message: "成功导入 2 个账号，1 个同 UID 已存在跳过" };
      case "proxy_account_import_file":
        return { ok: true, canceled: true };
      case "proxy_account_import_text":
        return { ok: true, added: 1, dup: 0, invalid: 0, message: "成功导入 1 个账号" };
      case "proxy_models":
        return JSON.parse(JSON.stringify(PROXY_MODELS));
      case "proxy_models_sync":
        return { ok: true, channel: args?.channel || "workbuddy", count: 6, withRate: 4 };
      // ===== 自定义提供商（预览态不代打上游，但增删改与两态结果都要能演） =====
      case "proxy_provider_list":
        return { ok: true, providers: MOCK_PROXY_PROVIDERS.map((p) => ({ ...p, models: [...p.models], keys: p.keys.map((k) => ({ ...k })) })) };
      case "proxy_provider_create": {
        const id = String(args?.id || "");
        if (MOCK_PROXY_PROVIDERS.some((p) => p.id === id)) return { ok: false, message: `标识 "${id}" 已存在` };
        const keys = (args?.keys as { key?: string }[]) || [];
        // 同名不同 Key 放行、同内容重复只收一把：与真机 addKey 的内容判重同一口径
        const secrets = new Set<string>();
        const keyRows: { id: string; name: string; status: string; hasToken: boolean; coolUntil: number; coolReason: string; todayReq: number; lastUsed: number }[] = [];
        for (const k of keys) {
          const s = String(k?.key || "").trim();
          if (!s || secrets.has(s)) continue;
          secrets.add(s);
          keyRows.push({ id: `mk-${id}-${keyRows.length + 1}`, name: `Key ${keyRows.length + 1}`, status: "online", hasToken: true, coolUntil: 0, coolReason: "", todayReq: 0, lastUsed: 0 });
        }
        MOCK_PROVIDER_SECRETS.set(id, secrets);
        const p = {
          id, display: String(args?.display || id), domain: "", kind: "openai_compat", enabled: args?.enabled !== false,
          baseUrl: String(args?.baseUrl || ""), models: (args?.models as unknown[]) || [],
          extraHeaders: (args?.extraHeaders as Record<string, string>) || {}, extraBody: (args?.extraBody as Record<string, unknown>) || {},
          updatedAt: Date.now(),
          keys: keyRows, keyCount: keyRows.length, onlineCount: keyRows.length,
        };
        MOCK_PROXY_PROVIDERS.push(p);
        // create/update 的 provider 视图与真机同形：只有 list 才补 keys/keyCount/onlineCount
        return { ok: true, provider: providerView(p), keyIds: keyRows.map((k) => k.id) };
      }
      case "proxy_provider_update": {
        const p = MOCK_PROXY_PROVIDERS.find((x) => x.id === args?.id);
        if (!p) return { ok: false, message: "提供商不存在" };
        Object.assign(p, args, { updatedAt: Date.now() });
        return { ok: true, provider: providerView(p) };
      }
      case "proxy_provider_delete": {
        const i = MOCK_PROXY_PROVIDERS.findIndex((x) => x.id === args?.id);
        if (i < 0) return { ok: false, message: "提供商不存在" };
        MOCK_PROVIDER_SECRETS.delete(String(args?.id || ""));
        MOCK_PROXY_PROVIDERS.splice(i, 1);
        return { ok: true };
      }
      case "proxy_provider_add_key": {
        const p = MOCK_PROXY_PROVIDERS.find((x) => x.id === args?.id);
        if (!p) return { ok: false, message: "提供商不存在" };
        const secret = String(args?.key || "").trim();
        if (!secret) return { ok: false, message: "Key 不能为空" };
        const seen = MOCK_PROVIDER_SECRETS.get(p.id) || new Set<string>();
        if (seen.has(secret)) return { ok: false, message: "这把 Key 已经在本提供商的号池里了" };
        seen.add(secret);
        MOCK_PROVIDER_SECRETS.set(p.id, seen);
        const id = `mk-${p.id}-${p.keys.length + 1}`;
        p.keys.push({ id, name: String(args?.name || "").trim() || `Key ${p.keys.length + 1}`, status: "online", hasToken: true, coolUntil: 0, coolReason: "", todayReq: 0, lastUsed: Date.now() });
        p.keyCount = p.keys.length;
        p.onlineCount = p.keys.length;
        return { ok: true, id };
      }
      case "proxy_provider_remove_key": {
        for (const p of MOCK_PROXY_PROVIDERS) {
          const i = p.keys.findIndex((k) => k.id === args?.accountId);
          if (i < 0) continue;
          p.keys.splice(i, 1);
          p.keyCount = p.keys.length;
          p.onlineCount = p.keys.filter((k) => k.status === "online").length;
          return { ok: true };
        }
        return { ok: false, message: "Key 不存在" };
      }
      case "proxy_provider_test": {
        // 预览不代打上游，但要能演两种结果态：清单里有的模型算"可用"，其余回失败文案，
        // 否则逐行测试这条 UI 在 dev:web 里永远只有一种样子
        const m = String(args?.model || "");
        const known = MOCK_PROXY_PROVIDERS.find((p) => p.id === args?.id);
        const inList = (known?.models || []).some((x) => (typeof x === "string" ? x : (x as { model: string }).model) === m);
        return inList
          ? { ok: true, ms: 640 + m.length * 7, model: m, sample: "（预览态假响应）收到", finishReason: "stop", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }
          : { ok: false, status: 404, ms: 880, message: "浏览器预览不代打上游，请在应用内测试" };
      }
      case "proxy_provider_fetch_models":
        return { ok: true, models: ["gpt-4o", "gpt-4o-mini", "o3-pro"] };
      // 切号：首调只做预检（对应真实后端 —— 一律回 needConfirm + probe，由前端弹确认框），
      // confirmAck 重调才回执行结果，预览下两条路径都可走通
      case "proxy_ide_switch":
        if (!args?.confirmAck) {
          return {
            ok: true,
            channel: "workbuddy",
            needConfirm: true,
            probe: {
              channel: "workbuddy",
              clientName: "WorkBuddy CN",
              file: "C:\\Users\\you\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info",
              exe: "E:\\WorkBuddy\\WorkBuddy.exe",
              running: true,
              relaunch: true,
              note: "原登录文件自动备份、可回滚；所有项目与历史会话跨账号共用保留。",
              warning: "客户端将被关闭，未保存的内容会丢失；切换完成后自动重新打开。",
            },
            message: "WorkBuddy CN 正在运行，切换需要先关闭它，切换完成后会自动重新打开。未保存的内容请先保存。确认继续吗？",
          };
        }
        return { ok: true, channel: "workbuddy", message: "已写入（预览），客户端已重新启动" };
      case "proxy_ide_status":
        // 与真实后端契约一致：这里刻意不含「客户端是否在运行」——真实 ideSwitchStatus 故意不探进程
        // （它在号池页高频调用，同步 tasklist 会堵主进程），运行态只在切号预检的 probe 里给
        return { workbuddyInstalled: true, workbuddyAiInstalled: true, traeInstalled: false, raccoonInstalled: true, zcodeInstalled: true, qoderInstalled: true, qoderIntlInstalled: false, currentUid: "wb_7c21" };
      case "proxy_stats_overview":
        return mockProxyOverview(args as { from?: number; to?: number; granularity?: string });
      case "proxy_stats_top":
        return [
          { name: "trae", req: 745, tokens: 182000 },
          { name: "workbuddy", req: 421, tokens: 96000 },
        ];
      case "proxy_stats_detail": {
        // 与后端同口径：Key 精确（key_id = ?）+ 模型模糊 + 渠道 / 状态过滤，并回筛选命中的 token 汇总
        const a = (args || {}) as {
          keyId?: string;
          model?: string;
          channel?: string;
          status?: string;
          page?: number;
          pageSize?: number
        };
        const mw = String(a.model || "").toLowerCase();
        let rows = PROXY_USAGE.filter((r) => {
          if (a.keyId && r.keyId !== a.keyId) return false;
          if (mw && !(r.model || "").toLowerCase().includes(mw)) return false;
          if (a.channel && r.channel !== a.channel) return false;
          if (a.status === "ok" && !(r.status >= 200 && r.status < 300)) return false;
          if (a.status === "4xx" && !(r.status >= 400 && r.status < 500)) return false;
          if (a.status === "5xx" && !(r.status >= 500)) return false;
          if (a.status === "other" && !(r.status < 200 || (r.status >= 300 && r.status < 400))) return false;
          return true;
        });
        const agg = rows.reduce(
          (s, r) => ({ req: s.req + 1, promptTokens: s.promptTokens + (r.promptTokens || 0), completionTokens: s.completionTokens + (r.completionTokens || 0) }),
          { req: 0, promptTokens: 0, completionTokens: 0 },
        );
        const pageSize = a.pageSize || 20;
        const page = a.page || 1;
        const total = rows.length;
        rows = rows.slice((page - 1) * pageSize, page * pageSize);
        return {
          total, page, pageSize,
          agg: { ...agg, cacheReadTokens: 0, cacheCreationTokens: 0, tokens: agg.promptTokens + agg.completionTokens },
          rows: JSON.parse(JSON.stringify(rows)),
        };
      }
      case "proxy_stats_cleanup": {
        // 与后端同口径：all 清空整表，否则按 days（缺省 90）删保留线之前的流水
        const days = Math.min(3650, Math.max(1, Math.round(Number(args?.days) || 90)));
        const cutoff = Date.now() - days * 86400000;
        const before = PROXY_USAGE.length;
        if (args?.all) PROXY_USAGE.length = 0;
        else for (let i = PROXY_USAGE.length - 1; i >= 0; i--) if (PROXY_USAGE[i].ts < cutoff) PROXY_USAGE.splice(i, 1);
        return { deleted: before - PROXY_USAGE.length, cutoff: args?.all ? 0 : cutoff };
      }
      case "proxy_recent":
        return JSON.parse(JSON.stringify(PROXY_USAGE));
      case "proxy_oplog_list": {
        // 预览数据语义对齐 backend：from/to 毫秒区间、level、op 过滤 + 时间倒序分页
        const all = [
          { id: 3, ts: Date.now() - 120000, level: "info", op: "代理请求", message: "glm-5.3-flash · HTTP 200 · 842ms", channel: "zcode", target: "默认 Key / 主账号 · 沐", detail: "" },
          { id: 2, ts: Date.now() - 300000, level: "warn", op: "签到", message: "领取奖励需要完成一次人机校验", channel: "zcode", target: "主账号 · 沐", detail: "" },
          { id: 1, ts: Date.now() - 600000, level: "error", op: "代理请求", message: "raccoon-chat-ml-5-5 · HTTP 502 · 1203ms", channel: "raccoon", target: "默认 Key / 小浣熊号", detail: "上游异常" },
        ];
        const f = args || {};
        const rows = all.filter((r) =>
          (Number(f.from) > 0 ? r.ts >= Number(f.from) : true) &&
          (Number(f.to) > 0 ? r.ts <= Number(f.to) : true) &&
          (f.level ? r.level === f.level : true) &&
          (f.op ? r.op === f.op : true)
        );
        const limit = Math.max(1, Math.min(200, Number(f.limit) || 50));
        const offset = Math.max(0, Number(f.offset) || 0);
        // 增量查询（sinceId）与 backend store.listOpLogs 同口径：id > sinceId、升序、忽略 offset，total 仍是筛选总数
        const sinceId = Number(f.sinceId) || 0;
        if (sinceId > 0) return { rows: rows.filter((r) => r.id > sinceId).sort((a, b) => a.id - b.id).slice(0, limit), total: rows.length };
        return { rows: rows.slice(offset, offset + limit), total: rows.length };
      }
      case "proxy_oplog_ops":
        return ["代理请求", "号池账号", "网关启停", "网关配置", "自动签到", "OAuth 登录", "模型目录", "签到", "切换账号", "API Key", "冷却与风控"];
      case "proxy_oplog_export":
        return { ok: true, path: "(浏览器预览)/proxy-oplog.xlsx", count: 3, message: "导出成功（3 条记录）" };
      case "proxy_rules_list":
        return JSON.parse(JSON.stringify(PROXY_RULES));
      case "proxy_open_rules_dir":
      case "proxy_open_data_dir":
        return { ok: true };
      case "proxy_vault_status":
        return { encrypted: true, driver: "node:sqlite", dataDir: "(浏览器预览)" };
      default:
        // 未造的命令走 null 降级（页面按“未检测到后端”处理）
        return null;
    }
  },
};
