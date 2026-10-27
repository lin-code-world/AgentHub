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
// Web 托管形态的传输层：浏览器里同源调 POST /api/rpc（ECDH 会话加密通道，协议见 adminCrypto.ts）。
// 与桌面 IPC 同契约（{cmd,args} → {ok,...} 数据 / {ok:false,message} 错误），
// 超时看门狗由 ipc.ts 的 call() 统一维护，这里只负责传输；登录态与会话失效收口在 adminCrypto.ts。
import { request } from "./adminCrypto";

export async function webInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return request(cmd, args);
}
