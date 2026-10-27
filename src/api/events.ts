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
// Web 托管形态的事件订阅：fetch 流而非 EventSource（鉴权要么是签名 nonce 要么是 Bearer 头，
// 原生 EventSource 都带不了，Ruling 18 禁止）。
// 信封与桌面 IPC 的 app:event 完全同形（{event:"proxy", ...}），订阅方消费逻辑两种形态共用。
//
// 形态分流（Ruling 36）：
//  · container（gateway/src/index.cjs）：Bearer + 明文帧（服务端直接 JSON.stringify）。
//  · browser（electron/backend/admin.cjs）：每帧 {seq, iv, ciphertext} 用 K_resp 解密，seq 连接内从 1 起
//    （Ruling 19）：每次连接（含重连）新建解码器，基线清零。
// 断线自动重连（1s 起指数退避到 30s，连上后复位）；401 / 校验失败清会话回登录页，不再重连。
// 连接状态经 onWebEventState 广播（I6 断线横幅）；重连成功补发一条 {type:"resync"}，
// 让各页用一次全量刷新补上断线期间漏掉的事件。
import { createEventFrameDecoder, eventsUrl, handleAuthLost, hasSession, httpFetch } from "./adminCrypto";
import { isContainerWeb } from "./caps";
import { getToken, handleContainerAuthLost } from "./web-transport";

/** 连接状态：connected = 流已打开；reconnecting = 断了正在退避重连；lost = 会话失效不再重连 */
export type WebEventState = "connected" | "reconnecting" | "lost";

const stateListeners = new Set<(s: WebEventState) => void>();
let lastState: WebEventState = "connected";

/** 当前连接状态（供页面挂载时取初值） */
export function webEventState(): WebEventState {
  return lastState;
}

/** 订阅连接状态（I6）：返回退订函数；订阅时立即回调一次当前状态 */
export function onWebEventState(cb: (s: WebEventState) => void): () => void {
  stateListeners.add(cb);
  try {
    cb(lastState);
  } catch {
    /* 订阅方异常不影响其它订阅者 */
  }
  return () => stateListeners.delete(cb);
}

function setState(s: WebEventState): void {
  lastState = s;
  for (const fn of [...stateListeners]) {
    try {
      fn(s);
    } catch {
      /* 同上 */
    }
  }
}

export function subscribeWebEvents(cb: (payload: unknown) => void): () => void {
  const container = isContainerWeb();
  let closed = false;
  let ctl: AbortController | null = null;
  let retryMs = 1000;
  let authLost = false;
  let connectedOnce = false; // 首次连上不算「恢复」，只有重连成功才补发 resync

  const connect = async () => {
    if (closed) return;
    ctl = new AbortController();
    // 桌面形态：重连后 seq 基线清零（跨连接沿用会把重连首帧误判成跳帧）
    const decode = container ? null : createEventFrameDecoder();
    try {
      let res: Response;
      if (container) {
        const token = getToken();
        res = await fetch("/api/events", { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
        if (res.status === 401) {
          authLost = true;
          handleContainerAuthLost();
        }
      } else {
        res = await httpFetch(await eventsUrl(), { signal: ctl.signal });
        if (res.status === 401) {
          authLost = true;
          handleAuthLost(); // 会话已失效：清会话回登录页（抛错落到下面 catch，不再重连）
        }
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      retryMs = 1000;
      setState("connected");
      if (connectedOnce) {
        try {
          cb({ event: "proxy", type: "resync" }); // 断线期间漏掉的事件用一次全量刷新补上
        } catch {
          /* 订阅方异常不打断流 */
        }
      }
      connectedOnce = true;
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
            let payload: unknown = null;
            if (container) {
              try {
                payload = JSON.parse(line.slice(5).trim());
              } catch {
                continue; // 坏帧忽略
              }
            } else {
              let frameObj: { iv?: string; ciphertext?: string } | null = null;
              try {
                frameObj = JSON.parse(line.slice(5).trim());
              } catch {
                continue; // 坏帧忽略
              }
              if (!frameObj) continue;
              payload = await decode!(frameObj);
              if (payload === null) throw new Error("SSE 帧校验失败"); // 跳帧 / 重放 / 篡改：断开重连（基线清零）
            }
            if (payload) cb(payload);
          }
        }
      }
    } catch {
      /* 网络中断 / 服务重启 / 帧校验失败：走下面的重试 */
    }
    if (closed) return;
    // 会话已失效（401 等）：跳登录页，不再重连
    if (authLost || (container ? !getToken() : !hasSession())) {
      setState("lost");
      return;
    }
    setState("reconnecting");
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
