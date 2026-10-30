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
// 反代网关 · 外置规则热加载（第②层）
// rules/catalog.json（模型目录）落盘保存「拉取模型」的结果并热重载；其余规则只认代码里的内置默认值
// 坏 JSON 回退上次快照并在面板警示（status 里带 error）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.cjs");

// ===== 内置默认规则（上游变更时用户改文件即生效，无需发版） =====
const DEFAULTS = {
  // Trae 模型显示名 → [config_name, model_name]（必填注入字段）
  "model_map.json": {
    "deepseek-v4-flash": ["DeepSeek-V4-Flash", "deepseek_v4_flash__dev"],
    "deepseek-v4": ["DeepSeek-V4", "deepseek_v4__dev"],
    "glm-4.6": ["GLM-4.6", "glm_4_6__dev"],
    "kimi-k2": ["Kimi-K2", "kimi_k2__dev"],
    "doubao-seed-1.6": ["Doubao-Seed-1.6", "doubao_seed_1_6__dev"],
    "qwen3-coder": ["Qwen3-Coder", "qwen3_coder__dev"],
    "minimax-m2": ["MiniMax-M2", "minimax_m2__dev"],
  },
  // 模型目录：代码里不内置任何渠道的默认模型。catalog.json 是唯一权威目录，
  // 由「拉取模型」写入；没拉过时为空（模型页此时显示空态提示，点拉取后云端同步）。
  "catalog.json": {},
  // WorkBuddy 审核指纹最小改写表（from→to 逐字替换；键名要够长防误伤）
  // 对齐 sanitizeRewrites：上游按整句精确匹配拦截（400 code 11-128），
  // 只保留整句形态的改写——禁止短键全局替换（会把用户正文/代码里的普通词组一并改掉）
  "wb_template_map.json": {
    "You are Claude Code, Anthropic's official CLI for Claude": "You are CodeBuddy, an AI coding assistant tool for Claude",
    "You are Claude Code, Anthropic's official CLI.": "You are CodeBuddy, an AI coding assistant.",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.": "You are a coding agent running in the CodeBuddy CLI, a terminal-based coding assistant.",
    "Main branch (you will usually use this for PRs)": "Default branch (you will usually use this for PRs)",
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues": "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "11128": "11-128",
  },
  // 各渠道默认头 / UA 伪装 / 上游域配置 / 登录端配置
  "headers.json": {
    trae: {
      // agent 域（对话/模型目录）实证只有一个 mchost.guru（AgentHost）；
      // api.trae.cn 只服务 /trae/api/v2/...（ug/pay），打 /api/agent/... 会吃 TLB 404，
      // 故镜像默认留空（官方镜像域可用时在此填写完整 URL）
      chatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
      mirrorChatUrl: "",
      creditsUrl: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
      exchangeUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
      userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
      // 模型目录拉取：Web/Remote models（与桌面客户端同源）
      modelsUrl: "https://trae-api-cn.mchost.guru/api/remote/v1/models?functions=solo_agent_remote%2Csolo_work_remote%2Csolo_design_remote&show_custom_model=false",
      mirrorModelsUrl: "",
      userAgent: "TraeClient/TTNet",
      appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      ideVersion: "0.1.50",
      ideVersionCode: "20260811",
      clientId: "en1oxy7wnw8j9n",
      // ===== 登录（OAuth 授权页）专用：与对话头上报的版本号不是一套，别混用 =====
      // 登录主机优先由官方 GetLoginGuidance 下发，下面是下发失败时的兜底域
      loginHost: "https://www.trae.cn",
      loginGuidanceUrls: [
        "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://www.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
      ],
      // 授权地址里的 x_app_version / ExchangeToken 的 IDEVersion
      authAppVersion: "3.5.66",
      pluginVersion: "local",
      deviceBrand: "CREFG-XX",
      osVersion: "Windows 11 Home China",
      // 授权码换令牌的候选上游（依次尝试）
      accountOrigins: ["https://api.trae.cn", "https://api.trae.com.cn"],
      // 签到（user growth 域）上游
      checkinBase: "https://api.trae.cn",
    },
    workbuddy: {
      chatUrl: "https://copilot.tencent.com/v2/chat/completions",
      billingBase: "https://www.codebuddy.cn",
      // chat 出站 Origin/Referer 基域（originRefererFor 实证 CN=codebuddy.cn）
      origin: "https://www.codebuddy.cn",
      // 官方桌面端指纹（逆向实证）：三段式 UA 与 IDE 归属头组，少一项都可能被风控判为网关
      clientVersion: "5.5.4",
      cliVersion: "2.137.1",
      userAgent: "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
      billingUA: "WorkBuddy/5.5.4",
      ideName: "WorkBuddy",
      modelsUrl: "https://copilot.tencent.com/console/enterprises/personal/models",
      // v3 客户端权威目录（主路，含倍率/能力/上下文元数据）：必须用三段式 CLI UA，否则 400 code 12403
      modelsV3Url: "https://copilot.tencent.com/v3/config",
      catalogUA: "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
      // 登录/账号类插件端点的上游域（与计费域不同，必须单独给）
      pluginBase: "https://copilot.tencent.com",
      // 刷新渠道标识（两处口径不一致："plugin" 与 "workbuddy"，实测后固化）
      refreshSource: "plugin",
      // X-Device-Token 设备风控头兜底值（优先级：账号 deviceToken > 此处 > data 目录 device_token.txt）
      deviceToken: "",
    },
    workbuddy_ai: {
      chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
      // 官方国际客户端现行对话路径（优先），404/405 时回退上方 /v2（实测）
      consoleChatUrl: "https://www.workbuddy.ai/console/chat/completions",
      billingBase: "https://www.workbuddy.ai",
      origin: "https://www.workbuddy.ai",
      clientVersion: "5.5.4",
      cliVersion: "2.137.1",
      // 平台段必须 WorkBuddy AI，送错触发 403 code 11140 request illegal
      userAgent: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      billingUA: "WorkBuddy/5.5.4",
      ideName: "WorkBuddy",
      modelsUrl: "https://www.workbuddy.ai/console/enterprises/personal/models",
      modelsV3Url: "https://www.workbuddy.ai/v3/config",
      catalogUA: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      pluginBase: "https://www.workbuddy.ai",
      refreshSource: "plugin",
      deviceToken: "",
    },
    // ===== Cline 双池（cline_free / cline_pass 共用同一段）=====
    // 同域同协议同伪装头（api.cline.bot），两池只差「收哪个池的模型」，配置无需拆两份。
    // 协议事实（2026-09 实测 + 复核）：
    // ① LLM 端点是 POST {apiBase}/chat/completions（完整路径 /api/v1/chat/completions，
    //    路径只有一个 v1，发成 /api/v1/v1/... 是 404 Not Found）；
    // ② X-CLIENT-TYPE: cline-sdk 是免费池硬门槛（缺它免费池一律 403
    //    only available via Cline product surfaces；cline-cli 会走另一条兼容路径回 500）；
    // ③ 鉴权 Authorization: Bearer workos:<JWT>，workos: 前缀必须原样带（去掉 401）；
    // ④ 伪装头取自官方 CLI 通信实测（User-Agent 非必需，带上更贴近官方客户端，无代价）。
    cline: {
      apiBase: "https://api.cline.bot/api/v1",
      // 模型目录（GET，无需鉴权实测）：一次返回 recommended/free/clinePass/clineCloud 四组
      modelsPath: "/ai/cline/recommended-models",
      // 登录第四步：WorkOS 令牌 → Cline 会话令牌（不能省，WorkOS 给的是身份令牌）
      registerPath: "/auth/register",
      refreshPath: "/auth/refresh",
      // WorkOS 设备授权端点（RFC 8628）
      workosBase: "https://api.workos.com",
      workosClientId: "client_01K3A541FN8TA3EPPHTD2325AR",
      workosDevicePath: "/user_management/authorize/device",
      workosTokenPath: "/user_management/authenticate",
      // 设备授权页兜底（正常情况用上游返回的 verification_uri）
      deviceVerifyFallback: "https://authkit.cline.bot/device",
      // 伪装头（默认值；逐键可覆盖，空串=该头不发）
      upstreamHeaders: {
        "User-Agent": "Cline/3.0.62",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline",
        "X-IS-MULTIROOT": "false",
        "X-CLIENT-TYPE": "cline-sdk",
        "X-CLIENT-VERSION": "3.0.62",
        "X-PLATFORM": "terminal",
        "X-PLATFORM-VERSION": "3.0.62",
        "X-CORE-VERSION": "0.0.70",
      },
      requestTimeoutMs: 0,
    },
    // ===== 商汤小浣熊（Raccoon AI 桌面端）=====
    // 协议事实见 docs/raccoon-反代/会话1~5（静态逆向）。防伪强度低：无签名/无 HMAC/无 pinning。
    // 鉴权 = JWT Bearer + x-client-* 六头 + 受信设备绑定（纯对话/积分调用不触发绑定，仅移动端连接器链路用）。
    raccoon: {
      // LLM 对话域（纯 OpenAI Chat Completions，SSE；上游疑似 LiteLLM 网关，1:1 透传）
      chatUrl: "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions",
      // 模型目录（渲染层 GET /model_catalog，返回 {default_model, models[]}）
      modelsUrl: "https://xiaohuanxiong.com/api/web/llm/v2/model_catalog",
      defaultModel: "raccoon-chat-ml-5-5",
      // 积分/配额/账号域（渲染层 fetchWithAuth，统一 {code,data} 信封）
      balanceUrl: "https://xiaohuanxiong.com/api/web/points/v1/balance",
      settingUrl: "https://xiaohuanxiong.com/api/web/office/v3/setting_info",
      userInfoUrl: "https://xiaohuanxiong.com/api/web/auth/v1/user_info",
      grantUrl: "https://xiaohuanxiong.com/api/web/desktop/v1/login/points/grant",
      // 首次手机端登录奖励端点（一次性新手福利，与 desktop 端点互不共享额度、各领一次；
      // 身份头报 app-android，同一把 Bearer token——从官方安卓包逆向实测）
      mobileGrantUrl: "https://xiaohuanxiong.com/api/web/mobile/v1/login/points/grant",
      refreshUrl: "https://xiaohuanxiong.com/api/web/auth/v1/refresh",
      // x-client-* 六头取值（box-agent 链路 platform 带架构 `desktop-windows-x64`；
      // 浏览器/受信域 platform 不带架构，见 adapters.cjs raccoonIdentity/raccoonWebHeaders）
      clientName: "raccoon-ai",
      clientVersion: "1.0.35",
      webClientVersion: "v1.0.35",
      clientChannel: "official",
    },
    // ===== LobsterAI（网易有道龙虾）=====
    // 协议事实（2026-10-05 实测 + 交叉验证）：
    // 鉴权 = Bearer JWT（OAuth 授权码换发，回环回调 127.0.0.1/auth/callback）+ 设备 uuid + keyfrom 时间戳。
    // 关键约束：① 对话上游**只接受 stream=true**（非流式实测 500）；
    //          ② 签到活动按 clientVersion 门禁——旧版本号返回 slotState=empty（实测 0.1.0 被隐藏、
    //             2026.9.4+ 可见），故 versionUrl 动态取线上版本，取不到才回落 clientVersion；
    //          ③ 部分业务错误藏在 HTTP 200 的 SSE 流里（event:error 帧），chat 必须窥探首块。
    lobster: {
      // 对话域（原生 OpenAI Chat Completions，SSE；上游为龙虾自有网关）
      chatUrl: "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions",
      // 模型目录（GET，需 Bearer；返回 {code,data:[{modelId,modelName,provider,apiFormat,
      // supportsImage,supportsThinking,contextWindow,explicitContextCache,thinkingConfig}]}）
      modelsUrl: "https://lobsterai-server.youdao.com/api/models/available",
      // 模型目录·公开兜底（**无需鉴权**，官方文档 2026-08-27-more-models.md 明写 public）：
      // 含真实 contextWindow/supportsImage/costMultiplier/freeAccess + imageModels/videoModels。
      // 未登录或 Bearer 目录不可用时用它，保证模型清单与真实能力不依赖登录态
      pricingCatalogUrl: "https://lobsterai-server.youdao.com/api/models/pricing-catalog",
      // 积分余额（GET /api/user/profile-summary 的 totalCreditsRemaining；
      // 注意 /api/user/quota 只含 freeCreditsTotal=300，不含活动积分，故不用它）
      balanceUrl: "https://lobsterai-server.youdao.com/api/user/profile-summary",
      // 鉴权控制面（授权码换令牌 / 刷新令牌；两者都不需要 Bearer）
      exchangeUrl: "https://lobsterai-server.youdao.com/api/auth/exchange",
      refreshUrl: "https://lobsterai-server.youdao.com/api/auth/refresh",
      // 每日签到活动（client-activities 三段式：slot → context → actions/check_in）
      activitySlotUrl: "https://lobsterai-server.youdao.com/api/client-activities/slot",
      activityBaseUrl: "https://lobsterai-server.youdao.com/api/client-activities",
      // 签到活动所在位置槽（实测活动 activityCode=daily-check-in-evergreen-prod-20260814，
      // activityType=daily_check_in，rewardCredits=100，常驻至 2126 年）
      checkinPlacement: "desktop_sidebar",
      // 客户端版本号来源（签到活动按版本下发；官方更新接口实测返回 2026.9.23）
      versionUrl: "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update",
      // 登录门户（回环 OAuth 的授权页基址；getlobster.ai 的 DNS 已失效，实际门户在 youdao.com）
      loginPortal: "https://lobsterai.youdao.com",
      // 客户端版本兜底（versionUrl 不可用时用；低于 2026.9.4 会看不到签到活动）
      clientVersion: "2026.9.23",
      // 上报的客户端身份（UA = LobsterAI/<version>）
      clientName: "LobsterAI",
      // 客户端能力头（官方客户端实测值；缺了部分 agent 能力会被降级）
      clientCapabilities: "kimi-k3-agentic-v1",
    },
    // ===== ModelScope（魔搭 · 阿里）=====
    // 协议事实（2026-10-06 全量实测）：
    // ① 对话面 = 官方 OpenAI 兼容网关（api-inference.modelscope.cn/v1），原生支持
    //    stream / tool_calls / reasoning_content，无需签名、无需客户端（与其它渠道本质不同：
    //    这是**官方公开 API**，非逆向）。
    // ② 魔粒控制面 = www.modelscope.cn/openapi/v1/magicubes/*，鉴权是**三头同发**
    //    （Authorization: Bearer + OpenAPI-Token + X-Modelfun-Token）且必须带浏览器
    //    UA/Origin/Referer——缺头会被风控中间件静默忽略（实测）。
    // ③ 每日任务实测：daily_active +200/日、aliyun_bindlogin +50/日 为自动发放；
    //    interaction_like 收藏/喜欢 +2/次（上限 20 次/日）= +40/日 需主动 PUT 星标
    //    （PUT /api/v1/mcpServers/{path}/{name}/stars，实测 200 → 余额即时 +2）。
    // ④ 计费分档实测：交易记录带 model_tier，standard=1 魔粒/次、ultra=2 魔粒/次
    //    （不存在「一律 2/次」——早期口径只对旗舰档成立）。
    // ⑤ 模型清单 ≠ 全集：/v1/models 只收录按热度精选的模型（实测 35 个），
    //    GLM-5.3-Flash 不在清单内但直调 200 —— 验证可用性的 ground truth 是直调。
    modelscope: {
      // ===== 对话面（OpenAI 兼容） =====
      chatUrl: "https://api-inference.modelscope.cn/v1/chat/completions",
      modelsUrl: "https://api-inference.modelscope.cn/v1/models",
      // ===== 鉴权面（OAuth 2.0 + OIDC，2026-10-06 端到端实测） =====
      // 官方文档 https://modelscope.cn/docs/accounts/oauth；元数据 /.well-known/openid-configuration
      // 关键实测：① 动态注册（RFC 7591）POST /oauth/register 只需 client_name+redirect_uris
      //              即返回 client_id/client_secret，**无需鉴权** → AgentHub 可全自动注册
      //           ② access_token 前缀 ms_oauth、475 字符、有效期 30 天
      //           ③ refresh_token **一次性轮换**（用后失效）→ 续期成功必须立即持久化新 refresh
      //           ④ OAuth 错误以 **HTTP 200 + body.error** 返回（如 invalid_grant）
      //              → 判成败必须查 body.error，绝不能只看状态码
      //           ⑤ api-inference scope 实测可调推理（200 + 正常出流 + usage 正常）
      oauthAuthorizeUrl: "https://www.modelscope.cn/oauth/authorize",
      oauthTokenUrl: "https://www.modelscope.cn/oauth/token",
      oauthUserinfoUrl: "https://www.modelscope.cn/oauth/userinfo",
      oauthRegisterUrl: "https://www.modelscope.cn/oauth/register",
      oidcMetadataUrl: "https://modelscope.cn/.well-known/openid-configuration",
      // 申请 scope：openid 必选；profile 取用户信息；api-inference 是调用推理的授权
      oauthScopes: "openid profile api-inference",
      // 互联应用信息（动态注册所得）持久化在账号 meta 里，键名如下
      oauthMetaKeys: { clientId: "oauthClientId", clientSecret: "oauthClientSecret", refreshToken: "oauthRefreshToken" },
      // 令牌引导页（用户自建令牌入口；粘贴兜底路径的直达链接）
      tokenPageUrl: "https://modelscope.cn/my/myaccesstoken",
      // 令牌形态判别：OAuth access_token 以 ms_oauth 开头；用户自建令牌以 ms- 开头
      oauthTokenPrefix: "ms_oauth",
      // ===== 魔粒控制面 =====
      apiBase: "https://www.modelscope.cn",
      // ===== Cookie 通道（/api/v1 族专用，2026-10-06 实测确立）=====
      // 为什么必须用 Cookie：魔搭端点分两族，**严格互斥**（实测穷尽四条路径均不通）：
      //   「OAuth 可用族」推理 /v1/chat + 魔粒 /openapi/v1/magicubes/* + 身份 /oauth/userinfo
      //   「仅 Cookie/ms- 可用族」点赞 /api/v1/mcpServers/*/stars + 令牌管理 /api/v1/users/tokens*
      // 实测：OAuth 调点赞 → 401 "oauth token is not supported by this endpoint"
      //       （改请求头、找 openapi 替代、扩 scope、动态注册声明权限，四条路全失败）
      // 而 ms- 令牌虽能点赞，但不触发 daily_active —— 实测注释：
      //   「Bearer Token 虽能通过 OpenAPI 鉴权，但 OpenAPI 调用不计入日活，daily_active
      //     每日魔粒不会发放；只有 Web 会话（Cookie）活动才触发奖励」
      // ⇒ Cookie 是唯一同时覆盖「点赞」与「日活」的凭据。
      // 做法：OAuth 授权时在应用内窗口捕获 Web Cookie（用户零额外操作）。
      cookieTouchPaths: ["/my/overview", "/", "/home", "/models", "/datasets", "/my/tasks"],
      // 前端每次加载都会调的两个登录事件端点（HAR 抓包确认）——
      // daily_active 即「注册并登陆，每日登录即可获取」，必须补这两下触碰
      cookieLoginEventPaths: ["/api/v1/users/login/info", "/api/v1/users/authorized/check"],
      // 魔粒激活用的 openapi 轻量端点（Cookie 亦可调，作为日活信号补充）
      cookieOpenapiPaths: [
        "/openapi/v1/magicubes/earn/rules",
        "/openapi/v1/magicubes/balance",
        "/openapi/v1/models?page_number=1&page_size=10",
        "/openapi/v1/datasets?page_number=1&page_size=10",
      ],
      // Cookie 过滤域名（只存魔搭自己的，不存第三方）
      cookieDomains: ["modelscope.cn"],
      // 账号 meta 里存 Cookie 的键名
      cookieMetaKey: "msCookie",
      // Cookie 失效判定（上游对未登录返回的业务码/文案）
      cookieDeadRe: "InvalidAuthentication|user not logged in|not logged in|登录已过期|禁止访问",
      balancePath: "/openapi/v1/magicubes/balance",
      earnRulesPath: "/openapi/v1/magicubes/earn/rules",
      transactionsPath: "/openapi/v1/magicubes/transactions",
      // 身份端点（uid 来源：OAuth 用 userinfo.sub；令牌用 users/me.username）
      userInfoPath: "/openapi/v1/users/me",
      // 点赞任务：列 MCP 服务（PUT + 分页体）→ 逐个 PUT 星标
      mcpServersPath: "/api/v1/dolphin/mcpServers",
      starPathPrefix: "/api/v1/mcpServers",
      // 每日任务规则键（实测值，非猜测）
      ruleDailyActive: "daily_active",
      ruleAliyunBind: "aliyun_bindlogin",
      ruleLike: "interaction_like",
      // 点赞目标分页大小（实测 30 可一次拿够 20 个未星标目标）
      mcpPageSize: 30,
      // 列表响应给 Data.McpServer.TotalCount；按总数动态翻页，但保留扫描安全阀，
      // 避免上游总数异常时无限请求。实测热门排序前 3 页可能全部 AlreadyStar=true。
      mcpMaxScanPages: 20,
      // 必须带浏览器上下文，否则风控中间件忽略请求（实测）
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      refererPath: "/my/overview",
      // 点赞间隔（ms）：避免高频被风控，取 400-900ms 更保守
      likeDelayMinMs: 400,
      likeDelayMaxMs: 900,
      // 单轮点赞上限（安全阀：即使上游 daily_cap 异常放大也不超此值）
      likeHardCap: 25,
    },
    // ===== ZCode（智谱 GLM 编码套餐）=====
    // 协议事实：上游是 Anthropic Messages（coding-plan 与 start-plan 统一）；
    // 头组复刻官方 3.12.3 客户端（LLM 面带 X-ZCode-Agent、不带 X-Device-Mid；
    // billing/claim 控制面反之）。appVersion 上游变更时改这里即热生效，无需发版。
    zcode: {
      appVersion: "4.1.10",
      sourceTitle: "cli",
      refererOrigin: "https://zcode.z.ai",
      // coding-plan（付费套餐，凭据 = coding-plan API key "{apiKey}.{secret}"）
      zaiAnthropicBase: "https://api.z.ai/api/anthropic",
      bigmodelAnthropicBase: "https://open.bigmodel.cn/api/anthropic",
      // start-plan（免费/领取的套餐，凭据 = zcodejwttoken）
      startPlanAnthropicBase: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      // billing / claim / OAuth 控制面
      billingBase: "https://zcode.z.ai/api/v1/zcode-plan",
      clientConfigsUrl: "https://zcode.z.ai/api/v1/client/configs",
      eventReportUrl: "https://zcode.z.ai/api/v1/event/report",
      oauthInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
      oauthPollBase: "https://zcode.z.ai/api/v1/oauth/cli/poll",
      oauthTokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
      businessLoginUrl: "https://api.z.ai/api/auth/z/login",
      // zai 业务域（coding-plan API key 解析链：getCustomerInfo / api_keys）
      zaiBizBase: "https://api.z.ai",
      bigmodelBizBase: "https://bigmodel.cn",
      // bigmodel 额度查询（coding-plan API key 路）
      monitorQuotaUrl: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      subscriptionUrl: "https://open.bigmodel.cn/api/biz/subscription/list",
      // OAuth 登录的 provider（zai / bigmodel）
      oauthProvider: "zai",
      // 平台标识（billing/claim 查询参数 platform 的值）
      platform: "win32-x64",
    },
    // ===== Qoder 双区 =====
    // 端点与版本常量放配置（热加载）：客户端升级后只需改 cosyVersion，无需改代码。
    // 实测签名对版本串宽容（0.4.2 ~ 9.9.9 均通过），此值仅用于对齐客户端指纹。
    // 账号与额度池两区互不相通（CN/INTL 各一套账号体系），故各自独立配置。
    qoder: {
      gateway: "https://gateway.qoder.com.cn",
      openApi: "https://openapi.qoder.com.cn",
      // 额度查询域（实测两区不同：CN 走 gateway 亦可，INTL 只在 openapi）
      quotaBase: "https://gateway.qoder.com.cn",
      // 推理端点基址（wasm 会补 ?FetchKeys=…&AgentId=…&Encode=1）
      inferPath: "/algo/api/v2/service/pro/sse/agent_chat_generation",
      quotaPath: "/api/v2/quota/usage",
      refreshPath: "/api/v1/deviceToken/refresh",
      userAgent: "qoder/0.4.3",
      cosyVersion: "0.4.3",
    },
    qoder_intl: {
      gateway: "https://api2.qoder.sh",
      openApi: "https://openapi.qoder.sh",
      // ⚠ INTL 的额度端点在 openapi（gateway 返回 404，实测）
      quotaBase: "https://openapi.qoder.sh",
      inferPath: "/algo/api/v2/service/pro/sse/agent_chat_generation",
      quotaPath: "/api/v2/quota/usage",
      refreshPath: "/api/v1/deviceToken/refresh",
      userAgent: "qoder/0.4.3",
      cosyVersion: "0.4.3",
    },
    // ===== CatPaw（美团）=====
    // 有状态会话协议（round → event(running) → turn(SSE) → 工具循环 → event(completed)）。
    // 客户端身份常量（toolVersion / agentVersion / appKey / source / mode）**必须与真实客户端保持一致**，
    // 上游按它们解释请求语义与工具形态；客户端升级后改这里即热生效，无需发版。
    // permissionMode 是本家固定的绕过权限档（写死在请求体里）。
    catpaw: {
      baseUrl: "https://ai.catpaw.meituan.com",
      source: "CatX",
      mode: "CATX_APP",
      toolVersion: "2.0.2",
      agentVersion: "1.0.1",
      appKey: "fe_com.sankuai.catpaw.external.front",
      permissionMode: "unsafeBypassPermissions",
      // 超时三分档：短请求（round/event/stop，30s/3s）、turn 的 SSE 总预算（15min）
      requestTimeoutMs: 30000,
      stopTimeoutMs: 3000,
      sseTimeoutMs: 900000,
    },
    // ===== AutoClaw 双区（国内版 / 国际版）=====
    // 两地同协议同签名指纹（appId/appKey 逐字相同），仅 userapiBase 与订阅端点不同。
    // 两域版本号**不同**（实测）：llmVersion 进对话头 X-Version；apiVersion 进 userapi 域
    // X-Version 且是版本门控——不带它时模型目录只下发部分条目。客户端升级后改这里即热生效。
    // X-Auth-Sign 仅 userapi 域发：MD5(`${authAppId}&${秒级时间戳}&${authAppKey}`) 小写十六进制。
    autoclaw: {
      userapiBase: "https://autoglm-acceleration-api.zhipuai.cn",
      llmProxyPath: "/autoclaw-proxy/proxy/autoclaw",
      authAppId: "100003",
      authAppKey: "38d2391985e2369a5fb8227d8e6cd5e5",
      llmVersion: "1.17.8",
      apiVersion: "1.18.5",
      catalogPath: "/autoclaw-proxy/proxy/autoclaw-model-config",
      taskCompletePath: "/autoclaw-proxy/proxy/autoclaw-task-complete",
      taskListPath: "/autoclaw-proxy/proxy/autoclaw-task-list",
      refreshPath: "/userapi/v1/refresh",
      refreshFallbackPath: "/userapi/v1/agent-refresh",
      sendCodePath: "/userapi/v1/agent-send-code",
      // 结尾斜杠是上游要求的（带不带斜杠是两个路由）
      loginPath: "/userapi/v1/agent-login/",
      userProfilePath: "/userapi/v1/user-profile",
      // 客户端启动同款的「登录」端点：活动福利（Weekly Perks / 登录奖励）没有领取接口，
      // 服务端把发放判据挂在这个动作上（签到后触发，见 autoclaw/checkin.cjs）
      userInfoPath: "/userapi/v1/user-info",
      walletsPath: "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
      walletInstancesPath: "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all",
      pointsExpiringPath: "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw",
      // 订阅端点两区不同（实测）：国内 subscribe-info / 国际 oversea-subscribe-info
      subscribePath: "/agentpay/v1/assistant/subscribe-info",
      oauthCaptchaConfigPath: "/userapi/overseasv1/oauth-captcha-config",
      oauthUrlPath: "/userapi/overseasv1/zai-oauth-url",
      oauthLoginPath: "/userapi/overseasv1/zai-oauth-login",
      // Google 变体（国际版第二登录方式；回调端口按 RFC 8252 loopback 宽松匹配，端口任意）
      oauthGoogleUrlPath: "/userapi/overseasv1/google-oauth-url",
      oauthGoogleLoginPath: "/userapi/overseasv1/google-oauth-login",
    },
    autoclaw_intl: {
      userapiBase: "https://autoglm-api.autoglm.ai",
      llmProxyPath: "/autoclaw-proxy/proxy/autoclaw",
      authAppId: "100003",
      authAppKey: "38d2391985e2369a5fb8227d8e6cd5e5",
      llmVersion: "1.17.8",
      apiVersion: "1.18.5",
      catalogPath: "/autoclaw-proxy/proxy/autoclaw-model-config",
      taskCompletePath: "/autoclaw-proxy/proxy/autoclaw-task-complete",
      taskListPath: "/autoclaw-proxy/proxy/autoclaw-task-list",
      refreshPath: "/userapi/v1/refresh",
      refreshFallbackPath: "/userapi/v1/agent-refresh",
      sendCodePath: "/userapi/v1/agent-send-code",
      loginPath: "/userapi/v1/agent-login/",
      userProfilePath: "/userapi/v1/user-profile",
      // 客户端启动同款的「登录」端点：活动福利（Weekly Perks / 登录奖励）没有领取接口，
      // 服务端把发放判据挂在这个动作上（签到后触发，见 autoclaw/checkin.cjs）
      userInfoPath: "/userapi/v1/user-info",
      walletsPath: "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
      walletInstancesPath: "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all",
      pointsExpiringPath: "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw",
      subscribePath: "/agentpay/v1/assistant/oversea-subscribe-info",
      oauthCaptchaConfigPath: "/userapi/overseasv1/oauth-captcha-config",
      oauthUrlPath: "/userapi/overseasv1/zai-oauth-url",
      oauthLoginPath: "/userapi/overseasv1/zai-oauth-login",
      // Google 变体（国际版第二登录方式；回调端口按 RFC 8252 loopback 宽松匹配，端口任意）
      oauthGoogleUrlPath: "/userapi/overseasv1/google-oauth-url",
      oauthGoogleLoginPath: "/userapi/overseasv1/google-oauth-login",
    },
    // Accio 双区（国际版 / 国内版）：同网关，差别只在 x-package-region 与登录站点。
    // token 不走 Authorization 头（GET 拼 query / POST 放 body / 推理放 body），见 accio/auth.cjs。
    accio: {
      gatewayBase: "https://phoenix-gw.alibaba.com",
      llmBase: "https://phoenix-gw.alibaba.com/api/adk/llm",
    },
    accio_cn: {
      gatewayBase: "https://phoenix-gw.alibaba.com",
      llmBase: "https://phoenix-gw.alibaba.com/api/adk/llm",
    },
    // CodeArts（华为云）：SDK-HMAC-SHA256 签名 + DPoP + 有状态会话（每账号 3 路并发）。
    // base 域与 token 签发地必须同为 cn-north-4；临时凭据到期前 15 分钟续。见 codearts/。
    codearts: {
      base: "https://snap-access.cn-north-4.myhuaweicloud.com",
      tokenUrl: "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens",
      identityUrl: "https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity",
      webLoginBase: "https://codearts.huaweicloud.com",
      chatPath: "/api/v2/chat/completions",
      region: "cn-north-4",
      pluginName: "snap_vscode",
      pluginVersion: "26.9.101",
      language: "en-us",
      sessionConcurrency: 3,
      refreshMarginMs: 900000,
    },
    // Loomy（讯飞）：无状态 OpenAI 兼容，签名只用于账号域（短信登录），转发走 token + Bearer 双头。
    loomy: {
      xfyunBase: "https://account.xfinfr.com",
      integrationBase: "https://loomyad.xunfei.cn",
      modelBase: "https://loomyad.xunfei.cn/api/v1",
    },
    // ===== MonkeyCode 双站（国内版 / 国际版）=====
    // 站点身份（域名、Cookie 名、ACP 事件词表）不属于可配置项，唯一事实源在 monkeycode/region.cjs
    // 与 monkeycode/endpoints.cjs。这里给的是**部署相关**覆盖入口：
    //   baseUrl      自建 / 私有云站点改这里（Origin/Referer 仍按站点真身发，那是上游的来源判定）
    //   hostId       公共宿主固定 public_host；自建站点的宿主名不同
    //   streamIdleMs 任务流空闲判定（下限 30 秒）
    monkeycode: {},
    monkeycode_intl: {},
  },
};

const DESC = {
  "model_map.json": "Trae 模型映射（显示名 → config_name/model_name）",
  "catalog.json": "模型权威目录（拉取模型写回：倍率/能力/上下文，可手编）",
  "wb_template_map.json": "WorkBuddy 审核模板最小改写表",
  "headers.json": "渠道默认头 / UA / 上游域",
};

const cache = new Map(); // file -> { data, error }
let watcher = null;

function rulesDir() {
  const d = path.join(store.proxyDir(), "rules");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 只补内置默认里存在、用户文件里缺失的键（递归）；已有值一律不动，用户改动不会被覆盖 */
function mergeMissing(target, defaults) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return target;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target) || target[k] === undefined) {
      target[k] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      mergeMissing(target[k], v);
    }
  }
  return target;
}

/** rules/ 目录启动准备：只有模型目录（catalog.json）落盘——它保存「拉取模型」的结果，要跨启动留存；
 *  其余规则只认代码里的内置默认（DEFAULTS），启动时把历史上写到磁盘的那几份清掉：
 *  旧文件会盖住代码默认值，导致「改代码不生效」（这些规则文件不再对外暴露）。 */
let ensuredOnce = false;
function ensureFiles() {
  // 只在进程首次准备时清理一次：之后 init 可能被反复调用（如 list() / 各页面），
  // 再删就会把运行期写下的文件清掉
  if (ensuredOnce) return;
  ensuredOnce = true;
  const dir = rulesDir();
  for (const [file, data] of Object.entries(DEFAULTS)) {
    const p = path.join(dir, file);
    if (file !== "catalog.json") {
      try {
        fs.rmSync(p, { force: true });
      } catch { /* 删不掉就留着（不影响启动，下次再试） */ }
      continue;
    }
    if (!fs.existsSync(p)) {
      try {
        fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      } catch { /* 写不进去就用内存默认值 */ }
      continue;
    }
    // 目录文件存在：只补内置里新增、文件里缺的键（拉取写入的条目一律不动）
    try {
      const cur = JSON.parse(fs.readFileSync(p, "utf8"));
      const before = JSON.stringify(cur);
      mergeMissing(cur, data);
      if (JSON.stringify(cur) !== before) fs.writeFileSync(p, JSON.stringify(cur, null, 2), "utf8");
    } catch { /* 文件坏了留给 loadFile 报错并回退内置默认 */ }
  }
}

function loadFile(file) {
  const p = path.join(rulesDir(), file);
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    cache.set(file, { data, error: "" });
  } catch (e) {
    // 文件不存在（未落盘的规则：headers/model_map/wb_template_map）不算错误，直接用内置默认；
    // 坏 JSON 才保留上次快照并报错（错误交给面板警示）
    const prev = cache.get(file);
    const missing = !!(e && e.code === "ENOENT");
    cache.set(file, { data: prev ? prev.data : DEFAULTS[file], error: missing ? "" : String((e && e.message) || e) });
  }
}

/** 启动加载 + chokidar 热重载（chokidar 不可用时退回 fs.watch，仍保持热加载能力） */
function init() {
  ensureFiles();
  for (const file of Object.keys(DEFAULTS)) loadFile(file);
  if (watcher) return;
  const dir = rulesDir();
  const onChange = (file) => {
    if (file && DEFAULTS[file]) loadFile(file);
  };
  try {
    const chokidar = require("chokidar");
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
    watcher.on("change", (p) => onChange(path.basename(p)));
    watcher.on("add", (p) => onChange(path.basename(p)));
    // 删除也要生效：不监听 unlink 时用户删了文件内存缓存永不失效，继续用旧值直到重启
    watcher.on("unlink", (p) => {
      const f = path.basename(p);
      if (f && DEFAULTS[f]) cache.delete(f); // 清缓存，下次读取回退内置默认值
    });
  } catch {
    try {
      fs.watch(dir, (_ev, file) => onChange(file));
    } catch { /* 热加载不可用时静默，重启仍生效 */ }
  }
}

/** 取规则数据（永远有值：文件 → 上次快照 → 内置默认） */
function get(file) {
  const hit = cache.get(file);
  if (hit) return hit.data;
  return DEFAULTS[file];
}

/** 立即重载单个规则文件（chokidar 事件是异步的，测试等需要确定性重载的场景用） */
function reload(file) {
  if (DEFAULTS[file]) loadFile(file);
}

/** 面板规则文件表：说明 / 大小 / mtime / 状态 */
function list() {
  init();
  const dir = rulesDir();
  return Object.keys(DEFAULTS).map((file) => {
    const p = path.join(dir, file);
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(p);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch { /* 文件缺失也列出（用内置默认） */ }
    const err = (cache.get(file) || {}).error || "";
    return { file, desc: DESC[file] || "", size, mtimeMs, ok: !err, error: err };
  });
}

module.exports = { init, get, list, reload, rulesDir, DEFAULTS };
