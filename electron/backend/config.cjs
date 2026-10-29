/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 配置读写（Node 主进程侧）：全局配置（主题 / 关窗行为 / 反代网关）与管理令牌等
// 统一落在 Windows 惯例的用户应用数据目录（Electron userData = %APPDATA%\AgentHub），
// 深合并默认值，临时文件原子落盘；敏感凭据用系统级密钥加密存储。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Electron app（主进程）；纯 Node 脚本直跑（tools 自测等）时为 null
let electronApp = null;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object" && electron.app) electronApp = electron.app;
} catch {
  /* 非 Electron 环境 */
}

/** 便携版是临时解压目录，开机自启注册的路径退出即失效（自启开关要在设置页禁用） */
function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

// 凭据信封按前缀分派，加密后端二选一（桌面 safeStorage / headless AES）：
//   enc:v1: — Electron safeStorage（Windows 下即 DPAPI），OS 用户绑定、原理上不可跨机
//   enc:v2: — AES-256-GCM，密钥取自 AGENTHUB_SECRET_KEY，桌面与 headless 形态通用
// 两种前缀并存是刻意的：统一成"通用信封"只会退化成把密钥一起搬走（等于没有加密）。
// 无 safeStorage 且无 key 时保持明文降级（自测环境依赖此行为）；生产形态由网关入口强制 key
let safeStorage = null;
try { safeStorage = require("electron").safeStorage; } catch { /* 自测环境无 electron */ }
const ENC_PREFIX = "enc:v1:";
const AES_PREFIX = "enc:v2:";

function aesKey() {
  const secret = String(process.env.AGENTHUB_SECRET_KEY || "");
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

/** 是否本模块产出的密文信封（敏感 meta 判定用：enc:v2: 同样算密文，不能当明文剥掉） */
function isEncrypted(v) {
  return typeof v === "string" && (v.startsWith(ENC_PREFIX) || v.startsWith(AES_PREFIX));
}

function encryptSecret(plain) {
  const s = String(plain || "");
  if (!s || isEncrypted(s)) return s; // 空值或已是密文不重复加密
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
  }
  const key = aesKey();
  if (!key) return s; // 明文降级（历史行为；生产形态的 key 由网关入口把关）
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  return AES_PREFIX + [nonce, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function decryptSecret(stored) {
  const s = String(stored || "");
  if (s.startsWith(AES_PREFIX)) {
    const key = aesKey();
    if (!key) return ""; // 密钥缺失/不符：与 enc:v1: 跨环境解不开同语义，交由上层"保留磁盘密文"的保护兜底
    try {
      const [n, tag, ct] = s.slice(AES_PREFIX.length).split(".");
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(n, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch {
      return ""; // 密钥不符或密文损坏，让用户重填
    }
  }
  if (!s.startsWith(ENC_PREFIX)) return s; // 明文（降级环境存的）直接用
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return ""; // 密文来自其他机器解不开，让用户重填
  }
}

/** 数据目录：Electron 用 userData（%APPDATA%\AgentHub，目录名由 main.cjs 的 setName 决定）；
 *  纯 Node 环境退回 %APPDATA%\AgentHub（无则用户主目录），保证脚本直跑与主进程读同一份配置。
 *  AGENTHUB_DATA_DIR 显式指定时始终优先：自测脚本的沙箱钩子（不设即无感，生产零影响） */
function dataDir() {
  const dir = process.env.AGENTHUB_DATA_DIR || (electronApp ? electronApp.getPath("userData") : path.join(process.env.APPDATA || os.homedir(), "AgentHub"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 配置文件路径 */
function configPath() {
  return path.join(dataDir(), "config.json");
}

/** 默认配置（与前端 src/types/index.ts 及 stores/app.ts 保持一致） */
function defaultConfig() {
  return {
    theme: "dark",
    // 动效（fx*）与软件更新（update）字段已随对应功能移除；
    // 旧配置里的残留字段由 loadConfig 剔除，无需迁移
    // 后台与调度
    schedule: {
      // 关窗行为：开=销毁界面进程（释放渲染进程），托盘与后台服务（反代网关）照常运行，
      // 唤回时重新加载界面；关=关窗即退出应用。实测 hide 不省内存（渲染进程仍占 ~298 MB），
      // 只有 destroy 才会让它整只消失，故开着时一律销毁而不是隐藏。
      minimizeToTray: true,
      autoStart: false,     // 开机自启（便携版无效）
    },
    // ===== 反代网关（方案 settings 全量入框架整体设置；端口改动需重启监听，其余热生效） =====
    proxy: {
      port: 9527,               // 监听端口（默认 9527）
      bind: "127.0.0.1",        // 绑定地址：127.0.0.1 仅本机 / 0.0.0.0 局域网开放
      routeStrategy: "smart",   // smart=智能路由（健康度×余额打分）/ fixed=指定渠道优先
      fixedChannel: "trae",     // fixed 策略下的优先渠道
      routeOrder: "score",      // 渠道成本感知排序：score=按打分（现状）/ cost-first=按成本档升序
                                // （免费→低成本→普通，组内仍按打分）；Key 可单独覆盖
      rateLimitPerMin: 120,     // 单 Key 令牌桶限速（次/分钟，Key 可单独覆盖）
      concurrency: 8,           // 单渠道在途并发上限（满则跳备选渠道，不做全局 429，issue #106）
      creditsRefreshMin: 30,    // 额度自动刷新周期（分钟）
      usageRetentionDays: 90,   // 请求流水保留期（天，1~3650）：启动 GC 与用量统计页「清理」共用
                                // （默认 90 = 该保留期此前在 proxy/store.cjs 的 gc() 里写死的那个数）
      expiringSoonDays: 1,      // 积分包「即将到期」预警阈值（天，0~3650，0=关闭预警）：
                                // 号池到期徽标与逐包明细的 expiringSoon 共用这一个值
                                // （默认 1 = 该阈值此前在 pool.cjs 里硬编码的那个数）
      debugStatus: false,       // /status 调试端点（默认关，仅回环地址）
      modelOverrides: {},       // 模型 → 渠道 的 per-model 覆盖（多源重叠时优先）
      humanizeJitter: true,     // 拟人抖动：每次上游请求前随机停 40~220ms（防风控识别为反代）
      disabledModels: [],       // 禁用的模型（请求直接 400 model_disabled，且不出现在 /v1/models）
      modelFallback: {},        // 模型 → 回退模型（旧版 per-model 配置，优先于全局回退）
      modelReverseAliases: {},  // 反向模型映射：统一请求名 → { [channelId]: 渠道实际模型名 }
      modelCustom: {},          // 模型自定义参数覆盖：modelId → { contextLength?, maxOutputTokens?, reasoningEffort? }
      autoFallbackEnabled: true, // 不可用时自动切换模型（统一设置，默认开）
      fallbackModel: "",        // 全局统一回退模型（模型未知/号池耗尽时自动切换）
      channelFailover: true,    // 跨渠道故障转移：渠道耗尽/降级时请求内自动跳其他渠道（默认开）；
                                // 只作用于渠道间跳转，「不可用时自动切换模型」的回退链不受此开关影响
      channelFailoverMax: 3,    // 单请求最多尝试渠道数（含主渠道；范围 1~10、超出按 10；上游尝试预算随上限放大：每模型 max(6, 本值+1) 次，failover 关闭恒 6）
      channelCooldownMs: 120000,     // 渠道降级基础时长（毫秒），失败翻倍（防半开震荡）
      channelCooldownCapMs: 900000,  // 渠道降级指数退避封顶（15 分钟）
      checkinAutoRules: {},     // 按渠道自动签到：{ [渠道 id]: { enabled, time:"HH:mm", jitterMin } }，
                                // 号池页各渠道工具栏各自设置（时间/抖动独立；默认全关）
      channelEnabled: {},       // 渠道启闭（「上游启闭」弹窗）：{ [渠道 id]: true|false }，缺省 = 启用。
                                // 关闭的渠道在反代网关全部页面隐藏，路由/调用/调度也不再使用，重新打开立即恢复
      // ===== 上游超时旋钮（毫秒；对应四段超时的可配置化，0/缺省 = 用内置默认） =====
      firstByteBaseMs: 30000,      // 首字节基础预算（30s，按输入规模追加、封顶 firstByteMaxMs）
      firstByteMaxMs: 180000,      // 首字节预算封顶（超长 prompt 的 prefill 可能上百秒）
      streamIdleMs: 300000,        // 流式相邻数据空闲超时（300s，收到新数据即重置）
      httpJsonTimeoutMs: 60000,    // 非流式 JSON 请求（额度查询 / token 刷新）总超时（60s）
      retrySameAccountCount: 1,    // 瞬时错误同账号原地重发次数（0~5，对齐 retryCount）
      retrySameAccountIntervalMs: 1000, // 同账号原地重发退避间隔（毫秒，200~10000）
      rateRetryDelayMs: 1000,      // 无明示重置时间的 429 同号退避基数（毫秒，实际延迟带 ±15% 抖动；
                                   // 1000~15000。上游窗口更长时调大比「冷却换号」划算）
      dedupeSameBody: true,        // 同 body 请求去重排队：客户端快速重试时，后来的请求等前一个结束再发
                                   // （防风控识别为反代：同一账号连发同一份内容是最典型的机器特征；
                                   // 关掉后并发重试会全部并行打到上游，也更容易把上游拦截窗口续期）
      dedupeWaitMs: 45000,         // 去重排队等待上限（毫秒，1000~300000）：到点无条件放行，
                                   // 宁可多一个并发，也不让用户被一个卡住的前序请求挂住
    },
    // 局域网管理访问：浏览器登录管理页的令牌（落盘密文；明文只经桌面 IPC admin_access_info 交给设置页）。
    // 首次启动由 main.cjs 调 ensureAdminToken() 自动生成 24 字节随机串，不允许清空。
    admin: {
      token: "",
    },
    // 配置升级标记：< 2 的配置来自旧版（或首份配置），loadConfig 会强制开启「最小化到托盘」；
    // 用户之后在设置页显式关闭时连同本标记一起落盘，此后尊重用户选择
    configVersion: 2,
  };
}

/** 深合并：默认值补齐缺失字段；以 cfg 的键为准（tools 里的自定义工具 id 是动态键，
 *  不在默认值里，必须原样收进来），null 一律不收（防打穿必填子对象） */
function mergeConfig(def, cfg) {
  const out = { ...def };
  if (!cfg || typeof cfg !== "object") return out;
  for (const k of Object.keys(cfg)) {
    const dv = def ? def[k] : undefined;
    const cv = cfg[k];
    if (dv && typeof dv === "object" && !Array.isArray(dv) && cv && typeof cv === "object" && !Array.isArray(cv)) {
      out[k] = mergeConfig(dv, cv);
    } else if (cv !== undefined && cv !== null) {
      out[k] = cv;
    }
  }
  return out;
}

// ===== 按渠道自动签到规则（proxy.checkinAutoRules）：号池页每个渠道一套时间/抖动 =====

/** 规则可覆盖的渠道清单（旧全局配置迁移时铺满用；与 proxy/store.cjs 的 CHANNELS 对齐，新增渠道记得补） */
const CHECKIN_RULE_CHANNELS = ["trae", "workbuddy", "workbuddy_ai", "raccoon", "modelscope", "lobster", "zcode", "qoder", "qoder_intl", "autoclaw", "autoclaw_intl"];

/** HH:mm 归一化：格式或数值越界（h>23 / m>59）一律回落 09:00（配置可能被手改，下游 tick 不必再判合法性） */
function normalizeHm(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || "").trim());
  if (!m) return "09:00";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "09:00";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** 抖动分钟数归一化：0~180 整数（到点后随机延迟 0~N 分钟执行） */
function normalizeJitter(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(180, Math.max(0, n)) : 0;
}

/** 按渠道规则归一化：剔除畸形项，逐渠道收敛为 { enabled, time, jitterMin } 三键 */
function normalizeCheckinRules(rules) {
  const out = {};
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return out;
  for (const [id, r] of Object.entries(rules)) {
    if (!r || typeof r !== "object") continue;
    out[id] = { enabled: r.enabled === true, time: normalizeHm(r.time), jitterMin: normalizeJitter(r.jitterMin) };
  }
  return out;
}

// 本次 loadConfig 读到的是否为旧配置（磁盘无 configVersion 或 < 2）：版本升级日志（规格 9.1）
// 据此在启动链里记一条「已升级到新版本」。模块级临时标记，随每次 loadConfig 刷新
let lastLoadLegacy = false;

/** 本次读取是否为旧配置（版本升级标记）：loadConfig 后取值，供启动链决定是否记升级日志 */
function wasLastLoadLegacy() {
  return lastLoadLegacy;
}

/** 加载配置（不存在/损坏时返回默认；损坏时留档 .bak） */
function loadConfig() {
  const p = configPath();
  let disk = {};
  if (fs.existsSync(p)) {
    try {
      disk = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      try { fs.rmSync(p + ".bak", { force: true }); fs.renameSync(p, p + ".bak"); } catch { /* 留档失败忽略 */ }
      disk = {};
    }
  }
  // 整个文件不是对象（null/数字/数组）也当没有，不然合并完必炸
  if (!disk || typeof disk !== "object" || Array.isArray(disk)) disk = {};
  // 升级标记（configVersion）：旧版配置 / 首份配置没有该字段，「最小化到托盘」升级时强制开启
  // （新版关窗销毁界面进程，托盘是唯一的唤回入口）；用户显式关闭后随整份保存落盘 configVersion: 2，
  // 此后不再强制——所以判定只认磁盘原值，不能看合并结果（默认值恒为 2）
  const legacyConfig = Number(disk.configVersion || 0) < 2;
  lastLoadLegacy = legacyConfig; // 版本升级标记（规格 9.1）：本次读取是否为旧配置
  const merged = mergeConfig(defaultConfig(), disk);
  // 迁移：旧版 proxy.autoStart / proxy.restoreOnLaunch 都是「网关是否随应用启动」的历史开关，
  // 现在固定为启动即监听（设置页已无对应选项），旧值一律丢弃，改完存盘即不再出现
  if (merged.proxy && "autoStart" in merged.proxy) delete merged.proxy.autoStart;
  if (merged.proxy && "restoreOnLaunch" in merged.proxy) delete merged.proxy.restoreOnLaunch;
  // 迁移：全局快捷键与轻量模式已从设置页移除（后者由 minimizeToTray 直接决定关窗是否
  // 销毁界面进程），旧字段一律丢弃，改完存盘即不再出现
  if (merged.schedule) {
    delete merged.schedule.shortcutToggle;
    delete merged.schedule.lightweightMode;
  }
  // 迁移：旧版「全局定时自动签到」（proxy.checkinAuto / checkinAutoTime）→ 按渠道规则
  // （号池页每个渠道各自设时间与抖动）。只在旧开关确实开着时搬到全部渠道；搬完即删旧字段，
  // 天然防二次搬运——用户之后在号池页手改的规则不会被旧值再覆盖
  {
    const legacyOn = merged.proxy.checkinAuto === true;
    const legacyTime = normalizeHm(merged.proxy.checkinAutoTime);
    delete merged.proxy.checkinAuto;
    delete merged.proxy.checkinAutoTime;
    if (legacyOn && !Object.keys(normalizeCheckinRules(merged.proxy.checkinAutoRules)).length) {
      const seeded = {};
      for (const id of CHECKIN_RULE_CHANNELS) seeded[id] = { enabled: true, time: legacyTime, jitterMin: 0 };
      merged.proxy.checkinAutoRules = seeded;
    }
  }
  merged.proxy.checkinAutoRules = normalizeCheckinRules(merged.proxy.checkinAutoRules);
  if (merged.theme !== "dark" && merged.theme !== "light") merged.theme = "dark";
  // 旧配置的 moduleOrder/modules（板块排序与开关）已废弃：直接剔除，不再读写
  delete merged.moduleOrder;
  delete merged.modules;
  // 旧配置的动效字段（fx/fxParticles/fxPools/fxCursor）与软件更新字段（update）已随对应功能移除：直接剔除
  delete merged.fx;
  delete merged.fxParticles;
  delete merged.fxPools;
  delete merged.fxCursor;
  delete merged.update;
  // 号池 WebDAV/S3 同步已随功能移除：webdav / webdavShared / proxy.poolsyncSchedule 与上面同理，
  // 旧配置残留字段一律剔除，不再读写
  delete merged.webdav;
  delete merged.webdavShared;
  if (merged.proxy) delete merged.proxy.poolsyncSchedule;
  // 远程实例已随功能移除：
  // remoteTargets / remoteActiveId 与上面同理，旧配置残留字段一律剔除，不再读写
  delete merged.remoteTargets;
  delete merged.remoteActiveId;
  // 升级强制托盘常驻（仅旧配置 / 首份配置；用户显式关闭过的配置带 configVersion: 2 不再强制）
  if (legacyConfig) merged.schedule.minimizeToTray = true;
  merged.configVersion = 2;
  return merged;
}

/** 保存配置（先写临时文件再原子替换，写一半断电不留半个 JSON） */
function saveConfig(cfg) {
  const p = configPath();
  const disk = JSON.parse(JSON.stringify(cfg));
  // 中转名带 pid，与本仓其余原子写同形（memory/config.cjs、memory/store.cjs、synonyms.cjs、
  // inject.cjs 早就是 `.tmp.${process.pid}`）：固定名时两个写入者会互相把对方的 .tmp rename 走
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return { ok: true, message: "设置保存成功" };
}

/** 由「独立 IPC 直接写盘」或「只手工编辑 config.json」的 proxy 字段 —— 设置页表单不拥有它们，
 *  渲染层的 config 快照可能过期，整份保存会把它们冲掉（issue #90）。
 *  · channelEnabled   ← proxy_channel_toggle（上游启闭）
 *  · checkinAutoRules ← proxy_checkin_auto_set（按渠道自动签到）
 *  · enableAnthropic / enableResponses ← 新增协议面的紧急止血开关。界面不提供入口，
 *    用户按注释提示手工改 config.json；而「手工改完要重启才进内存快照」这件事不能当约束——
 *    应用在跑的时候改盘，之后任何一次无关的整份保存（切主题、拖模块顺序）都会把这个
 *    刚写下的 false 抹掉，等于止血开关自己会弹回来。故与上面两个字段同列，以磁盘为准。
 *  注意：只应在这两个字段**各自的写入 IPC** 里绕过本名单；它们调的是 saveConfig。 */
const OUT_OF_BAND_PROXY_FIELDS = ["channelEnabled", "checkinAutoRules", "enableAnthropic", "enableResponses"];

/** out-of-band 合并：这四个字段以**磁盘当前值**为准——磁盘有该键就用磁盘值，磁盘没有
 *  （= 用户从未设置过）则把提交值丢掉，界面 / 浏览器都无权代写。设置页整份提交
 *  （saveConfigFromUI）与浏览器反代配置保存（proxy_config_save）共用这一份，不各抄一遍。
 *  proxy 段必须是普通对象：数组不算（typeof [] === "object" 会让它蒙混过关，落成 "proxy": []），
 *  一律归为非法形状。原地改 incoming 并返回（只动 incoming.proxy）。 */
function mergeOutOfBandProxy(disk, incoming) {
  const next = incoming && typeof incoming === "object" ? incoming : {};
  if (!next.proxy || typeof next.proxy !== "object" || Array.isArray(next.proxy)) next.proxy = {};
  const diskProxy = (disk && disk.proxy) || {};
  for (const k of OUT_OF_BAND_PROXY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(diskProxy, k)) next.proxy[k] = diskProxy[k];
    else delete next.proxy[k];
  }
  return next;
}

/** 反代端口合法区间：管理服务端口 = 反代端口 + 1，所以 0 与 65535 都不可用（后者 +1 越界）。
 *  设置页整份保存（saveConfigFromUI）与浏览器反代段保存（proxy_config_save）共用这一份判定：
 *  否则用户能保存成功，反代继续监听，但管理服务被静默停掉，浏览器页突然打不开。 */
function validateProxyPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65534) {
    return { ok: false, message: "反代端口必须是 1~65534 的整数（管理端口 = 反代端口 + 1，0 与 65535 都不可用）" };
  }
  return { ok: true, message: "" };
}

/** 设置页保存路径专用：先把 out-of-band 字段以**磁盘值**为准，再落盘。
 *
 *  为什么必须区分 saveConfig / saveConfigFromUI：
 *    那两个字段的写入方（channel 启闭、签到规则）也是调 saveConfig 落盘的。
 *    若把「磁盘优先」写进 saveConfig，它们自己的写入会被自己刚改的值覆盖回去 —— 功能当场失效。
 *    所以「磁盘优先」只适用于**设置页整份提交**这一条路径。
 *
 *  为什么不能在渲染层单独解决：没有渲染层的部署形态（HTTP / Web 端）同样能提交整份配置，
 *    后端这层兜底对两条路径都生效。
 *  返回 saveConfig 的结果（含校验失败时抛出的 toolErrors）。 */
function saveConfigFromUI(cfg) {
  const next = cfg && typeof cfg === "object" ? cfg : {};
  // proxy 段形状非法（数组 / null / 原始值）明确失败、不写盘（Ruling 27）：落成 "proxy": [] 后
  // 回读 port / concurrency 全 undefined，属于写坏配置。放在读盘 try 之前——
  // 那段 catch 的是「读盘失败不拦保存」，不能把这里的拒绝也一并吞掉
  if ("proxy" in next && (!next.proxy || typeof next.proxy !== "object" || Array.isArray(next.proxy))) throw new Error("配置格式不正确：proxy 段必须是对象");
  // 端口越界（0 / 65535 之类）不写盘，返回明确失败：写进去以后管理端口 +1 无从计算，
  // 管理服务会被静默停掉——用户只看到浏览器页突然打不开（I2）。
  // 只校验**显式提交**的 port：部分提交（未带 port，如只改别的段）以磁盘值为准，不因缺失而误拒
  if (next.proxy && Object.prototype.hasOwnProperty.call(next.proxy, "port")) {
    const portCheck = validateProxyPort(next.proxy.port);
    if (!portCheck.ok) return portCheck;
  }
  try {
    const disk = loadConfig();
    mergeOutOfBandProxy(disk, next);
    // admin 令牌只经 admin_set_token 修改（不允许清空，也不能被设置页整份提交的旧快照覆盖回去）：以磁盘为准
    if (disk && disk.admin) next.admin = disk.admin;
  } catch { /* 读盘失败时退回原行为（宁可保存成功，也不要让设置页整体保存失败） */ }
  // 保存即视为已升级配置（托盘常驻强制只对 configVersion < 2 的旧配置生效）
  next.configVersion = 2;
  return saveConfig(next);
}

// ===== 管理令牌（局域网浏览器登录管理页用） =====
// 令牌是敏感凭据：落盘走 encryptSecret 密文，明文只经桌面 IPC 交给设置页展示，
// 不写日志、不进崩溃日志。
// 令牌来源只有一处：本文件的 config.admin.token（ensureAdminToken 自动生成 / setAdminToken 修改）。

/** 令牌生成（幂等）：已有可解出的令牌直接复用，缺失 / 解不开才生成 24 字节随机串并加密落盘 */
function ensureAdminToken() {
  const cfg = loadConfig();
  const cur = decryptSecret(cfg.admin && cfg.admin.token);
  if (cur) return cur;
  const token = crypto.randomBytes(24).toString("hex");
  cfg.admin = { ...(cfg.admin || {}), token: encryptSecret(token) };
  saveConfig(cfg);
  return token;
}

/** 本机局域网 IPv4（多网卡取枚举顺序第一个非回环地址；取不到返回 ""） */
function lanIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a && (a.family === "IPv4" || a.family === 4) && !a.internal) return a.address;
    }
  }
  return "";
}

/** 管理访问信息（桌面 IPC 专用，返回令牌明文）：
 *  地址由配置计算（反代端口 + 1），不依赖管理服务是否已启动；
 *  url 优先局域网地址、取不到回退回环，loopbackUrl / lanUrl 两个地址都给（界面分别展示）；
 *  端口非法（0 / 65535 之类会让 +1 后不是合法端口）时 available=false、地址为空 */
function adminAccessInfo() {
  const cfg = loadConfig();
  const port = Number(cfg.proxy && cfg.proxy.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65534;
  const adminPort = validPort ? port + 1 : 0;
  const lanIp = lanIPv4();
  return {
    available: validPort,
    message: validPort ? "" : "反代端口配置非法，管理地址不可用",
    url: validPort ? `http://${lanIp || "127.0.0.1"}:${adminPort}` : "",
    loopbackUrl: validPort ? `http://127.0.0.1:${adminPort}` : "",
    lanUrl: validPort && lanIp ? `http://${lanIp}:${adminPort}` : "",
    token: decryptSecret(cfg.admin && cfg.admin.token) || ensureAdminToken(),
  };
}

/** 令牌变更钩子：管理令牌变更后要作废所有浏览器会话。
 *  会话模块（管理 HTTP 服务侧的 adminCrypto）启动时注册 clearSessions 即可接上，
 *  setAdminToken 成功后会逐一调用；返回退订函数。钩子抛错不影响令牌写入结果 */
const adminTokenListeners = [];
function onAdminTokenChanged(fn) {
  if (typeof fn !== "function") return () => {};
  adminTokenListeners.push(fn);
  return () => {
    const i = adminTokenListeners.indexOf(fn);
    if (i >= 0) adminTokenListeners.splice(i, 1);
  };
}

/** 修改管理令牌：非空且 ≥16 位（不允许清空）；成功后触发令牌变更钩子（作废所有管理会话，浏览器需重新登录） */
function setAdminToken(token) {
  const t = String(token == null ? "" : token).trim();
  if (!t) return { ok: false, message: "令牌不能为空" };
  if (t.length < 16) return { ok: false, message: "令牌至少 16 位" };
  const cfg = loadConfig();
  cfg.admin = { ...(cfg.admin || {}), token: encryptSecret(t) };
  saveConfig(cfg);
  for (const fn of [...adminTokenListeners]) {
    try { fn(); } catch { /* 钩子失败不拦令牌更新（会话没清干净由重新登录兜底） */ }
  }
  return { ok: true, message: "令牌已更新，浏览器需重新登录" };
}

// 开机自启即时生效；便携版注册的是临时解压路径，开发模式不必注册
function applyAutoStart(cfg) {
  if (isPortable() || !electronApp || process.env.VITE_DEV_SERVER_URL) return;
  try {
    if (!electronApp.isPackaged) return;
    electronApp.setLoginItemSettings({ openAtLogin: !!(cfg.schedule && cfg.schedule.autoStart) });
  } catch { /* 注册失败不拦保存 */ }
}

module.exports = {
  dataDir, configPath, loadConfig, saveConfig, defaultConfig, ENC_PREFIX,
  isPortable, encryptSecret, decryptSecret, isEncrypted, applyAutoStart,
  normalizeHm, normalizeJitter, wasLastLoadLegacy,
  saveConfigFromUI, mergeOutOfBandProxy, OUT_OF_BAND_PROXY_FIELDS, validateProxyPort,
  ensureAdminToken, adminAccessInfo, setAdminToken, onAdminTokenChanged,
};
