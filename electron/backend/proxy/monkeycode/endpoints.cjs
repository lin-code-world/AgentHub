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
// 反代网关 · MonkeyCode 上游端点与出站头
//
// 网页与 API 同域（站点自身的前端就是这些接口的调用方），所以 Origin/Referer 伪装成站点自身。
// UA 用可辨识的自定义值：上游对**陌生 UA** 加风控，而对这种"网关自报身份"的形态是有意的选择
// —— 冒充浏览器 UA 会让风控判定依赖指纹细节，一升级就整渠道失效。
//
// WebSocket 握手刻意**不发 Referer**、也**不手写 Sec-WebSocket-Key/Version/Extensions**：
// 那三件套由 WebSocket 库自己生成（手写的 key 若与库的掩码状态不一致，握手直接失败）。
"use strict";

const regionStore = require("./region.cjs");

/** 普通用户会话 Cookie；30 天硬限制、HttpOnly + Secure + SameSite=Lax、**不可续期** */
const SESSION_COOKIE_NAME = "monkeycode_ai_session";
/** 团队会话 Cookie：只是登记在册，本网关不接这一路（团队是另一套端点与账号体系）。
 *  写在这里是为了让人一眼看出"把它当普通 cookie 用"是错的 */
const TEAM_SESSION_COOKIE_NAME = "monkeycode_ai_team_session";

const USER_STATUS_PATH = "/api/v1/users/status";
const MODELS_PATH = "/api/v1/users/models";
const TASKS_PATH = "/api/v1/users/tasks";
const TASKS_DISCOVER_QUERY = "?page=1&size=5";
const TASK_STREAM_PATH = "/api/v1/users/tasks/stream";
/** 用户可用镜像列表：remark=="devbox" 的是公共开发镜像，建任务要它的 UUID */
const IMAGES_PATH = "/api/v1/users/images";
/** 钱包：积分 + 每日 token 额度（余额查询） */
const WALLET_PATH = "/api/v1/users/wallet";
/** 签到状态（GET）/ 执行签到（POST {captcha_token}） */
const CHECKIN_PATH = "/api/v1/users/wallet/checkin";
/** 签到验证码（Cap.js 工作量证明）：challenge 取题、redeem 换 token，两个都是公开端点 */
const CAPTCHA_CHALLENGE_PATH = "/api/v1/public/captcha/challenge";
const CAPTCHA_REDEEM_PATH = "/api/v1/public/captcha/redeem";
/** 内置公共 devbox 镜像 UUID（实测取自「用户镜像」里 remark=devbox 的公共镜像）。
 *  新账号还没跑过任务、上面两条都发现不到时用它兜底；上游换镜像后此值可能失效。 */
const FALLBACK_DEVBOX_IMAGE_ID = "2e214f06-79ba-4535-9ac1-89adc2d9c6cc";

/** 宿主机名：公共站点固定这一个值；自建/私有云的宿主名不同，用规则文件或环境变量覆盖 */
const DEFAULT_HOST_ID = "public_host";

const USER_AGENT = "monkeycode-local-proxy";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

// 只有 WebSocket 握手在这里定额：握手没完成时任务流的空闲计时还没开始走，必须有独立的兜底
// （上限取 forwarder 的外层超时之内，否则报错归属会含糊）。其余 HTTP 短请求走 adapters 的
// 共用超时（proxy.httpJsonTimeoutMs），任务流总时长与 resource.life 对齐，都见 stream.cjs。
const WS_CONNECT_TIMEOUT_MS = 30000;

function cookieHeader(session) {
  return `${SESSION_COOKIE_NAME}=${session}`;
}

/** 站内 JSON 请求的公共头（Cookie 由调用方补，因为 Origin/Referer 要按站点真身而不是基址） */
function jsonHeaders(region, section) {
  const origin = region.siteOrigin;
  return {
    "User-Agent": String((section && section.userAgent) || USER_AGENT),
    Origin: origin,
    Referer: `${origin}/`,
    Accept: "application/json",
  };
}

/** 任务流握手头：站点前端发起的形态，Cookie 放这里 */
function wsHeaders(region, session, section) {
  return {
    "User-Agent": String((section && section.userAgent) || USER_AGENT),
    "Accept-Language": ACCEPT_LANGUAGE,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Origin: region.siteOrigin,
    Cookie: cookieHeader(session),
  };
}

/** mode=new：本次请求新建一个任务轮次（上游另有 attach 语义，本渠道每次都用新会话，不做接续） */
function taskStreamUrl(region, section, taskId, mode) {
  const base = regionStore.toWsScheme(regionStore.baseUrl(region, section));
  return `${base}${TASK_STREAM_PATH}?id=${encodeURIComponent(taskId)}&mode=${mode || "new"}`;
}

/**
 * 容器里装哪个 coding agent（= 建任务的 cli_name）。
 *
 * 固定 opencode，**不按模型的 interface_type 挑**：opencode 内部会按接口类型自动选
 * 对应的 provider 适配器（anthropic / openai / openai_responses 都吃），官方网页端、
 * 官方桌面客户端、第三方实现三处一律用 opencode。按接口类型映射成 claude/codex 时，
 * 容器里跑的 agent 连不上模型 API（实测：任务起得来、但一直 llm_call_retry
 * "Cannot connect to API"）。interfaceType 形参保留只为调用点少改、并留出日后扩展位。
 */
function cliNameFor(interfaceType) {
  return "opencode";
}

function hostId(region, section) {
  const fromRules = String((section && section.hostId) || "").trim();
  if (fromRules) return fromRules;
  return String(process.env[`${region.envPrefix}HOST_ID`] || "").trim() || DEFAULT_HOST_ID;
}

module.exports = {
  SESSION_COOKIE_NAME,
  TEAM_SESSION_COOKIE_NAME,
  USER_STATUS_PATH,
  MODELS_PATH,
  TASKS_PATH,
  TASKS_DISCOVER_QUERY,
  TASK_STREAM_PATH,
  IMAGES_PATH,
  WALLET_PATH,
  CHECKIN_PATH,
  CAPTCHA_CHALLENGE_PATH,
  CAPTCHA_REDEEM_PATH,
  FALLBACK_DEVBOX_IMAGE_ID,
  DEFAULT_HOST_ID,
  USER_AGENT,
  WS_CONNECT_TIMEOUT_MS,
  cookieHeader,
  jsonHeaders,
  wsHeaders,
  taskStreamUrl,
  cliNameFor,
  hostId,
};
