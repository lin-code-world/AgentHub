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
// Web 托管形态的事件订阅：fetch 流而非 EventSource（鉴权 nonce 一次性，断线必须重新签名，Ruling 18 禁止 EventSource）。
// 信封与桌面 IPC 的 app:event 完全同形（{event:"proxy", ...}），订阅方消费逻辑两种形态共用。
// 每帧 {seq, iv, ciphertext} 用 K_resp 解密，seq 连接内从 1 起（Ruling 19）：每次连接（含重连）新建解码器，基线清零。
// 断线自动重连（1s 起指数退避到 30s，连上后复位）；401 / 校验失败清会话回登录页，不再重连。
import { createEventFrameDecoder, eventsUrl, handleAuthLost, hasSession, httpFetch } from "./adminCrypto";

export function subscribeWebEvents(cb: (payload: unknown) => void): () => void {
  let closed = false;
  let ctl: AbortController | null = null;
  let retryMs = 1000;

  const connect = async () => {
    if (closed) return;
    ctl = new AbortController();
    const decode = createEventFrameDecoder(); // 重连后 seq 基线清零（跨连接沿用会把重连首帧误判成跳帧）
    try {
      const res = await httpFetch(await eventsUrl(), { signal: ctl.signal });
      if (res.status === 401) handleAuthLost(); // 会话已失效：清会话回登录页（抛错落到下面 catch，不再重连）
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      retryMs = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue; // ": ka" 心跳等注释行跳过
            let frameObj: { iv?: string; ciphertext?: string } | null = null;
            try {
              frameObj = JSON.parse(line.slice(5).trim());
            } catch {
              continue; // 坏帧忽略
            }
            if (!frameObj) continue;
            const plain = await decode(frameObj);
            if (plain === null) throw new Error("SSE 帧校验失败"); // 跳帧 / 重放 / 篡改：断开重连（重连后基线清零）
            cb(plain);
          }
        }
      }
    } catch {
      /* 网络中断 / 服务重启 / 帧校验失败：走下面的重试 */
    }
    if (closed || !hasSession()) return; // 会话已失效（401 等）：跳登录页，不再重连
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
  void connect();

  return () => {
    closed = true;
    try {
      ctl?.abort();
    } catch {
      /* 已中断 */
    }
  };
}
