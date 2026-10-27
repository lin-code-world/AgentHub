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
// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境（npm run dev:web 预览 UI）
// 回退到本地 mock。命令清单与 electron/preload.cjs 白名单、backend/ipc.cjs 一一对应
import type {
  AppConfig,
  ProxyConfig,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyStatsDim, ProxyStatsAggRow, ProxyStatsKeyRow,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy, ProxyCostTier,
  ProxyCheckinRow, ZcodeDeviceStatusResult, ZcodeClaimModeResult,
  ProxyProvider, ProxyProviderKind, ProxyProviderModel, ProxyProviderTestResult,
  ProxyOpLogList,
} from "../types";

export type {
  AppConfig,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyStatsDim, ProxyStatsAggRow, ProxyStatsKeyRow,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy, ProxyCostTier,
  ProxyAccountStatus, ProxyEvent, ProxyCheckinRow,
  ProxyOpLogList, ProxyOpLogRow,
} from "../types";

import { mock } from "./mock";
import { denyReason, isWebTransport } from "./caps";
import { subscribeWebEvents } from "./events";
import { webInvoke } from "./web-transport";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Electron preload 桥接（window.agenthub.invoke / onUpdateEvent） */
declare global {
  interface Window {
    agenthub?: {
      invoke: InvokeFn;
      onUpdateEvent?: (callback: (payload: unknown) => void) => () => void;
    };
  }
}

/** 是否运行在 Electron 桌面端（有 preload 桥）。
 *  托盘、原生窗口、开机自启等桌面独占能力在 Web / 容器形态（server/index.cjs）不存在，
 *  UI 需要据此隐藏或置灰对应入口。 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.agenthub;
}

// ipcRenderer.invoke 走 structuredClone，Vue 的深层响应式 Proxy 会直接抛
// "An object could not be cloned"，这里统一脱壳，各接口不必再自行深拷贝
function toPlain<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** 渲染层看门狗默认时限：主进程 handler 挂起时，超过即按失败 reject，
 *  页面 try/finally 里的 busy/loading 才会必然复位——把「永久卡死」降级为「可重试的超时错误」。
 *  注意：超时只结束渲染端等待，不取消主进程任务本身；
 *  长任务（同步/导入/蒸馏/签到批量/等用户操作的原生对话框）在下方各自显式传 0 关闭看门狗，
 *  它们另有主进程侧互斥、进度事件或取消 IPC 托底。 */
const DEFAULT_TIMEOUT_MS = 45_000;

function invokeWithTimeout<T>(p: Promise<T>, cmd: string, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`命令 ${cmd} 响应超时（${Math.round(timeoutMs / 1000)}s）：主进程可能正忙或已卡住，请稍后重试；持续出现请重启应用`));
    }, timeoutMs);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 后端错误信封（{ok:false,message}）统一转异常：混进正常数据会把页面打花 */
function unwrapResult<T>(cmd: string, res: unknown): T {
  if (res && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
    const msg = (res as { message?: unknown }).message;
    throw new Error(typeof msg === "string" && msg ? msg : `命令 ${cmd} 执行失败`);
  }
  return res as T;
}

async function call<T>(cmd: string, args?: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (isElectron()) {
    const res = await invokeWithTimeout(window.agenthub!.invoke(cmd, toPlain(args)), cmd, timeoutMs);
    return unwrapResult<T>(cmd, res);
  }
  // Web 托管形态：deny 命令在调用层拦下（一个函数覆盖全部调用点），文案由服务端能力清单下发
  if (isWebTransport()) {
    const denied = denyReason(cmd);
    if (denied) throw new Error(denied);
    const res = await invokeWithTimeout(webInvoke(cmd, toPlain(args)), cmd, timeoutMs);
    return unwrapResult<T>(cmd, res);
  }
  // 浏览器回退：直接走 mock
  return (await mock.invoke(cmd, args)) as T;
}

// ===== 框架：配置 =====
export const loadConfig = () => call<AppConfig>("load_config");
export const saveConfig = (cfg: AppConfig) =>
  call<{ ok: boolean; message: string }>("save_config", { config: JSON.parse(JSON.stringify(cfg)) });

// ===== 框架：其它 =====
export const getDataDir = () => call<string>("get_data_dir");
export const openDataDir = () => call<void>("open_data_dir");
// 等用户操作原生目录选择框，时长不可控，关掉看门狗
export const browseDir = () => call<{ ok: boolean; canceled?: boolean; path: string | null }>("browse_dir", {}, 0);
export const getIsPortable = () => call<boolean>("get_is_portable");

/** 局域网管理访问信息（令牌明文只交本机设置页展示 / 复制）：
 *  url 优先局域网地址、取不到回退回环；loopbackUrl / lanUrl 是两个原始地址；
 *  端口非法（0 / 65535 之类）时 available=false、地址为空 */
export type AdminAccessInfo = { available: boolean; message: string; url: string; loopbackUrl: string; lanUrl: string; token: string };
export const adminAccessInfo = () => call<AdminAccessInfo>("admin_access_info");
/** 修改管理令牌（非空且 ≥16 位）：成功后浏览器里的管理会话全部作废，需重新登录 */
export const adminSetToken = (token: string) => call<{ ok: boolean; message?: string }>("admin_set_token", { token });

/** 订阅主进程广播（网关状态 / 额度刷新 / 配置变更），返回退订函数。
 *  Web 托管形态走 SSE（信封同形）；纯静态预览（mock）没有事件源 */
export function onUpdateEvent(cb: (payload: unknown) => void): (() => void) | undefined {
  if (window.agenthub?.onUpdateEvent) return window.agenthub.onUpdateEvent((payload) => cb(payload));
  if (isWebTransport()) return subscribeWebEvents(cb);
  return undefined;
}

// ===== 反代网关：服务启停 / 状态 =====
export const proxyStatus = () => call<ProxyGatewayStatus>("proxy_status");
export const proxyStart = () => call<{ ok: boolean; port?: number; already?: boolean; message?: string }>("proxy_start");
export const proxyStop = () => call<{ ok: boolean }>("proxy_stop");
export const proxyRestart = () => call<{ ok: boolean; port?: number; message?: string }>("proxy_restart");

/** 反代配置段读写（浏览器托管形态专用）：load_config / save_config 在 browser 形态被 deny，
 *  配置页改走这一对只操作 config.proxy 的命令；桌面仍走整份 load_config / save_config。
 *  save 只写反代段：out-of-band 字段（上游启闭 / 签到规则 / 协议面止血开关）以磁盘为准，port / bind 被忽略 */
export const proxyConfigGet = () => call<ProxyConfig>("proxy_config_get");
export const proxyConfigSave = (cfg: ProxyConfig) => call<{ ok: boolean; message?: string }>("proxy_config_save", { config: JSON.parse(JSON.stringify(cfg)) });

// ===== 反代网关：API Keys =====
export const proxyKeysList = () => call<ProxyKeyRow[]>("proxy_keys_list");
export const proxyKeyCreate = (opts: { name: string; route: ProxyRoute; routeOrder?: string; dailyQuota: number; rateLimit?: number }) =>
  call<ProxyKeyRow & { secret: string }>("proxy_key_create", opts as unknown as Record<string, unknown>);
export const proxyKeyUpdate = (id: string, patch: Partial<Pick<ProxyKeyRow, "name" | "route" | "routeOrder" | "dailyQuota" | "rateLimit" | "enabled">>) =>
  call<{ ok: boolean; message?: string }>("proxy_key_update", { id, ...patch });
export const proxyKeyDelete = (id: string) => call<{ ok: boolean; message?: string }>("proxy_key_delete", { id });
/** 批量删除（Key 列表多选）：主进程逐个走单删链路（墓碑先行 + WebDAV 传播），removed = 实删条数 */
export const proxyKeysDeleteBatch = (ids: string[]) =>
  call<{ ok: boolean; removed?: number; missing?: number; message?: string }>("proxy_keys_delete", { ids });

// ===== 反代网关：号池 / 凭据接入 =====
export const proxyPool = () => call<ProxyChannelView[]>("proxy_pool");
/** 渠道启闭（「上游启闭」弹窗）：list = 全量含已关闭渠道（带 enabled）；toggle = 写配置 + 广播事件即时生效 */
export const proxyChannelList = () => call<ProxyChannelView[]>("proxy_channel_list");
export const proxyChannelToggle = (channel: ProxyChannelId | string, enabled: boolean) =>
  call<{ ok: boolean; channel?: string; enabled?: boolean; message?: string }>("proxy_channel_toggle", { channel, enabled });
export const proxyPoolStrategy = (channel: ProxyChannelId, strategy: ProxyPoolStrategy) =>
  call<{ ok: boolean; message?: string }>("proxy_pool_strategy", { channel, strategy });
/** 渠道成本档（cost-first 路由排序的标注来源） */
export const proxyPoolTier = (channel: ProxyChannelId, tier: ProxyCostTier) =>
  call<{ ok: boolean; message?: string }>("proxy_pool_tier", { channel, tier });
export const proxyAccountAdd = (opts: { channel: ProxyChannelId; name?: string; token: string; refreshToken?: string; uid?: string }) =>
  call<{ ok: boolean; id?: string; message?: string }>("proxy_account_add", opts as unknown as Record<string, unknown>);
export const proxyAccountRemove = (id: string) => call<{ ok: boolean; message?: string }>("proxy_account_remove", { id });
/** 批量删除（号池列表多选）：主进程逐个走单删链路（墓碑先行 + WebDAV 传播），removed = 实删条数 */
export const proxyAccountRemoveBatch = (ids: string[]) =>
  call<{ ok: boolean; removed?: number; missing?: number; message?: string }>("proxy_account_remove_batch", { ids });
/** 明文导出选中账号（号池多选「导出凭据」）：token/refreshToken 为解密后的明文，
 *  供用户在其它软件里直接使用；落盘由渲染层 Blob 下载完成 */
export const proxyAccountExportPlain = (ids: string[]) =>
  call<{ ok: boolean; accounts?: Record<string, unknown>[]; missing?: string[]; exportedAt?: number; message?: string }>(
    "proxy_account_export_plain",
    { ids }
  );
export const proxyAccountToggle = (id: string, enabled: boolean) =>
  call<{ ok: boolean; message?: string }>("proxy_account_toggle", { id, enabled });
/** 重命名账号（自定义备注），WebDAV 同步时 LWW 传播 */
export const proxyAccountRename = (id: string, name: string) =>
  call<{ ok: boolean; message?: string }>("proxy_account_rename", { id, name });
/** 账号备注（号池列表「备注」弹窗）：落 meta.note，随 WebDAV 快照导出 + 备注新者胜传播 */
export const proxyAccountNote = (id: string, note: string) =>
  call<{ ok: boolean; message?: string }>("proxy_account_note", { id, note });
/** 手动解除冷却：cooling 账号立即回 online，releasedModels = 同时豁免的模型级负缓存条数 */
export const proxyAccountCoolOff = (id: string) =>
  call<{ ok: boolean; message?: string; releasedModels?: number }>("proxy_account_cool_off", { id });
// 单账号上游刷新：主进程 httpJson 60s 硬上限，超过 45s 默认看门狗，豁免
export const proxyAccountRefresh = (id: string) =>
  call<{ ok?: boolean; id?: string; credits?: number; expiresAt?: number; message?: string }>("proxy_account_refresh", { id }, 0);
export const proxyCreditsRefresh = () =>
  // 逐账号串行刷新，账号多必然超 45s
  call<{ ok: boolean; total?: number; failed?: number; message?: string }>("proxy_credits_refresh", {}, 0);
/** 只刷新指定渠道的号池额度（号池页右上角「刷新当前渠道」） */
export const proxyCreditsRefreshChannel = (channel: ProxyChannelId) =>
  call<{ ok: boolean; total?: number; failed?: number; results?: { ok: boolean; message?: string; unavailable?: boolean; credits?: number }[] }>(
    "proxy_credits_refresh_channel",
    { channel },
    0
  );
/** 批量签到：status = 查询状态；checkin = 执行签到；trial = 国际版加油包（action 缺省 checkin）。
 *  逐账号串行 + 随机抖动 + 可能的验证码二段流，主进程 checkinBusy 互斥托底，豁免看门狗 */
export const proxyCheckinStatus = (channel?: ProxyChannelId | "", accountId?: string) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[] }>("proxy_checkin_status", { channel, accountId }, 0);
export const proxyCheckinRun = (opts: { channel?: ProxyChannelId | ""; accountId?: string; action?: "checkin" | "trial" }) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[]; message?: string }>("proxy_checkin_run", opts as Record<string, unknown>, 0);
/** 按渠道设置自动签到（号池页「自动签到」弹窗）：时间/抖动写整体配置，保存即生效；读源在 proxy_pool 视图 */
export const proxyCheckinAutoSet = (opts: { channel: ProxyChannelId; enabled: boolean; time: string; jitterMin: number }) =>
  call<{ ok: boolean; channel: ProxyChannelId; enabled: boolean; time: string; jitterMin: number; message?: string }>(
    "proxy_checkin_auto_set",
    opts as unknown as Record<string, unknown>
  );
/** 扫描本机已装软件的登录态（凭据不出主进程，只回候选信息） */
export const proxyScan = () => call<ProxyScanCandidate[]>("proxy_scan");
/** 导入本机候选；file/uid 用于身份核对（两次扫描之间文件变化时不至于导错账号） */
export const proxyScanImport = (index: number, channel?: ProxyChannelId, file?: string, uid?: string) =>
  call<{ ok: boolean; id?: string; updated?: boolean; message?: string }>("proxy_scan_import", { index, channel, file, uid });
/** 拉起对应渠道的官方登录（授权页由主进程 shell.openExternal 打开，结果经 app:event 回流）；
 *  userCode 仅 Cline 设备授权返回（前端显示用户码，供手动输码） */
export const proxyOauthBegin = (channel: ProxyChannelId) =>
  call<{ ok: boolean; url?: string; mode?: string; port?: number; userCode?: string; message?: string }>("proxy_oauth_begin", { channel });
/** AutoClaw 国际版 OAuth：带上前端跑完阿里云滑块的验证串换授权地址（主进程占白名单端口回环等回调） */
export const proxyOauthBeginWithCaptcha = (channel: ProxyChannelId, captchaVerifyParam: string, vendor: "zai" | "google" = "zai") =>
  call<{ ok: boolean; url?: string; mode?: string; port?: number; message?: string }>("proxy_oauth_begin", { channel, captchaVerifyParam, vendor }, 0);
/** AutoClaw 国际版：风控配置（enabled/prefix/sceneId，前端初始化阿里云滑块用） */
export const proxyAutoclawCaptchaConfig = (channel: ProxyChannelId) =>
  call<{ ok: boolean; enabled?: boolean; region?: string; prefix?: string; sceneId?: string; supplier?: string; message?: string }>("proxy_autoclaw_captcha_config", { channel }, 0);
/** AutoClaw 国内版：发送短信验证码（返回 deviceId，登录时必须沿用） */
export const proxyAutoclawSmsSend = (channel: ProxyChannelId, phone: string) =>
  call<{ ok: boolean; deviceId?: string; message?: string }>("proxy_autoclaw_sms_send", { channel, phone }, 0);
/** AutoClaw 国内版：验证码登录（deviceId 沿用发码返回值；code 传 6 位数字字符串，主进程转 JSON number） */
export const proxyAutoclawSmsLogin = (channel: ProxyChannelId, phone: string, code: string, deviceId: string) =>
  call<{ ok: boolean; id?: string; uid?: string; updated?: boolean; message?: string }>("proxy_autoclaw_sms_login", { channel, phone, code, deviceId }, 0);
/** Loomy（讯飞）：发送短信验证码（返回 msgid，登录时必须沿用） */
export const proxyLoomySmsSend = (phone: string) =>
  call<{ ok: boolean; msgid?: string; phoneTail?: string; message?: string }>("proxy_loomy_sms_send", { phone }, 0);
/** Loomy（讯飞）：验证码登录（msgid 沿用发码返回值） */
export const proxyLoomySmsLogin = (phone: string, code: string, msgid: string) =>
  call<{ ok: boolean; id?: string; uid?: string; message?: string }>("proxy_loomy_sms_login", { phone, code, msgid }, 0);
/** CodeArts 每日福利：只读探测可领项（领取走既有的批量签到链路，主进程串行换 token） */
export const proxyCodeartsWelfarePreview = (accountId = "") =>
  call<{ ok: boolean; rows?: { name: string; ok: boolean; message: string }[]; message?: string }>("proxy_codearts_welfare_preview", { accountId }, 0);
export const proxyOauthCancel = () => call<{ ok: boolean; cancelled?: boolean }>("proxy_oauth_cancel");
/** 兜底：浏览器没跳回回环地址时，把地址栏内容整段粘回来完成登录（串行换 token，可能多次上游请求） */
export const proxyOauthSubmitCallback = (channel: ProxyChannelId, url: string) =>
  call<{ ok: boolean; message?: string }>("proxy_oauth_submit_callback", { channel, url }, 0);
/** 粘贴 JSON 批量添加账号（单个对象 / 数组 / {accounts:[...]}，字段容忍别名） */
export const proxyAccountImportJson = (channel: ProxyChannelId, json: string) =>
  call<{ ok: boolean; added?: number; dup?: number; invalid?: number; message?: string }>("proxy_account_import_json", { channel, json });
/** 从 JSON/ZIP 文件添加账号（主进程弹文件选择框等用户操作；zip 读取包内全部 .json 合并导入） */
export const proxyAccountImportFile = (channel: ProxyChannelId) =>
  call<{ ok: boolean; canceled?: boolean; added?: number; dup?: number; invalid?: number; file?: string; message?: string }>("proxy_account_import_file", { channel }, 0);
/** 浏览器端上传 JSON 文件的文本导入（渲染层 input[type=file] 读成文本传入，只支持单个 .json，不做 ZIP） */
export const proxyAccountImportText = (channel: ProxyChannelId, text: string) =>
  call<{ ok: boolean; added?: number; dup?: number; invalid?: number; message?: string }>("proxy_account_import_text", { channel, text });

// ===== 反代网关：模型 / 统计 / 规则 =====
export const proxyModels = () => call<ProxyModel[]>("proxy_models");
export const proxyModelsSync = (channel: string) =>
  // 外网拉模型目录，主进程 httpJson 60s 上限
  call<{ ok: boolean; channel?: string; count?: number; withRate?: number; message?: string }>("proxy_models_sync", { channel }, 0);

// ===== 反代网关：自定义提供商（中转站 / 自建 OpenAI 兼容端点） =====

/** 创建 / 更新的入参。id 即路由前缀（`id/model` 里的 id），创建后不可改。
 *  create 可带 keys（表单一次填完）；update 忽略 keys，Key 走 add/remove 两条命令。 */
export interface ProxyProviderInput {
  id: string;
  display?: string;
  baseUrl: string;
  kind?: ProxyProviderKind;
  models?: ProxyProviderModel[];
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  enabled?: boolean;
  keys?: { name?: string; key: string }[];
}

export const proxyProviderList = () =>
  call<{ ok: boolean; providers?: ProxyProvider[]; message?: string }>("proxy_provider_list");
export const proxyProviderCreate = (input: ProxyProviderInput) =>
  call<{ ok: boolean; provider?: ProxyProvider; keyIds?: string[]; message?: string }>("proxy_provider_create", input as unknown as Record<string, unknown>);
export const proxyProviderUpdate = (input: Partial<ProxyProviderInput> & { id: string }) =>
  call<{ ok: boolean; provider?: ProxyProvider; message?: string }>("proxy_provider_update", input as unknown as Record<string, unknown>);
export const proxyProviderDelete = (id: string) =>
  call<{ ok: boolean; message?: string }>("proxy_provider_delete", { id });
export const proxyProviderAddKey = (id: string, key: string, name?: string) =>
  call<{ ok: boolean; id?: string; message?: string }>("proxy_provider_add_key", { id, key, name });
export const proxyProviderRemoveKey = (accountId: string) =>
  call<{ ok: boolean; message?: string }>("proxy_provider_remove_key", { accountId });
/** 用表单里当场填的地址 + Key 发一次真实最小请求（会产生上游计费，UI 已提示）。
 *  key 与 accountId 二选一：编辑态不重填 Key 时按号池账号 id 让主进程自己解密，明文不出主进程。 */
export const proxyProviderTest = (input: {
  id?: string; accountId?: string; baseUrl: string; key: string; model: string;
  kind?: ProxyProviderKind; extraHeaders?: Record<string, string>; extraBody?: Record<string, unknown>;
}) => call<ProxyProviderTestResult>("proxy_provider_test", input as unknown as Record<string, unknown>);
/** 拉上游 /v1/models：用该提供商号池里的 Key，因此必须先存过一次 Key */
export const proxyProviderFetchModels = (id: string) =>
  call<{ ok: boolean; models?: string[]; message?: string }>("proxy_provider_fetch_models", { id });

/** 切号预检事实（确认框展示用）：目标客户端是否在运行 / 安装路径 / 切完是否自动重启 */
export interface IdeSwitchProbe {
  channel: string;
  clientName: string;
  file: string;
  exe: string;
  running: boolean;
  relaunch: boolean;
  note?: string;
  warning?: string;
}

/** 切号（所有渠道首调一律只做只读预检并返回 needConfirm + probe，前端弹确认框展示真实探测事实；
 *  用户确认后传 confirmAck 重调才真正执行——关客户端、等退出、写回、按原状拉起。
 *  预检判定「切不了」时直接回 ok:false，不弹框。确认后关客户端等退出时长不可控，故关闭看门狗） */
export const proxyIdeSwitch = (accountId: string, confirmAck?: boolean) =>
  call<{ ok: boolean; channel?: string; file?: string; backup?: string; needConfirm?: boolean; probe?: IdeSwitchProbe; relaunched?: boolean; message?: string }>("proxy_ide_switch", { accountId, confirmAck }, 0);
export const proxyIdeStatus = () => call<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; raccoonInstalled?: boolean; modelscopeInstalled?: boolean; lobsterInstalled?: boolean; zcodeInstalled?: boolean; qoderInstalled?: boolean; qoderIntlInstalled?: boolean; currentUid: string }>("proxy_ide_status");
/** zcode 切号回滚（切出问题 / 远程连接异常时一键还原最近一次切前状态） */
export const proxyZcodeSwitchRollback = () =>
  call<{ ok: boolean; message?: string }>("proxy_zcode_switch_rollback");
/** zcode 设备指纹诊断（只读）：多号共用一枚指纹 = 一号领取全组 1004 的病灶定位 */
export const proxyZcodeDeviceStatus = () => call<ZcodeDeviceStatusResult>("proxy_zcode_device_status");
/** zcode 设备指纹修复（幂等）：撞车/疑似被烧的账号重派全新随机指纹，claim 1004 的唯一出路 */
export const proxyZcodeDeviceRepair = (all?: boolean) =>
  call<ZcodeDeviceStatusResult & { repaired: number }>("proxy_zcode_device_repair", { all: !!all });
/** zcode 领取模式（人工链路）：live 指纹临时借出为目标账号专属指纹，官方客户端里领周末套餐用。
 *  客户端在跑时首调返回 needConfirm + probe，确认后带 confirmAck 重调（关客户端 → 写指纹 → 自动重开） */
export const proxyZcodeClaimMode = (accountId: string, confirmAck?: boolean) =>
  call<ZcodeClaimModeResult>("proxy_zcode_claim_mode", { accountId, confirmAck }, 0);
/** zcode 恢复本机锚定指纹（领取模式收尾）：anchor.remoteMid 写回 live，手机远程随之恢复 */
export const proxyZcodeRestoreMid = (confirmAck?: boolean) =>
  call<ZcodeClaimModeResult>("proxy_zcode_restore_mid", { confirmAck }, 0);
/** zcode 独立人机校验（过码）：拉起官方验证码沙箱窗口，核销并解除风控。
 *  主进程侧已有 120s 看门狗 + 页面 SDK 15s 加载超时托底，这里留 150s 余量即可 */
export const proxyZcodeSolveCaptcha = (accountId: string) =>
  call<{ ok: boolean; message?: string }>("proxy_zcode_solve_captcha", { accountId }, 150_000);
/** 区间化统计总览：from/to 为毫秒闭区间，granularity 缺省按跨度自动决策（≤2天→小时） */
export const proxyStatsOverview = (opts?: { from?: number; to?: number; granularity?: "auto" | "hour" | "day" }) =>
  call<ProxyStatsOverview>("proxy_stats_overview", opts as Record<string, unknown>);
export const proxyStatsTop = (dim: ProxyStatsDim, days?: number) =>
  call<{ name: string; req: number; tokens: number }[]>("proxy_stats_top", { dim, days });
/** 请求明细：key/model 为模糊搜索，status 走分桶（ok/4xx/5xx/other） */
export const proxyStatsDetail = (opts: {
  from?: number;
  to?: number;
  page?: number;
  pageSize?: number;
  channel?: string;
  keyId?: string;
  key?: string;
  model?: string;
  status?: string;
}) => call<ProxyStatsDetail>("proxy_stats_detail", opts as Record<string, unknown>);
export const proxyStatsCleanup = (days?: number, all?: boolean) =>
  call<{ deleted: number }>("proxy_stats_cleanup", { days, all });
export const proxyRecent = (limit?: number) => call<ProxyUsageRow[]>("proxy_recent", { limit });

// ===== 反代网关：操作日志（「日志」页签） =====
export interface ProxyOpLogFilter {
  /** 毫秒时间戳区间（视图层由日期串换算），空/0 = 不限 */
  from?: number | null;
  to?: number | null;
  level?: string;
  op?: string;
  limit?: number;
  offset?: number;
}
export const proxyOpLogList = (filter: ProxyOpLogFilter) => call<ProxyOpLogList>("proxy_oplog_list", filter as Record<string, unknown>);
export const proxyOpLogOps = () => call<string[]>("proxy_oplog_ops");
/** 导出 Excel（.xlsx 落 downloads，文件名含毫秒时间戳）；导出当前筛选全集（无分页） */
export const proxyOpLogExport = (filter: Omit<ProxyOpLogFilter, "limit" | "offset">) =>
  call<{ ok: boolean; path?: string; count?: number; message?: string }>("proxy_oplog_export", filter as Record<string, unknown>);
export const proxyRulesList = () => call<ProxyRuleFile[]>("proxy_rules_list");

export const proxyOpenRulesDir = () => call<{ ok: boolean }>("proxy_open_rules_dir");
export const proxyOpenDataDir = () => call<{ ok: boolean }>("proxy_open_data_dir");
export const proxyVaultStatus = () => call<{ encrypted: boolean; driver: string; dataDir: string }>("proxy_vault_status");
