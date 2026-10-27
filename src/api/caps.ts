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
// 服务端能力清单（Web 托管形态的单一事实源）：
//   - 判定"这是网关托管的 Web UI 还是纯前端预览（dev:web）"——前者走 RPC，后者走 mock
//   - 板块裁剪：只渲染服务端声明支持的模块（容器形态只有 proxy）
//   - 命令门控：deny 命令在 call() 层统一拦下，文案由服务端下发（前端不重复维护）
export type CommandMode = "read" | "write" | "deny";
/** 服务端形态：容器管理面（Bearer + 明文） / 桌面局域网控制台（ECDH + 密文） */
export type WebForm = "browser" | "container";

export interface CommandCaps {
  mode: CommandMode;
  reason?: string;
}

export interface Caps {
  platform: string;
  version: string;
  /** 形态分流（Ruling 36）：container = 容器管理面（Bearer + 明文 RPC/SSE）；
   *  browser = 桌面局域网控制台（ECDH 会话 + 密文）。缺省按 browser 处理（兼容未升级的后端） */
  form?: WebForm;
  modules: string[];
  features: Record<string, boolean>;
  commands: Record<string, CommandCaps>;
}

let caps: Caps | null = null;

export function isWebTransport(): boolean {
  return caps !== null;
}

/** 当前 Web 托管形态；桌面窗口（无 caps）为 null */
export function webForm(): WebForm | null {
  if (!caps) return null;
  return caps.form === "container" ? "container" : "browser";
}

/** 容器形态（Bearer + 明文）：传输层与登录方式都走旧实现，桌面局域网控制台走 ECDH 密文 */
export function isContainerWeb(): boolean {
  return caps?.form === "container";
}

/** 全局设置弹窗在 Web 托管形态不可用：通用 / 刷新周期都依赖整份配置读写
 *  （load_config / save_config 在 browser 形态被 deny，容器命令表只有 proxy_*），
 *  界面拿不到真值，展示的只会是前端默认值。入口由调用方整块隐藏，不逐控件置灰 */
export function settingsUnavailable(): boolean {
  return caps !== null;
}

/** 探测网关托管形态：3 秒超时；纯静态预览（无后端）或接口不可用时返回 null 走 mock */
export async function probeCaps(): Promise<Caps | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch("/api/capabilities", { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<Caps> & { ok?: boolean };
    if (!data || data.ok !== true || !Array.isArray(data.modules) || !data.commands) return null;
    caps = data as Caps;
    return caps;
  } catch {
    return null; // 非 JSON / 网络失败：按"无后端"处理
  }
}

export function moduleEnabled(key: string): boolean {
  return !caps || caps.modules.includes(key);
}

/** 命令模式：desktop（无 caps）返回 undefined，容器按服务端声明返回 read/write/deny */
export function commandMode(cmd: string): CommandMode | undefined {
  return caps?.commands[cmd]?.mode;
}

/** deny 命令的拦截文案：命中返回原因（调用层直接抛），未命中返回 null */
export function denyReason(cmd: string): string | null {
  const c = caps?.commands[cmd];
  return c && c.mode === "deny" ? c.reason || "该操作在容器形态不可用" : null;
}

/** 按钮门控（置灰 + 原因展示）：任一命令被服务端 deny 即 disabled，reason 原样取服务端下发文案（前端不另写）。
 *  桌面窗口（无 caps）恒为可用——deny 只针对浏览器管理页，桌面行为不变。
 *  一个按钮覆盖多条命令时（如「打开登录页」含 begin 与回调收尾）并列传入，命中第一条就停 */
export function denyState(...cmds: string[]): { disabled: boolean; reason: string | null } {
  for (const cmd of cmds) {
    const reason = denyReason(cmd);
    if (reason) return { disabled: true, reason };
  }
  return { disabled: false, reason: null };
}
