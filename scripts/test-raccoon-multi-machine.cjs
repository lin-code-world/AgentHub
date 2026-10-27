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
// 小浣熊凭据刷新自测：同机并发刷新竞态 / access 双保险 / 判失效文案 / sid 比对。
// 运行：node scripts/test-raccoon-multi-machine.cjs
// 全程离线：fetch 打桩，只碰 AGENTHUB_DATA_DIR 与 HOME 指向的临时目录（绝不触碰真实登录文件）。
//
// 说明：本文件原为「多机共用一套凭据」自测，跨机拉取/回传已随号池 WebDAV/S3 同步一并移除，
// 这里保留仍然成立的本机刷新链路回归（文件名暂留原样）。
//
// 缺陷回顾（本文件逐条钉死，改动前必红）：
//   ① refresh_token 单副本、用后轮换作废 ⇒ 同机并发刷新时手里这份可能刚被换掉，
//      直接判 expired 是错的：必须重读 ~/.box-agent/config/auth.json 取新值再试；
//   ② refresh 被拒但当前 access 仍在线（userInfo 验通）绝不误判失效；
//   ③ 服务端换会话（sid 变化）要留可诊断的告警，首次记录不告警。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-raccoon-mm-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
process.env.APPDATA = path.join(TMP, "appdata");
// raccoonAuth 读的是 ~/.box-agent/config/auth.json：把家目录也钉进沙箱，绝不碰真实登录文件
process.env.USERPROFILE = path.join(TMP, "home");
process.env.HOME = process.env.USERPROFILE;
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(path.join(process.env.USERPROFILE, ".box-agent", "config"), { recursive: true });

const rules = require("../electron/backend/proxy/rules.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const raccoonAuth = require("../electron/backend/proxy/raccoonAuth.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${extra ? " —— " + extra : ""}`);
  }
}
const now = Date.now();

/** 造一枚假 JWT：只求 payload.exp / sub 可解（util.jwtDecode 与 tokenUid 不验签） */
function jwt(expMs, sid, sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(expMs / 1000), ...(sid ? { sid } : {}), ...(sub ? { sub } : {}) })}.sig`;
}

/** 写沙箱里的桌面端登录文件（同机共用凭据的唯一副本） */
function writeAuthJson({ accessToken, refreshToken }) {
  fs.writeFileSync(raccoonAuth.authFile(), JSON.stringify({ access_token: accessToken || "", refresh_token: refreshToken || "" }, null, 2), "utf8");
}

// ===== 打桩：上游 fetch =====
let fetchCalls = [];
let refreshRoutes = []; // [{ expectRefresh, status, body, onHit }]
function installFetch() {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? String(opts.body) : "";
    let sent = "";
    try {
      sent = JSON.parse(body).refresh_token || "";
    } catch {
      /* 非刷新请求 */
    }
    fetchCalls.push({ url: u, sent });
    for (const r of refreshRoutes) {
      if (r.urlPart && !u.includes(r.urlPart)) continue;
      if (r.expectRefresh !== undefined && sent !== r.expectRefresh) continue;
      if (r.onHit) r.onHit();
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: -1, message: "stub 未匹配 " + u }), { status: 404 });
  };
}

/** 造一个真实账号行（走 store，拿到的是 row：与适配器实际收到的形状一致） */
function seedAccount({ uid, token, refreshToken }) {
  const id = store.addAccount({ channel: "raccoon", uid, name: "小浣熊 " + uid, token, refreshToken, source: "oauth", expiresAt: 0, meta: { deviceId: "d-" + uid } });
  return store.getAccount(id);
}
const secretsOf = (row) => store.accountSecrets(row);

(async () => {
  rules.init();
  store.open();
  const ad = adapters.get("raccoon");
  ok(!!ad, "拿到 raccoon 适配器");

  // ===== ① 刷新主链路：200 换回新凭据，旋转的 refresh 写回共用文件 =====
  console.log("\n[1] 刷新成功 → 轮换值写回共用文件");
  {
    const UID = "1001";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000, "", UID), refreshToken: "rt-s0" });
    writeAuthJson({ accessToken: jwt(now - 60000, "", UID), refreshToken: "rt-s0" });
    installFetch();
    refreshRoutes = [{ urlPart: "/auth/v1/refresh", expectRefresh: "rt-s0", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-1", UID), refresh_token: "rt-s1" } } }];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === true && r.token === jwt(now + 3600000, "sid-1", UID), "刷新成功拿到新 access", JSON.stringify(r));
    ok(r.refreshToken === "rt-s1", "返回轮换后的 refresh_token");
    ok(String(raccoonAuth.readTokens().refreshToken) === "rt-s1", "轮换值已写回 auth.json（桌面端下次读到的是新值）");
    ok(r.sidChanged === false, "首次记录 sid：不告警");
  }

  // ===== ② 同机并发刷新竞态：请求在途时文件被换掉 ⇒ 重读新值再试一次 =====
  console.log("\n[2] 刷新被拒 → 重读 auth.json 取到新值 → 重试成功");
  {
    const UID = "1002";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000, "", UID), refreshToken: "rt-old" });
    writeAuthJson({ accessToken: jwt(now - 60000, "", UID), refreshToken: "rt-old" });
    installFetch();
    refreshRoutes = [
      {
        urlPart: "/auth/v1/refresh",
        expectRefresh: "rt-old",
        status: 401,
        body: { code: 401, message: "unauthorized" },
        onHit: () => writeAuthJson({ accessToken: jwt(now - 60000, "", UID), refreshToken: "rt-new" }), // 同机另一路刚刷完并轮换
      },
      { urlPart: "/auth/v1/refresh", expectRefresh: "rt-new", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-2", UID), refresh_token: "rt-newest" } } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === true, "旧 refresh 被拒后仍刷新成功（改动前：直接判 expired）", JSON.stringify(r));
    ok(r.refreshToken === "rt-newest", "用的是重读到的新 refresh 换回来的结果");
    const sentSeq = fetchCalls.filter((c) => c.sent).map((c) => c.sent);
    ok(sentSeq[0] === "rt-old" && sentSeq[1] === "rt-new", "先用旧值试、重读到新值再试（顺序钉死）", sentSeq.join("→"));
  }

  // ===== ③ access 双保险：refresh 被拒但 access 仍在线 ⇒ 不判失效 =====
  console.log("\n[3] refresh 被拒但 access 还活着 → 保持 online");
  {
    const UID = "1003";
    const alive = jwt(now + 3600000, "", UID);
    const row = seedAccount({ uid: UID, token: alive, refreshToken: "rt-dead" });
    fs.rmSync(raccoonAuth.authFile(), { force: true }); // 本地文件不属于本号：兜底不得靠它
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 401, body: { code: 401, message: "unauthorized" } },
      { urlPart: "/auth/v1/user_info", status: 200, body: { code: 0, data: { id: UID, name: "小浣熊 " + UID } } },
    ];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === true && r.token === alive, "access 在线时不误判失效（保 online 态）", JSON.stringify(r));
    ok(fetchCalls.filter((c) => c.url.includes("/auth/v1/refresh")).length === 1, "只朝刷新端点发过一次请求");
  }

  // ===== ④ 兜底全不成立 ⇒ 才判 expired，文案带上服务端拒绝码 =====
  console.log("\n[4] 兜底全不成立 → 判失效，文案分流");
  {
    const UID = "1004";
    // token 故意不带 sub：userInfo 失败时会自解 JWT 兜底，解不出 uid 才不会误判「access 仍在线」
    const row = seedAccount({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-x" });
    fs.rmSync(raccoonAuth.authFile(), { force: true });
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 400, body: { code: 200822, message: "refresh token conflict or reused" } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === false && r.expired === true, "仍判 expired（该判死的时候不含糊）");
    ok(String(r.message).includes("200822"), "文案带上服务端拒绝码（200822=并发抢刷）", r.message);
  }

  // ===== ⑤ sid 变化留告警（被顶号可诊断），首次记录不告警 =====
  console.log("\n[5] sid 比对：换会话才告警");
  {
    const UID = "1005";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000, "", UID), refreshToken: "rt-s" });
    installFetch();
    refreshRoutes = [{ urlPart: "/auth/v1/refresh", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-1", UID), refresh_token: "rt-s1" } } }];
    const r1 = await ad.refreshToken(row, secretsOf(row));
    ok(r1.ok === true && r1.sidChanged === false, "首次刷新：记录 sid、不告警");
    const row2 = store.getAccount(row.id);
    refreshRoutes = [{ urlPart: "/auth/v1/refresh", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-2", UID), refresh_token: "rt-s2" } } }];
    const r2 = await ad.refreshToken(row2, secretsOf(row2));
    ok(r2.ok === true && r2.sidChanged === true, "二次刷新 sid 变了 ⇒ 标记（账号疑似在别处重新登录）");
    const st = store.getAccount(row.id);
    ok(String(st.meta).includes("sid-2"), "新 sid 已落 meta");
    ok(String(st.meta).includes("会话标识(sid)已变化"), "留了一条可诊断的告警（号池气泡看得到）");
    ok(Number(st.token_at) > 0, "sid 告警不污染凭据时刻");
  }

  const done = failed === 0;
  console.log(`\n${done ? "OK" : "FAIL"} 小浣熊凭据刷新自测：${pass} 项通过，${failed} 项失败`);
  process.exit(done ? 0 : 1);
})().catch((e) => {
  console.error("自测异常：", e);
  process.exit(1);
});
