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
// 反代网关 · MonkeyCode 任务流：WebSocket 会话 + ACP 事件 → OpenAI delta
//
// 三个决定这条链能不能用的点：
//   1. 连上之后**先发 auto-approve 再发 user-input**，顺序固定。缺 auto-approve，任务会停在第一个
//      工具调用上等一个永远不会来的确认；缺 user-input（mode=new 下必须由客户端先发），上游不开始执行。
//   2. Agent 提问（acp_ask_user_question）必须自动回一条 reply-question（空答案 + 不取消），
//      否则任务停在提问处。提问的 data 见过 JSON 串与 base64(JSON) 两种形态，两种都认。
//   3. 四个出口（task-ended / task-error / 连接断开 / 超时）每个都必须给下游收尾：客户端的 SSE
//      解析器等的是结束帧，只断连接会被渲染成「回答被截断」。
//
// 工具调用：ACP 的 tool_call 事件不带 id，所以这里按「call_<序号>_<任务 id>」合成，客户端才能做
// tool_use / tool_result 配对；tool_call_update 的 tool_input / delta 是**增量**，按增量下发，
// 同名工具取最近一个（早先的同名调用因此不再接收更新——这是上游事件不带调用 id 的必然结果）。
//
// 出网代理：与上游客户端形态一致，只有建任务那一次 HTTP 经过代理；任务流是 WebSocket，
// 直连。配了代理时留一条排障记录，免得误以为任务流也走了出口。
"use strict";

// WebSocket 用运行时全局：Electron 35 内置 Node 22 自带（与 undici 同源），
// 因此本渠道不引入额外依赖。全局 WebSocket 支持构造参数里的自定义 headers（Cookie 走它）。
const WebSocket = globalThis.WebSocket;

const endpoints = require("./endpoints.cjs");
const task = require("./task.cjs");

/** 任务流总时长上限：与建任务的 resource.life 同口径，别只改一边。
 *  3 小时是上游「公共主机」能申请的最大值时（task.go: `Life > 3*60*60` 直接拒绝建任务）。 */
const TASK_TOTAL_MS = 3 * 60 * 60 * 1000;
/** 空闲兜底下限：上游约每 10 秒推一条 ping，正常不会触达空闲判定 */
const IDLE_MIN_MS = 30000;

/** 帧数据可能是 string / ArrayBuffer / TypedArray / Blob，统一转文本（上游实际只发文本帧） */
async function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.array === "function") {
    const buf = await data.array();
    return Buffer.from(buf).toString("utf8");
  }
  return "";
}

/**
 * ACP → OpenAI delta 的翻译状态机（纯函数集，不碰网络）。
 * 产出的是 delta 对象与需要回给上游的帧，由驱动层分别走 emit / ws.send。
 */
class Translator {
  constructor(taskId, requestedModel) {
    // 下发给客户端的 model 用**客户端请求的那一个**，不是上游真名：统一名/别名映射由网关侧负责
    this.chatId = `chatcmpl-${taskId}`;
    this.model = String(requestedModel || "");
    this.content = "";
    this.reasoning = "";
    this.tools = [];
    this.lastToolIndex = null;
    this.finished = false;
  }

  toolId(index) {
    const base = this.chatId.startsWith("chatcmpl-") ? this.chatId.slice("chatcmpl-".length) : this.chatId;
    return `call_${index}_${base}`;
  }

  /** 正文/思考增量都在 update.content.text（content.type 为 "text"） */
  static contentText(update) {
    const c = update && update.content;
    if (!c || typeof c !== "object") return "";
    return typeof c.text === "string" ? c.text : "";
  }

  /** tool_input 是对象时按 JSON 串下发（上游给过对象形态，客户端要的是字符串参数） */
  static fieldText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  pushToolCall(update) {
    const index = this.tools.length;
    const id = String(update.toolCallId || "").trim() || this.toolId(index);
    const name = String(update.kind || update.title || "tool").trim() || "tool";
    const args = Translator.fieldText(update.rawInput);
    this.tools.push({ index, id, name, arguments: args });
    this.lastToolIndex = index;
    return { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] };
  }

  /** tool_call_update 的 rawInput/rawOutput 是**全量替换**（不是增量）：整份重发会和客户端已收到的参数重复，
   *  故只更新本地快照、不再下发（对纯对话客户端，工具调用属 agent 内部过程，正文才是它要的）。 */
  appendToolArguments(update) {
    if (this.lastToolIndex == null || !this.tools[this.lastToolIndex]) return null;
    const cur = this.tools[this.lastToolIndex];
    if (update && update.kind) cur.name = String(update.kind);
    cur.arguments = Translator.fieldText(update && (update.rawInput || update.rawOutput)) || cur.arguments;
    return null;
  }

  summary() {
    return `正文 ${this.content.length} 字、思考 ${this.reasoning.length} 字、工具 ${this.tools.length} 个`;
  }

  /**
   * 一条已解析的 ACP 事件 → { deltas: [] }。
   *
   * 实际结构是 `{ sessionId, update: { sessionUpdate, content: {type,text}, used, size, toolCallId… } }`：
   * 事件类型在 `update.sessionUpdate`（不是顶层的 `type`），正文在 `update.content.text`——顶层的
   * `type/kind/timestamp` 是外层信封（task-running 等），别拿它当事件类型。
   */
  handleAcp(acp) {
    const out = { deltas: [] };
    const update = acp && acp.update;
    if (!update || typeof update !== "object") return out;
    const kind = String(update.sessionUpdate || "");
    if (kind === "agent_message_chunk") {
      const text = Translator.contentText(update);
      if (text) {
        this.content += text;
        out.deltas.push({ content: text });
      }
      return out;
    }
    if (kind === "agent_thought_chunk") {
      const text = Translator.contentText(update);
      if (text) {
        this.reasoning += text;
        out.deltas.push({ reasoning_content: text });
      }
      return out;
    }
    if (kind === "tool_call") {
      out.deltas.push(this.pushToolCall(update));
      return out;
    }
    if (kind === "tool_call_update") {
      const delta = this.appendToolArguments(update);
      if (delta) out.deltas.push(delta);
      return out;
    }
    if (kind === "usage_update") {
      // 只记录、不造帧：上游给的是「已用 token」累计值，拆不出 OpenAI 的 prompt/completion；
      // 下发会把 server 的本地估算顶掉（见 succeed 注释），所以这里不回任何东西
      return out;
    }
    // plan / available_commands_update / llm_call_retry / 未知事件：只记录，不造帧
    return out;
  }

}

/** 下行 data 的解码：上游 `TaskStream.Data` 是 Go 的 `[]byte`，JSON 里表现为 base64 字符串。
 *  少数形态可能直接给对象/明文，一并兜底；解不出返回 null。 */
function decodeData(data) {
  if (data && typeof data === "object") return data;
  const raw = String(data == null ? "" : data);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/** 上行 data 的编码：与 decodeData 对称，base64(JSON)。服务端按 []byte 反序列化，发明文会被丢弃 */
function encodeData(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** 提问 data 解码（保留旧名，调用点不变） */
function parseQuestion(data) {
  return decodeData(data);
}

function questionReply(data) {
  const parsed = parseQuestion(data);
  if (!parsed) return null;
  const requestId = String(parsed.request_id || parsed.id || "");
  return {
    type: "reply-question",
    data: encodeData({ request_id: requestId, answers_json: "", cancelled: false }),
  };
}

/** task-error 的人话原因：字符串直接用，对象按 error/message/msg 取，都没有给默认文案 */
function errorDetail(data) {
  const fallback = "任务执行出错（上游未给原因）";
  if (typeof data === "string") return data.trim() || fallback;
  if (data && typeof data === "object") {
    for (const key of ["error", "message", "msg"]) {
      const value = typeof data[key] === "string" ? data[key].trim() : "";
      if (value) return value;
    }
  }
  return fallback;
}

/**
 * 驱动一次任务流。
 * @returns {Promise<Translator>} 正常结束；任何失败都 reject（错误带 status）
 */
function runTaskStream(opts) {
  const { region, section, deps, session, taskId, prompt, requestedModel, emit, signal } = opts;
  const translator = new Translator(taskId, requestedModel);

  return new Promise((resolve, reject) => {
    const url = endpoints.taskStreamUrl(region, section, taskId, "new");
    const headers = endpoints.wsHeaders(region, session, section);
    const idleMs = Math.max(IDLE_MIN_MS, Number(deps.streamIdleMs || 0) || 300000);

    let ws = null;
    let settled = false;
    let sentAny = false;
    let idleTimer = null;
    let handshakeTimer = null;
    let totalTimer = null;
    let opened = false;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = handshakeTimer = totalTimer = null;
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      } catch {
        /* 关闭失败不影响定性 */
      }
    };
    // 每个出口都要走到 settle 一次：重复 settle 直接忽略
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const fail = (message, status, code) => {
      const error = Object.assign(new Error(`MonkeyCode ${message}`), { status: status || 502, code: code || null });
      deps.verbose && deps.verbose(`❌ ${error.message}（${translator.summary()}）`);
      // 还没给客户端下发任何字节 → 抛错（编排层可换号 / 落真实状态码）；已经下发 → 只能进流内
      if (!sentAny) settle(() => reject(error));
      else
        settle(() => {
          emit({ type: "error", status: error.status, code: error.code, message: error.message });
          emit({ type: "finish", reason: "stop" });
          resolve(translator);
        });
    };
    const succeed = () => {
      deps.verbose && deps.verbose(`任务 ${taskId} 正常结束（${translator.summary()}）`);
      // 不 emit usage：上游只给「已用 token（used）」这一个累计值，拆不出 prompt/completion；
      // 若下发会顶掉 server 的本地估算（estimateTokens），造成流水 token 归零、每条被标
      // empty-completion、账号用量不累加。第三方 monkeycode2api 同样不发 usage 帧。
      emit({ type: "finish", reason: "stop" });
      settle(() => resolve(translator));
    };

    const sendFrame = (payload, what) => {
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (e) {
        fail(`任务流发送 ${what} 失败：${e.message}`, 502);
        return false;
      }
    };
    // 空闲判定只管"多久没有下行"，总时长由 totalTimer 独立管：两条各自到点、各自定性，
    // 把总时长夹进空闲预算里会让"还剩 2 秒到 1 小时上限"被误报成空闲超时（定性错了用户就去查错方向）。
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(`任务流空闲超时（${Math.round(idleMs / 1000)} 秒没有任何下行消息）`, 504, "stream_idle"), idleMs);
    };
    const onAbort = () => fail("客户端已断开，任务流转发停止", 499, "cancelled");

    try {
      ws = new WebSocket(url, { headers });
    } catch (e) {
      settle(() => reject(Object.assign(new Error(`MonkeyCode 任务流地址无效或握手失败：${e.message}`), { status: 502 })));
      return;
    }
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* 不支持就不转，frameText 仍会兜住 Blob 形态 */
    }

    if (signal) {
      if (signal.aborted) {
        settle(() => reject(Object.assign(new Error("MonkeyCode 客户端已断开，任务流未启动"), { status: 499 })));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    totalTimer = setTimeout(() => fail("任务流超过 3 小时上限（与上游资源时长对齐）", 504, "task_timeout"), TASK_TOTAL_MS);
    // 握手兜底：空闲计时是在 open 之后才开始的，握手卡住时必须有独立的口子，
    // 否则这条请求会一直挂到外层超时，报错归属也说不清是上游不通还是账号不通
    handshakeTimer = setTimeout(
      () => fail("任务流握手超时（WebSocket 连接未建立）", 504, "handshake_timeout"),
      Number(endpoints.WS_CONNECT_TIMEOUT_MS) || 30000,
    );

    ws.addEventListener("open", () => {
      if (settled) return;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      opened = true;
      deps.verbose && deps.verbose(`任务流已连接 task=${taskId}（mode=new）`);
      if (!sendFrame({ type: "auto-approve" }, "auto-approve")) return;
      if (!sendFrame({ type: "user-input", data: task.userInputData(prompt) }, "user-input")) return;
      armIdle();
    });

    ws.addEventListener("message", (event) => {
      if (settled) return;
      armIdle();
      Promise.resolve()
        .then(async () => {
          const text = await frameText(event && event.data);
          let payload = null;
          try {
            payload = JSON.parse(text);
          } catch {
            deps.verbose && deps.verbose("忽略任务流里的非 JSON 消息");
            return;
          }
          const type = String((payload && payload.type) || "");
          if (type === "ping") {
            // 心跳是「回一条同 type」，不主动发起；上游约 10 秒推一次
            sendFrame({ type: "ping" }, "ping");
            return;
          }
          if (type === "task-started") {
            deps.verbose && deps.verbose("任务轮次开始（task-started）");
            return;
          }
          if (type === "task-ended") {
            succeed();
            return;
          }
          if (type === "task-error") {
            fail(errorDetail(decodeData(payload.data)), 502, "task_error");
            return;
          }
          if (type !== "task-running") {
            // cursor（历史游标）/ user-input（本端消息的服务端回显）都是正常帧，静默；
            // 其余未知类型才留一条排障日志
            if (type !== "cursor" && type !== "user-input") {
              deps.verbose && deps.verbose(`忽略任务流消息类型：${type || "(空)"}`);
            }
            return;
          }
          const kind = String((payload && payload.kind) || "");
          if (kind === "acp_ask_user_question") {
            const reply = questionReply(payload.data);
            if (!reply) {
              deps.verbose && deps.verbose("Agent 提问无法解析，未自动回复（任务可能停在提问处）");
              return;
            }
            sendFrame(reply, "reply-question");
            return;
          }
          if (kind !== "acp_event") {
            deps.verbose && deps.verbose(`忽略 task-running kind=${kind || "(空)"}`);
            return;
          }
          // acp_event 的 data 是 base64(JSON)（上游 Data 是 []byte，JSON 里就是 base64 字符串）
          const acp = decodeData(payload.data);
          if (!acp) {
            deps.verbose && deps.verbose("acp_event 的 data 解不出（非 base64/JSON）");
            return;
          }
          const handled = translator.handleAcp(acp);
          for (const delta of handled.deltas) {
            sentAny = true;
            emit({ type: "delta", delta });
          }
          const acpKind = String((acp.update && acp.update.sessionUpdate) || "");
          if (acpKind === "tool_call") deps.verbose && deps.verbose(`工具调用 ${(acp.update && (acp.update.kind || acp.update.title)) || "unknown"}`);
          else if (acpKind === "available_commands_update") deps.verbose && deps.verbose("收到 available_commands_update 事件（仅记录）");
          else if (acpKind === "llm_call_retry") {
            const msg = (acp.update && (acp.update.message || acp.update.status)) || "";
            deps.verbose && deps.verbose(`上游重试中：${msg}`);
          } else if (acpKind && !["agent_message_chunk", "agent_thought_chunk", "tool_call_update", "usage_update", "plan"].includes(acpKind)) {
            deps.verbose && deps.verbose(`忽略 ACP 事件：${acpKind}`);
          }
        })
        .catch((e) => fail(`任务流消息处理中断：${e.message}`, 502));
    });

    ws.addEventListener("error", (event) => {
      if (opened) fail(`任务流传输中断：${(event && event.message) || "未知错误"}`, 502);
      else fail(`任务流连接失败：${(event && event.message) || "WebSocket 握手未完成"}`, 502);
    });

    ws.addEventListener("close", () => {
      if (settled) return;
      // 没收到 task-ended 的连接关闭按异常收尾：客户端拿不到结束帧会一直挂着
      fail("任务流连接已关闭（未收到 task-ended）", 502, "closed");
    });
  });
}

module.exports = { runTaskStream, Translator, decodeData, encodeData, parseQuestion, questionReply, errorDetail, TASK_TOTAL_MS, IDLE_MIN_MS };
