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
// Web 托管形态的传输层：浏览器里同源调 POST /api/rpc。
// 与桌面 IPC 同契约（{cmd,args} → {ok,...} 数据 / {ok:false,message} 错误），
// 超时看门狗由 ipc.ts 的 call() 统一维护，这里只负责传输与登录态。
//
// 形态分流（Ruling 36）：两套管理面实现并存，前端按服务端 capabilities 的 form 选通道：
//  · container（gateway/src/index.cjs）：Bearer + 明文 JSON。登录 = 带令牌打一次 /api/status 验证，
//    令牌留在 localStorage（容器没有会话密钥，每次请求都带它）。
//  · browser（electron/backend/admin.cjs，桌面局域网控制台）：ECDH 会话 + 签名密文，见 adminCrypto.ts，
//    令牌只在登录瞬间参与密钥派生，用完即丢。
import { isContainerWeb } from "./caps";
import { request } from "./adminCrypto";

const TOKEN_KEY = "agenthub.adminToken";

/** 容器形态的管理令牌（桌面浏览器形态不用它） */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // 隐私模式下 localStorage 不可用：本次会话内可用，刷新后需重登
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 同上 */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

let authLostReloading = false;
/** 令牌失效：清掉并回登录页。并发请求会同时撞 401，用一次性闸防重复 reload */
export function handleContainerAuthLost(): never {
  clearToken();
  if (!authLostReloading) {
    authLostReloading = true;
    if (typeof window !== "undefined" && window.location) window.location.reload();
  }
  throw new Error("登录已失效，请重新输入管理令牌");
}

/** 容器形态登录：带 Bearer 调一次 /api/status 验证令牌，成功后令牌留在本地（与旧版容器行为一致）。
 *  失败文案与桌面 ECDH 登录保持同款口径（不区分令牌错 / 服务不可用之外的细节） */
export async function loginWithToken(token: string): Promise<void> {
  const t = String(token || "").trim();
  if (!t) throw new Error("令牌不正确");
  let res: Response;
  try {
    res = await fetch("/api/status", { headers: { authorization: `Bearer ${t}` } });
  } catch (e) {
    throw new Error(`无法连接网关：${((e as Error) && (e as Error).message) || e}`);
  }
  if (res.status === 401) throw new Error("令牌不正确");
  if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}`);
  setToken(t);
}

/** 容器形态的明文 RPC：Bearer 头 + JSON 信封 */
async function bearerInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ cmd, args: args || {} }),
    });
  } catch (e) {
    throw new Error(`无法连接网关：${((e as Error) && (e as Error).message) || e}`); // 传输失败不跳登录页
  }
  if (res.status === 401) handleContainerAuthLost();
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error((data && data.message) || `命令 ${cmd} 执行失败（HTTP ${res.status}）`);
  return data;
}

export async function webInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (isContainerWeb()) return bearerInvoke(cmd, args);
  return request(cmd, args);
}
