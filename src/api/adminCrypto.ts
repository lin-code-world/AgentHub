/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 浏览器端加密传输层（任务 7）：WebCrypto 的 ECDH P-256 登录协商、HKDF 密钥派生、HMAC 请求签名、
// AES-256-GCM 请求/响应/SSE 帧加解密。协议 v1 与 electron/backend/adminCrypto.cjs 逐字对齐
// （tools/admin-crypto-browser-selftest.cjs 里同一套常量独立校验，谁改协议两边一起改）：
//   · 编码：二进制一律 base64；公钥 = base64(SPKI DER)；ts = Unix 毫秒；ciphertext = base64(密文‖16 字节 GCM tag)。
//   · K_token = HKDF-SHA256(令牌, salt="agenthub-admin", info="agenthub-auth")；
//     令牌只在登录瞬间参与派生与签名，用完即丢，不落 localStorage。
//   · 登录请求签名 = HMAC(K_token, clientPubKey \n ts \n nonce)；
//     登录响应签名 = HMAC(K_token, serverPubKey \n sessionId \n ts \n nonce)（响应不带任何会话密钥）。
//   · 会话密钥 = ECDH 共享秘密经 HKDF 派生（salt 同为 "agenthub-admin"）：
//     K_req（info=agenthub-req，请求密文）、K_resp（info=agenthub-resp，响应与 SSE 帧）、K_sig（info=agenthub-sig，请求签名）。
//   · 请求签名 = HMAC(K_sig, sessionId \n METHOD \n path \n ts \n nonce \n bodyHash)；
//     METHOD 大写；bodyHash = base64(SHA-256(密文字节))，无请求体（SSE）为空串。
//   · 响应回带请求 nonce，不符即判失败；密文被篡改 GCM 解不开同样判失败。
//     校验失败与 401 一律清会话回登录页、文案统一，不区分原因（不泄漏校验细节）。
//   · SSE（Ruling 18）：fetch 流 + 断线重新签名（一次性 nonce 无法重签，禁止原生 EventSource）；
//     每帧明文带连接内从 1 起的单调 seq（Ruling 19），重连后基线清零（跨连接沿用会把重连首帧误判成跳帧）。
// localStorage 只存 sessionId / 会话密钥 / 登录时间；旧版令牌键（agenthub.adminToken）登录后清掉。
const HKDF_SALT = "agenthub-admin";
const INFO_TOKEN = "agenthub-auth";
const INFO_REQ = "agenthub-req";
const INFO_RESP = "agenthub-resp";
const INFO_SIG = "agenthub-sig";
const KEY_LEN = 32;

const SESSION_KEY = "agenthub.adminSession";
const LEGACY_TOKEN_KEY = "agenthub.adminToken";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 与服务端会话 12 小时对齐（本地过期判断；差值由 401 兜底闭环）
const RPC_PATH = "/api/rpc";
const EVENTS_PATH = "/api/events";

const LOGIN_FAILED_MESSAGE = "登录失败：令牌不正确或服务不可用"; // 登录失败统一文案（不区分令牌错 / 签名校验失败）
const AUTH_LOST_MESSAGE = "登录已失效，请重新登录"; // 会话失效统一文案（不区分 401 / nonce 不符 / 密文被篡改）

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);
let navigateFn: () => void = () => {
  if (typeof window !== "undefined" && window.location) window.location.reload();
};

interface StoredKeys {
  kReq: string;
  kResp: string;
  kSig: string;
}
interface StoredSession {
  sessionId: string;
  keys: StoredKeys;
  loginAt: number;
}
interface LoginResponse {
  ok?: boolean;
  sessionId?: string;
  serverPubKey?: string;
  expiresAt?: number;
  ts?: number;
  nonce?: string;
  sig?: string;
  message?: string;
}

function subtleOf(): SubtleCrypto {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  // WebCrypto 只在安全上下文暴露：局域网 http://IP 访问时 subtle 为 undefined（只能换 https 或 localhost）
  if (!s) throw new Error("当前浏览器环境不支持 WebCrypto（需通过 HTTPS 或 localhost 访问），无法建立加密会话");
  return s;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64Of(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function bytesOfB64(s: string): Uint8Array {
  const bin = atob(String(s || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomB64(n: number): string {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return b64Of(out);
}

/** HKDF-SHA256 派生：ikm + 固定 salt（"agenthub-admin"）+ info → 32 字节 */
async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await subtleOf().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtleOf().deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8(HKDF_SALT), info: utf8(info) }, key, KEY_LEN * 8);
  return new Uint8Array(bits);
}

/** HMAC-SHA256 签名：字段以 \n 分隔（字段本身不含 \n：base64 / 数字 / 路径），输出 base64 */
async function hmacB64(keyBytes: Uint8Array, parts: string[]): Promise<string> {
  const key = await subtleOf().importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64Of(new Uint8Array(await subtleOf().sign("HMAC", key, utf8(parts.join("\n")))));
}

/** 密文哈希：base64(SHA-256(密文字节))，密文字节 = base64 解码后的 密文‖tag */
async function bodyHashOf(ciphertext: string): Promise<string> {
  return b64Of(new Uint8Array(await subtleOf().digest("SHA-256", bytesOfB64(ciphertext))));
}

/** 加密（默认 K_resp）：返回 { iv, ciphertext }，ciphertext = base64(密文‖tag)（WebCrypto 输出即密文‖tag） */
async function seal(keyB64: string, payload: unknown): Promise<{ iv: string; ciphertext: string }> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const key = await subtleOf().importKey("raw", bytesOfB64(keyB64), "AES-GCM", false, ["encrypt"]);
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const out = await subtleOf().encrypt({ name: "AES-GCM", iv }, key, utf8(text));
  return { iv: b64Of(iv), ciphertext: b64Of(new Uint8Array(out)) };
}

/** 解密：GCM 认证失败（含密文被篡改）返回 null，调用方按统一失效文案处理 */
async function open(keyB64: string, ivB64: string, ciphertextB64: string): Promise<string | null> {
  try {
    const key = await subtleOf().importKey("raw", bytesOfB64(keyB64), "AES-GCM", false, ["decrypt"]);
    const plain = await subtleOf().decrypt({ name: "AES-GCM", iv: bytesOfB64(ivB64) }, key, bytesOfB64(ciphertextB64));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function storageOf(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下 localStorage 不可用：会话只在本次页面生命周期内有效
  }
}

/** 读本地会话（形状不合法一律当没有）：localStorage 只有 sessionId / 密钥 / 登录时间三样 */
function loadSession(): StoredSession | null {
  try {
    const raw = storageOf()?.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (!s || typeof s.sessionId !== "string" || !s.sessionId || typeof s.loginAt !== "number" || !s.keys || typeof s.keys.kReq !== "string" || !s.keys.kReq || typeof s.keys.kResp !== "string" || !s.keys.kResp || typeof s.keys.kSig !== "string" || !s.keys.kSig) return null;
    return { sessionId: s.sessionId, keys: s.keys, loginAt: s.loginAt };
  } catch {
    return null;
  }
}

/** 本地会话是否存在且未过期（启动挂载判断用） */
export function hasSession(): boolean {
  const s = loadSession();
  return !!s && Date.now() - s.loginAt < SESSION_TTL_MS;
}

/** 清本地会话（含旧版令牌存储） */
export function clearSession(): void {
  try {
    const st = storageOf();
    st?.removeItem(SESSION_KEY);
    st?.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* localStorage 不可用时无需清理 */
  }
}

/** 会话失效收口：清会话 → 回登录页（reload 后 main.ts 看到无会话即挂登录页）→ 抛统一文案。
 *  并发请求同时失效会各自触发一次跳转（reload 幂等），不另设闸。 */
export function handleAuthLost(): never {
  clearSession();
  try {
    navigateFn();
  } catch {
    /* 跳转失败不掩盖原始错误 */
  }
  throw new Error(AUTH_LOST_MESSAGE);
}

/** ECDH 登录协商：令牌派生 K_token 签名 → 服务端回公钥 / 会话号 → ECDH 派生三把会话密钥落盘。
 *  令牌用完即丢（不落 localStorage）；失败一律抛统一文案（429 限流提示除外，它不是校验细节） */
export async function login(token: string): Promise<void> {
  const t = String(token || "").trim();
  if (!t) throw new Error(LOGIN_FAILED_MESSAGE);
  subtleOf(); // WebCrypto 缺失（非安全上下文）在这里就报，别让它混进「登录失败」统一文案
  const kToken = await hkdf(utf8(t), INFO_TOKEN);
  const kp = (await subtleOf().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const clientPubKey = b64Of(new Uint8Array(await subtleOf().exportKey("spki", kp.publicKey)));
  const ts = Date.now();
  const nonce = randomB64(16);
  const sig = await hmacB64(kToken, [clientPubKey, String(ts), nonce]);
  let res: Response | null = null;
  let data: LoginResponse | null = null;
  try {
    res = await fetchImpl("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientPubKey, ts, nonce, sig }) });
    data = (await res.json().catch(() => null)) as LoginResponse | null;
  } catch {
    data = null; // 网络失败 / 响应不可解析：按登录失败处理
  }
  if (!res || !data) throw new Error(LOGIN_FAILED_MESSAGE);
  if (res.status === 401) throw new Error(LOGIN_FAILED_MESSAGE);
  if (!res.ok) throw new Error(typeof data.message === "string" && data.message ? data.message : LOGIN_FAILED_MESSAGE); // 429 等透传服务端提示
  // 响应校验：签名 + 回带 ts / nonce 一致（防中间人换包）；任一不符按登录失败，不区分原因
  const expectSig = await hmacB64(kToken, [String(data.serverPubKey), String(data.sessionId), String(data.ts), String(data.nonce)]);
  if (data.ok !== true || data.ts !== ts || data.nonce !== nonce || data.sig !== expectSig) throw new Error(LOGIN_FAILED_MESSAGE);
  if (typeof data.sessionId !== "string" || !data.sessionId || typeof data.serverPubKey !== "string" || !data.serverPubKey) throw new Error(LOGIN_FAILED_MESSAGE);
  let shared: Uint8Array;
  try {
    const serverPub = await subtleOf().importKey("spki", bytesOfB64(data.serverPubKey), { name: "ECDH", namedCurve: "P-256" }, true, []);
    shared = new Uint8Array(await subtleOf().deriveBits({ name: "ECDH", public: serverPub }, kp.privateKey, 256));
  } catch {
    throw new Error(LOGIN_FAILED_MESSAGE); // 服务端公钥解不出 / ECDH 失败：同样按登录失败处理
  }
  const keys: StoredKeys = { kReq: b64Of(await hkdf(shared, INFO_REQ)), kResp: b64Of(await hkdf(shared, INFO_RESP)), kSig: b64Of(await hkdf(shared, INFO_SIG)) };
  const st = storageOf();
  if (!st) throw new Error(LOGIN_FAILED_MESSAGE); // 会话存不下来（隐私模式）等于没登录
  st.setItem(SESSION_KEY, JSON.stringify({ sessionId: data.sessionId, keys, loginAt: Date.now() }));
  st.removeItem(LEGACY_TOKEN_KEY); // 令牌不落浏览器：旧版令牌存储见到即清
}

/** 加密请求通道（POST /api/rpc）：K_req 加密 + K_sig 签名 → 校验回带 nonce → K_resp 解密。
 *  业务错误信封（{ok:false,message}）原样返回由调用层抛，鉴权 / 校验失败走 handleAuthLost 统一收口 */
export async function request(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const s = loadSession();
  if (!s || Date.now() - s.loginAt >= SESSION_TTL_MS) return handleAuthLost(); // 无会话 / 本地已过期：清会话回登录页
  const sealed = await seal(s.keys.kReq, JSON.stringify({ cmd, args: args || {} }));
  const ts = Date.now();
  const nonce = randomB64(16);
  const sig = await hmacB64(bytesOfB64(s.keys.kSig), [s.sessionId, "POST", RPC_PATH, String(ts), nonce, await bodyHashOf(sealed.ciphertext)]);
  let res: Response;
  try {
    res = await fetchImpl(RPC_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: s.sessionId, ts, nonce, sig, iv: sealed.iv, ciphertext: sealed.ciphertext }) });
  } catch (e) {
    throw new Error(`无法连接网关：${((e as Error) && (e as Error).message) || e}`); // 传输失败不是鉴权失败：不跳登录页
  }
  if (res.status === 401) return handleAuthLost();
  const data = (await res.json().catch(() => null)) as { nonce?: string; iv?: string; ciphertext?: string; message?: string } | null;
  if (!res.ok) throw new Error((data && data.message) || `命令 ${cmd} 执行失败（HTTP ${res.status}）`); // 404 未知命令 / 403 门控文案照传
  if (!data || data.nonce !== nonce) return handleAuthLost(); // 响应回带 nonce 不符：按失效处理（统一文案）
  const plain = await open(s.keys.kResp, String(data.iv || ""), String(data.ciphertext || ""));
  if (plain === null) return handleAuthLost(); // GCM 解不开（密文被篡改）：按失效处理
  try {
    return JSON.parse(plain);
  } catch {
    return handleAuthLost(); // 明文不是合法 JSON 同样按篡改处理
  }
}

/** SSE 连接地址：每次调用重新签名（nonce 一次性，Ruling 18 禁止 EventSource 的原因） */
export async function eventsUrl(): Promise<string> {
  const s = loadSession();
  if (!s || Date.now() - s.loginAt >= SESSION_TTL_MS) return handleAuthLost();
  const ts = Date.now();
  const nonce = randomB64(16);
  const sig = await hmacB64(bytesOfB64(s.keys.kSig), [s.sessionId, "GET", EVENTS_PATH, String(ts), nonce, ""]);
  return `${EVENTS_PATH}?sessionId=${encodeURIComponent(s.sessionId)}&ts=${ts}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`;
}

/** SSE 帧解码器：K_resp 解密 + seq 严格递增校验（跳帧 / 重放 / 重排一律拒绝）。
 *  seq 是「连接内从 1 起」：每次连接（含重连）新建解码器，基线随之清零（Ruling 19 契约补充） */
export function createEventFrameDecoder(): (frame: { iv?: string; ciphertext?: string }) => Promise<Record<string, unknown> | null> {
  let lastSeq = 0;
  return async (frame) => {
    const s = loadSession();
    if (!s) return null;
    const plain = await open(s.keys.kResp, String(frame.iv || ""), String(frame.ciphertext || ""));
    if (plain === null) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(plain);
    } catch {
      return null;
    }
    const seq = Number(payload.seq);
    if (!Number.isInteger(seq) || seq !== lastSeq + 1) return null;
    lastSeq = seq;
    return payload;
  };
}

/** 统一 HTTP 出口（自测可注入）：/api/rpc、/api/login 与 SSE 连接都走这里 */
export function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(input, init);
}

// 自测注入（仅自测用）：fetch 与「回登录页」动作可替换；传 null 恢复默认
export function __setFetch(fn: FetchLike | null): void {
  fetchImpl = typeof fn === "function" ? fn : (input, init) => globalThis.fetch(input, init);
}

export function __setNavigate(fn: (() => void) | null): void {
  navigateFn =
    typeof fn === "function"
      ? fn
      : () => {
          if (typeof window !== "undefined" && window.location) window.location.reload();
        };
}
