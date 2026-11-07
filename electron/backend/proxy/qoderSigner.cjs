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
// 反代网关 · Qoder 请求签名器（WASM 驱动）
//
// 为什么需要它：Qoder 的推理请求**每请求签名**（20 个头，含 Cosy-Date 与绑定请求体的签名），
// 且请求体经 Encode=1 自定义编码——两者都由 Qoder 客户端内置的 wasm 完成，无法手工构造。
// 本模块把该 wasm 及其 wasm-bindgen 胶水从**本机已安装客户端**中提取出来，在 Node 里独立驱动。
//
// 客户端形态与提取路径（都是实测出来的，单一路径会在另一种安装上失明）：
//   · 安装定位：默认路径 / launcher 版本目录 / 注册表兜底 —— 见 qoderInstall.cjs
//   · 提取分两条，补丁产物对上层暴露同一套 API（initGlue() / glue()）：
//     ① 截断路径（0.4.x）：在 worker 入口 `SY(),Bir(` 处截断（不截断会启动 worker 主循环挂住），
//        追加 `export{t9 as initGlue,Hm as glue}`；
//     ② 通用路径（0.3.x 等）：混淆变量名随版本变化（入口标记可能整体不存在），
//        故不认名字认结构——按 wasm-bindgen 的稳定特征现取变量名：
//          · 内嵌 wasm：`<X>="AGFzbQEAAAA…`（base64 魔数）+ 其懒加载器（任意包装形态）
//          · 胶水容器：`er(<Z>,{…})` 导出注册段（QoderContext 键名跨版本稳定，但
//            v3 起以 ProfileEncryptor 键反查 er 开括号，不再依赖 QoderContext 的距离）
//          · 胶水懒加载器：由 `ProfileEncryptor` 实现类的 `=class` 定义向前定位，
//            兜底从 er 容器开括号向前找最近的懒加载赋值
//        追加补丁：先中和文件末尾的 worker 启动入口，再触发懒加载 + 导出 initGlue()/glue()。
//        **不中和会闪退**：import 会执行模块顶层语句，worker main 跑起来后会 process.exit。
//     两条路径的产物缓存键一致：obf 的 size+mtime + 提取方式，客户端升级自动重建。
//
// 胶水为**标准 wasm-bindgen 产物**，import 全部来自 ./qoder_auth_wasm_bg.js；wasm 本体 298,606 B，
// 17 个公开 API（qodercontext_* / requestresult_* / generate_runtime_auth_fields /
// decrypt_server_response / model_cache_* / credential_storage_* 等）。
//
// 已知代价：缓存模块 33MB（Node 解析约 1s），仅在首次使用 qoder 渠道时惰性加载。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const config = require("../config.cjs");
const install = require("./qoderInstall.cjs");

const ENTRY_MARK = "SY(),Bir("; // 0.4.x worker 入口；截断点（未命中则走通用提取）
const WASM_MAGIC = "AGFzbQEAAAA"; // 内嵌 wasm 的 base64 魔数（\0asm）；下面 pickByStructure 的正则里是同一串
// 必需特征：initGlue()/glue() 直接依赖的三个（wasm 字节、胶水容器、async init）。
// loaderWasm/loaderGlue 已降为可选（见 pickByStructure 末尾的补救逻辑与 patchText）：
// 顶层常量形态下它们本来就不存在，不触发也不会错；initGlue 不依赖它们。
const REQUIRED_FEATURES = ["wasmVar", "glueVar", "initAsync"];
const CACHE_VERSION = 7; // v7：提取规则加固——注册段双验证（glueVar/initAsync）、loaderGlue 改按
//   结构判据（heap 所在单元）优先；对 0.5.6 产物与加固前一致，bump 仅为口径一致、强制重算。
// v6：0.5.6 适配——胶水被拆成独立懒加载单元（heap 在 j9i 内）、注册函数 er→Ct、包装函数 b→w。
// v5：新增 0.5.x 的「零参调用链」启动入口识别（v4 及以前在 0.5.3 上漏中和 → 模块自退）
// worker 启动入口必须位于文件末尾才允许截断；中部命中是函数定义，截断会丢模块代码。
// 现网样本的入口都在最后 8KB 内（0.9.18/1.1.40 约 100B，1.1.71/1.1.73 约 2KB）。
const BOOTSTRAP_NEAR_EOF = 8192;

/** 客户端 resources 目录（多候选定位，见 qoderInstall.cjs） */
function installResources(product) {
  return install.findResources(product) || "";
}

/** 定位 worker obf 与客户端版本 */
function locate(product) {
  const res = install.findResources(product);
  if (!res) return null;
  // SDK 目录名按版本而异（实测 0.3.3 国际版 = qoder-agent-sdk；0.4.x CN = qoder-cn-agent-sdk）——
  // 两个都试，命中即用，不按产品名硬编码
  for (const sdk of ["qoder-agent-sdk", "qoder-cn-agent-sdk"]) {
    const obf = path.join(res, "app.asar.unpacked", "node_modules", "@qoder-ai", sdk, "dist", "_worker", "qoder-worker-runtime.obf.mjs");
    if (!fs.existsSync(obf)) continue;
    let version = "0.5.3";
    try {
      const bm = JSON.parse(fs.readFileSync(path.join(res, "build-manifest.json"), "utf8"));
      if (bm && bm.productVersion) version = String(bm.productVersion);
    } catch { /* 缺失则用兜底版本号（版本串实测宽容：0.2.x~9.9.9 均通过签名） */ }
    return { obf, version, resources: res, sdk };
  }
  return null;
}

/**
 * 通用提取：不认混淆名、按 wasm-bindgen 结构特征现取变量名。
 * 返回 { loaderGlue, loaderWasm, glueVar, wasmVar, initAsync, initSync, profileEnc }
 *
 * 每个特征都给**多条候选正则**（按精确度降序），命中即止——客户端换打包器/加字段时，
 * 先失配的往往是「引号类型」「空白」「容器长度上限」这类无关语义的细节，
 * 单条正则会把整条提取链一起拖死（issue #119 的表现就是五缺四）。
 * 候选一律**先严后宽**：宽的那条只在严的失配时才跑，故对已知结构的结果逐字不变。
 *
 * v3 补救（issue #119，适配 0.4.8 结构变化）：0.4.8 失效模式是**懒加载器包装形态变化**
 * （`X=b(()=>{` 不再是唯一形式）、**注册函数改名**（0.3.3=er、0.4.8=dn，全文 er( 有
 * 六千余次无关调用）与 **er 容器字段增多/键名变化**（QoderContext 不再是可靠锚点）。
 * profileEnc / initSync 是导出注册段内的键值对，只要段还在就命中——用它反查注册调用，
 * 不依赖任何易变的函数名/键名：
 *   · 注册调用定位：profileEnc 键之前最近的「注册函数(容器变量,{」结尾（双验证：段内
 *     同时含 `default:()=>` 与 `initSync:()=>`，防误匹配到其他调用）
 *   · glueVar / initAsync：由上述注册调用定位（glueVar=首参容器变量，initAsync=段内 default）
 *   · loaderWasm：wasmVar 声明处向前找最近的懒加载赋值（结尾锚定 `{`，任意包装形态）
 *   · loaderGlue：主路径（类定义前扫）放宽窗口；兜底从注册调用开括号向前找懒加载赋值
 */
/** openIdx 处的 `{` 到 pos 之间括号是否保持未闭合（即 pos 落在该 `{}` 内）。引号感知。 */
function braceEncloses(text, openIdx, pos) {
  let depth = 0, quote = null;
  for (let i = openIdx; i < pos; i++) {
    const ch = text[i];
    if (quote) { if (ch === "\\") { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return false; }
  }
  return depth > 0;
}

function pickByStructure(text) {
  const pick = (res) => {
    for (const re of Array.isArray(res) ? res : [res]) {
      const m = text.match(re);
      if (m) return m[1];
    }
    return "";
  };
  // 注册段双验证：段内同时含 default:()=> 与 initSync:()=>（与 v3 补救同判据）——防止
  // 「同构的其他注册段」被误取：全文可能有别处也注册了 QoderContext 键，但那不是 wasm 胶水
  // 的注册段；只有同时带 async init（default）与 initSync 才是。
  const glueSegOk = (at, len = 8000) => {
    if (at < 0) return false;
    const seg = text.slice(at, at + len);
    return /default:\s*\(\)\s*=>/.test(seg) && /initSync:\s*\(\)\s*=>/.test(seg);
  };
  const names = {
    // 内嵌 wasm 的 base64 变量：引号有 " ' ` 三种写法
    wasmVar: pick([
      /([A-Za-z_$][\w$]*)="AGFzbQEAAAA/,
      /([A-Za-z_$][\w$]*)='AGFzbQEAAAA/,
      /([A-Za-z_$][\w$]*)=`AGFzbQEAAAA/,
    ]),
    // wasm 懒加载器：要求闭包**紧跟** wasm 赋值（`X=<包装>(...)=> {Y="AGFzbQEAAAA`）。
    // 注意：不能用「400 字符内有魔数」这类宽判据——33MB 文本里魔数出现多次
    // （base64 数据内部存在巧合子串），宽判据会误匹配到无关懒加载器（issue #119 实测
    // 命中 /dev/null 集合的 D7A）。「紧跟」既覆盖包装名变化（b 只是本版本名字），
    // 又天然排除巧合；闭包内赋值不紧跟的形态由下方补救⑤（从声明位置向前找）兜底。
    loaderWasm: pick([
      /,\s*([A-Za-z_$][\w$]*)=b\(\(\)=>\{[A-Za-z_$][\w$]*=["'`]AGFzbQEAAAA/,
      /,\s*([A-Za-z_$][\w$]*)=(?:async\s+)?(?:[\w$]+\s*)?\([^)]*\)\s*(?:=>)?\s*\{[A-Za-z_$][\w$]*=["'`]AGFzbQEAAAA/,
    ]),
    // 胶水容器 er(X,{…QoderContext:()=>…})：键名跨版本稳定，但容器字段会变多——
    // 原 800 字符上限在字段增加时会失配，宽松版放到 3000 并允许 er( 后有空白
    // 注册函数名跨版本可变（0.4.8=dn、0.5.6=Ct，且全文同名调用数千次），故不认名字认结构：
    // 以跨版本稳定的 QoderContext 键为锚点，向前匹配「<注册函数>(<容器变量>,{…QoderContext:()=>…」。
    // 注册函数名用非捕获组吃掉——m[1] 必须是容器变量本身。
    glueVar: (() => {
      const re1 = /(?:[A-Za-z_$][\w$]*)\s*\(([A-Za-z_$][\w$]*),\s*\{[^{}]{0,800}?QoderContext:\(\)=>/;
      const re2 = /(?:[A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[\s\S]{0,3000}?QoderContext\s*:\s*\(\)\s*=>/;
      // 严判据优先：命中段须通过双验证（glueSegOk）；都不通过再退回首个命中（保持旧行为、不因加固而失配）
      for (const re of [re1, re2]) {
        const m = text.match(re);
        if (m && glueSegOk(m.index)) return m[1];
      }
      const m = text.match(re1) || text.match(re2);
      return m ? m[1] : "";
    })(),
    profileEnc: pick(/ProfileEncryptor:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/),
    initSync: pick(/initSync:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/),
  };
  // default（async init）在 glue 的注册段内取；窗口同步放宽到 3000（字段变多时 default 更靠后）。
  // 注册函数名不写死（0.5.6 起 er→Ct），与 glueVar 同一结构锚点：QoderContext 键。
  // 优先取「段内双验证通过」的注册段位置；都不通过再退回首个命中位置（保持旧行为）
  const erRe = /(?:[A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*\{[\s\S]{0,3000}?QoderContext\s*:\s*\(\)\s*=>/g;
  let erAt = -1;
  let erFirst = -1;
  for (const m of text.matchAll(erRe)) {
    if (erFirst < 0) erFirst = m.index;
    if (glueSegOk(m.index)) { erAt = m.index; break; }
  }
  if (erAt < 0) erAt = erFirst;
  if (erAt >= 0) {
    const m = text.slice(erAt, erAt + 3000).match(/default:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/);
    if (m) names.initAsync = m[1];
  }
  // 胶水懒加载器（两条路径，命中即止）：
  //   ① ProfileEncryptor 实现类的 =class 定义前扫懒加载赋值（v3 窗口 400→1200，
  //      闭包形态从 b(()=>{ 放宽到任意「=…{」结尾的赋值）
  //   ② 从 glueVar 反查——包含 `er(glueVar,` 的那个 `X=b(()=>{` 闭包就是胶水模块的懒加载器。
  //      ②是①的兜底：客户端删掉/改名 ProfileEncryptor 时①必然失配，而 er(glueVar 这个锚点
  //      由 glueVar 的成功提取保证存在，不依赖任何易变的类名
  // 结构判据优先（比位置判据可靠）：wasm-bindgen 的 heap（`new Array(1024)`）所在的那个
  // 懒加载单元就是胶水模块——从 heap 往前找最近的 `X=Y(()=>{`，并要求 heap 确在该单元体内
  // （braceEncloses，防取到无关单元）。0.5.6 起胶水被拆成独立单元（导出注册在顶层、heap 与
  // ClientContext/ProfileEncryptor 类在 j9i 内）；不触发它，wasm 回调 Mw 读 heap 会
  // undefined.length。找不到（如 heap 在顶层，无任何 w 单元包裹）则退回下面的位置判据。
  if (!names.loaderGlue) {
    const heapAt = text.indexOf("new Array(1024)");
    if (heapAt > 0) {
      const winStart = Math.max(0, heapAt - 30000);
      const win = text.slice(winStart, heapAt);
      const cands = [...win.matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/g)];
      for (let i = cands.length - 1; i >= 0; i--) {
        const openAbs = winStart + cands[i].index + cands[i][0].length - 1;
        if (braceEncloses(text, openAbs, heapAt)) { names.loaderGlue = cands[i][1]; break; }
      }
    }
  }
  if (!names.loaderGlue && names.profileEnc) {
    const at = text.indexOf(names.profileEnc + "=class");
    if (at > 0) {
      const before = text.slice(Math.max(0, at - 1200), at);
      // 优先保留原精确形态（0.4.x `,X=b(()=>{$`）；再放宽包装函数名（b→任意）；
      // 最后兜底取窗口内**最后一个** `X=Y(()=>{`——0.5.6 包装变 w 且尾部紧跟类定义，
      // 窗口末尾不再是 `{`，只能取离 profileEnc 最近的单元（= 胶水模块 j9i：heap
      // `new Array(1024)` 与 ClientContext/ProfileEncryptor 类都定义在里面；不触发它，
      // wasm 回调 Mw 读 heap 会 `undefined.length`）。
      const lastCandidate = () => {
        const a = [...before.matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/g)];
        return a.length ? a[a.length - 1] : before.match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
      };
      const m = before.match(/,([A-Za-z_$][\w$]*)=b\(\(\)=>\{$/)
        || before.match(/,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{$/)
        || lastCandidate();
      if (m) names.loaderGlue = m[1];
    }
  }
  if (!names.loaderGlue && names.glueVar) {
    // <注册函数>(glueVar, 的位置：注册函数名跨版本可变（er→dn→Ct），不写死
    const at = text.search(new RegExp(`(?:[A-Za-z_$][\\w$]*)\\(\\s*${names.glueVar.replace(/\$/g, "\\$")}\\s*,`));
    if (at > 0) {
      const before = text.slice(0, at);
      const all = [...before.matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/g)];
      if (all.length) names.loaderGlue = all[all.length - 1][1];
    }
  }

  // ===== v3 补救（profileEnc 反查，不依赖 QoderContext 键名/距离）=====
  // 注册调用定位：ProfileEncryptor 键之前最近的「注册函数(容器变量,{」结尾。
  // 注册函数名跨版本可变（0.3.3=er、0.4.8=dn，且全文 er( 有 6 千余次无关调用），
  // 故不认名字认结构：结尾锚定「<标识符>(<标识符>,{」，配合段内双验证防误匹配。
  const peKeyAt = names.profileEnc ? text.indexOf("ProfileEncryptor:()=>" + names.profileEnc) : -1;
  const regCall = (() => {
    if (peKeyAt <= 0) return null;
    const m = text.slice(0, peKeyAt).match(/([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\s*\{$/);
    return m ? { fn: m[1], varName: m[2], at: peKeyAt - m[0].length } : null;
  })();
  // wasm 声明位置（loaderWasm 补救用）
  const wasmDeclAt = (() => {
    const m = text.match(/([A-Za-z_$][\w$]*)=["'`]AGFzbQEAAAA/);
    return m ? m.index : -1;
  })();
  if (regCall) {
    const seg = text.slice(regCall.at, regCall.at + 8000);
    const isGlueSeg = /default:\s*\(\)\s*=>/.test(seg) && new RegExp("initSync:\\s*\\(\\)\\s*=>").test(seg);
    // ③ glueVar：注册调用首参（容器变量）
    if (!names.glueVar && isGlueSeg) names.glueVar = regCall.varName;
    // ④ initAsync：容器段内找 default:()=>（QoderContext 改名/挪远后原路径失配）
    if (!names.initAsync && isGlueSeg) {
      const m = seg.match(/default:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/);
      if (m) names.initAsync = m[1];
    }
    // ⑥ loaderGlue 兜底③：注册调用开括号向前找最近的懒加载赋值（任意包装形态）。
    //    字符类只排 { }（不排 =）：箭头函数的 `=>` 含 =，排掉会断匹配。
    if (!names.loaderGlue) {
      const m = text.slice(0, regCall.at).match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
      if (m) names.loaderGlue = m[1];
    }
  }
  // ⑤ loaderWasm 兜底：wasmVar 声明处向前找最近的懒加载赋值（b(()=>{ 形态变化时）。
  //    字符类只排 { }（不排 =）：同⑥，兼容 `X=async()=>{` 等箭头包装。
  if (!names.loaderWasm && wasmDeclAt > 0) {
    const m = text.slice(0, wasmDeclAt).match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
    if (m) names.loaderWasm = m[1];
  }
  return names;
}

/**
 * 定位 worker 顶层启动入口。现网客户端有三种收尾形态：
 *   ① process.env.QODERCLI_RUNTIME_PACKAGING="worker_mjs",parse(process.argv),main().catch(...)
 *   ② SD(),qar(async()=>{...})（qar 内部再读 process.argv）
 *   ③ AQ(),"sites"===process.argv[2]?...:j0r(async()=>{...})
 * 先认「真正会调用 worker」的形态（invocation），env 赋值单独出现不启动 worker，
 * 只作为没命中调用形态时的兜底。同一段入口命中多个锚点时取**末尾窗口内最靠后**的一个：
 * env 常在调用之前（裁在调用处即可，留下的 env 赋值无害），而 ② 的 env 在函数体内、
 * 调用在文件最末——取最靠后才是那一次真实调用。
 */
function findWorkerBootstrap(text) {
  const nearEof = (re) => {
    let m;
    let last = null;
    while ((m = re.exec(text))) {
      if (text.length - m.index <= BOOTSTRAP_NEAR_EOF) last = m.index;
    }
    return last;
  };
  const invocations = [
    ["async-call", /,\s*[A-Za-z_$][\w$]*\s*\(\s*async\s*\(\)\s*=>\s*\{/g],
    ["sites-ternary", /,\s*[^,;{}]{0,200}?===\s*process\.argv\[2\]\s*\?/g],
    ["argv-call", /,\s*[A-Za-z_$][\w$]*\s*\(\s*process\.argv/g],
    // 0.5.x（第 4 种收尾形态）：启动入口变成「零参调用链 + 带配置对象的注册调用」，
    // 形如 `Sa(),w8t(),E8t({configDirNames:…,createFramework:…})`；不含 process.argv /
    // QODERCLI_RUNTIME_PACKAGING，上面三锚点全失配。锚在整条语句前的分号上（裁在分号处即可）。
    ["call-chain", /;\s*(?:[A-Za-z_$][\w$]*\(\)\s*,\s*)+[A-Za-z_$][\w$]*\(\{/g],
  ];
  let best = null;
  for (const [anchor, re] of invocations) {
    const at = nearEof(re);
    if (at !== null && (!best || at > best.at)) best = { anchor, at, kind: "invocation" };
  }
  if (!best) {
    const at = nearEof(/process\.env\.QODERCLI_RUNTIME_PACKAGING\s*=\s*["']worker_mjs["']/g);
    if (at !== null) best = { anchor: "env", at, kind: "env" };
  }
  if (!best) return null;
  return { ...best, fromEnd: text.length - best.at };
}

/**
 * 把末尾的 worker 启动入口换成空语句，保留它之前的模块代码。
 * 实测：0.9.18 裁到 env 赋值、1.1.71 裁到 `,qar(`、1.1.73 裁到 `,"sites"...`，
 * 之后 initGlue() 均可正常初始化且进程不再退出。
 */
function neutralizeWorkerBootstrap(text) {
  const hit = findWorkerBootstrap(text);
  if (!hit) return { text, bootstrap: null };
  // 锚点可能落在逗号上（SD(),qar(...)）：保留前面的表达式，用一个空语句收尾。
  // 用换行再分号，避免截断点正好落在行注释末尾时被注释吞掉。
  return { text: `${text.slice(0, hit.at).trimEnd()}\n;\n`, bootstrap: hit };
}

/** 补丁模块自检：子进程 import + initGlue，worker 入口若没中和干净会在这里退出。 */
function smokePatchedModule(file) {
  const code = [
    "try {",
    "  const m = await import(process.argv[1]);",
    "  await m.initGlue();",
    "  await new Promise((r) => setTimeout(r, 1200));",
    '  console.log("SIGNER-OK");',
    "  process.exit(0);",
    "} catch (e) {",
    '  console.error("SIGNER-ERR", e && (e.stack || e.message));',
    "  process.exit(8);",
    "}",
  ].join("\n");
  // Electron 主进程里 process.execPath 是 AgentHub.exe，必须用 ELECTRON_RUN_AS_NODE 以 Node 模式跑。
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(file).href], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 20000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error) throw new Error(`签名器补丁自检启动失败：${r.error.message}`);
  if (r.status !== 0 || !/SIGNER-OK/.test(String(r.stdout || ""))) {
    const detail = String(r.stderr || r.stdout || "").replace(/\s+/g, " ").slice(-500);
    throw new Error(`签名器补丁自检失败（exit=${r.status}${r.signal ? ` signal=${r.signal}` : ""}）：${detail || "无输出"}`);
  }
}

/** 生成补丁文本；两条路径产物对上层暴露同一套 API：initGlue()（async）/ glue() */
function patchText(text) {
  const cut = text.indexOf(ENTRY_MARK);
  if (cut >= 0) {
    return `${text.slice(0, cut)}\nexport{t9 as initGlue,Hm as glue};\n`;
  }
  const n = pickByStructure(text);
  const missing = REQUIRED_FEATURES.filter((k) => !n[k]);
  if (missing.length) {
    const err = new Error(`Qoder worker 结构变化：通用提取缺 ${missing.join("/")}（客户端版本可能大改，需重新适配）`);
    // 诊断上下文挂在错误上：buildPatchedModule 补上客户端版本/体积后一并抛出。
    // 「入口标记在不在 / 内嵌 wasm 还在不在」这两项决定这次是放宽正则就能救，
    // 还是客户端把 wasm 拆成了外链文件（那要新增一条读取路径，不是调正则的事）。
    err.qoderDiag = { entryMarkHit: false, hasInlineWasm: text.includes(WASM_MAGIC), features: n, missing };
    throw err;
  }
  // loaderWasm / loaderGlue 为可选（顶层常量形态下不存在，不触发也不会错）：
  // 有则触发懒加载（胶水/wasm 未加载时 initGlue 内部会报更直观的错），无则跳过。
  const neutral = neutralizeWorkerBootstrap(text);
  const lines = [neutral.text, ""];
  if (n.loaderGlue) {
    lines.push(`try { ${n.loaderGlue}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`);
  }
  if (n.loaderWasm) {
    lines.push(`try { ${n.loaderWasm}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`);
  }
  lines.push(
    `export async function initGlue() { await ${n.initAsync}(Buffer.from(${n.wasmVar}, "base64")); }`,
    `export function glue() { return ${n.glueVar}; }`,
    "",
  );
  return lines.join("\n");
}

function cacheDir() {
  const d = path.join(config.dataDir(), "proxy", "qoder-signer");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 提取 + 追加导出 → 缓存模块；返回可 import 的绝对路径 */
function buildPatchedModule(product, loc) {
  if (!loc || !loc.obf) throw new Error(`${product} 客户端未安装或结构不匹配，无法提取签名器`);
  const st = fs.statSync(loc.obf);
  // 缓存键 = 产品 + SDK 目录 + obf 指纹 + 补丁代次；**先查缓存再读文件**——
  // obf 是 33MB，缓存命中时再读一遍既浪费又会让多次调用把内存打爆
  const hash = crypto.createHash("sha256").update(`${product}:${loc.sdk || ""}:${st.size}:${Math.floor(st.mtimeMs)}:v${CACHE_VERSION}`).digest("hex").slice(0, 16);
  const out = path.join(cacheDir(), `worker-${product}-${hash}.mjs`);
  if (fs.existsSync(out)) return out;
  const text = fs.readFileSync(loc.obf, "utf8");
  let patched;
  try {
    patched = patchText(text);
  } catch (e) {
    // 把「哪个版本、多大、入口标记在不在、内嵌 wasm 在不在、已命中哪些特征」补进消息。
    // 只靠「缺 X/Y/Z」用户没法自助，维护者也得反追问一轮；补上后一眼能判断适配方向。
    if (e && e.qoderDiag) {
      const d = e.qoderDiag;
      const hit = Object.keys(d.features || {}).filter((k) => d.features[k]);
      e.message +=
        `｜客户端版本=${loc.version} sdk=${loc.sdk || "?"} obf=${st.size}B` +
        `｜入口标记${d.entryMarkHit ? "命中" : "未命中"}，内嵌 wasm ${d.hasInlineWasm ? "在" : "不在"}，已命中特征=${hit.join(",") || "无"}` +
        `｜取证：node tools/proxy-qoder-probe.cjs`;
    }
    throw e;
  }
  const tmp = `${out}.tmp.${process.pid}.mjs`;
  fs.writeFileSync(tmp, patched, "utf8");
  try {
    // 静态兜底：补丁里不允许再出现会调用 worker 的入口（单独的 env 赋值无害）；
    // 动态兜底：子进程 import 后不能退出。
    const leftover = findWorkerBootstrap(patched);
    if (leftover && leftover.kind === "invocation") {
      throw new Error(`补丁仍包含 worker 启动入口（锚点=${leftover.anchor}，距末尾 ${leftover.fromEnd}B）`);
    }
    smokePatchedModule(tmp);
    fs.renameSync(tmp, out);
    // 侧车元数据：目标机只拷 .mjs 时用它取版本（没拷侧车就回落默认版本）
    try {
      fs.writeFileSync(out.replace(/\.mjs$/, ".meta.json"), JSON.stringify({ product, version: loc.version, sdk: loc.sdk || "", obf: path.basename(loc.obf), size: st.size, at: Date.now() }), "utf8");
    } catch { /* 侧车写失败不影响签名 */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 已删除 */ }
    throw new Error(`Qoder 签名器补丁不可用：${(e && e.message) || e}`);
  }
  // 清理旧版本缓存（同渠道只保留最新一份，避免 33MB 累积）；跳过并发构建的自检临时文件
  try {
    for (const f of fs.readdirSync(cacheDir())) {
      if (f.startsWith(`worker-${product}-`) && f !== path.basename(out) && f.endsWith(".mjs") && !f.includes(".tmp.")) {
        fs.unlinkSync(path.join(cacheDir(), f));
      }
    }
  } catch { /* 清理失败不影响功能 */ }
  return out;
}

// ===== 签名器实例（按渠道缓存）=====

const signerCache = new Map(); // product → Promise<{glue, version}> | null(不可用)

/** 随包内置的签名器缓存（安装目录的 resources/qoder-signer/，由 electron-builder 的
 *  extraResources 放进去；开发态读仓库 build/qoder-signer/）。**真实文件、不在 asar 里，可直接 import**。
 *  运行时只认这里——没有就报错，不再去数据目录或本机客户端找。 */
function bundledDir() {
  if (process.resourcesPath) {
    const d = path.join(process.resourcesPath, "qoder-signer");
    try { if (fs.readdirSync(d).length) return d; } catch { /* 回落到开发态目录 */ }
  }
  return path.join(__dirname, "..", "..", "..", "build", "qoder-signer");
}

function findBundledModule(product) {
  const dir = bundledDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(`worker-${product}-`) && f.endsWith(".mjs"));
  } catch {
    files = [];
  }
  if (!files.length) return null;
  const file = path.join(dir, files[0]);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(file.replace(/\.mjs$/, ".meta.json"), "utf8")); } catch { /* 无侧车：用默认版本 */ }
  return { file, meta };
}

/** 是否运行在打包后的安装包里：决定要不要允许"从本机客户端现场生成"的开发兜底。
 *  安装包运行时只认安装目录里的随包缓存；开发模式（npm run dev / 自测）没有随包缓存时才现生成。 */
function isPackaged() {
  try {
    const e = require("electron");
    return !!(e && e.app && e.app.isPackaged);
  } catch {
    return false;
  }
}

async function loadGlue(product) {
  if (signerCache.has(product)) return signerCache.get(product);
  const p = (async () => {
    // ① 安装目录里的随包缓存（安装包运行时就只有这一条路）
    const bundled = findBundledModule(product);
    if (bundled) {
      const mod = await import(pathToFileURL(bundled.file).href);
      await mod.initGlue();
      return { glue: mod.glue(), version: (bundled.meta && bundled.meta.version) || "0.5.3", resources: "", sdk: "", bundled: true };
    }
    // ② 未打包（开发模式 / 自测）：允许从本机已安装的客户端现场生成，省得本地还要先 stage
    if (!isPackaged()) {
      const loc = locate(product);
      if (loc) {
        const mod = await import(pathToFileURL(buildPatchedModule(product, loc)).href);
        await mod.initGlue();
        return { glue: mod.glue(), version: loc.version, resources: loc.resources, sdk: loc.sdk };
      }
    }
    throw new Error(`安装目录里没有 ${product} 的签名器缓存（${path.join(bundledDir(), `worker-${product}-*.mjs`)}）；请在有 Qoder 客户端的机器上打包，或把缓存放进安装目录的 qoder-signer 文件夹`);
  })();
  // 成功才缓存（对齐 qoderInstall「不缓存失败」的设计声明）：失败/null 钉死在缓存里
  // 会让签名器一次性故障（结构变更/临时 IO 错/用户装完客户端）直到重启才能恢复
  p.then((v) => {
    if (!v) signerCache.delete(product);
  }).catch(() => {
    signerCache.delete(product);
  });
  signerCache.set(product, p);
  return p;
}

/** 渠道是否可用（客户端已安装且胶水加载成功） */
async function available(product) {
  try {
    return !!(await loadGlue(product));
  } catch {
    return false;
  }
}

/**
 * 为某账号建立签名会话。
 * 关键：签名材料由**该账号的 token** 派生（generate_runtime_auth_fields）——
 * 这正是早期 "Signature invalid" 的缺环：不派生而传空串，签名必被拒。
 */
async function createSession({ product, token, uid, machineId }) {
  const loaded = await loadGlue(product);
  if (!loaded) throw new Error(`${product} 签名器不可用：安装目录里没有签名器缓存（resources/qoder-signer/worker-${product}-*.mjs）`);
  const { glue, version } = loaded;

  const seed = JSON.stringify({
    uid,
    security_oauth_token: token,
    organization_id: "",
    organization_tags: [], // 必须是数组（wasm 侧 Rust serde 校验）
    data_policy_agreed: true,
  });
  const runtime = JSON.parse(glue.generate_runtime_auth_fields(seed));
  const userAuth = {
    uid,
    encrypt_user_info: runtime.encrypt_user_info,
    key: runtime.key,
    organization_id: "",
    organization_tags: [],
    data_policy_agreed: true,
  };
  // clientInfo 传空对象即可：wasm 内置默认值，仍产出完整 Cosy-* 头（实测）
  const ctx = new glue.QoderContext(machineId || "00000000-0000-0000-0000-000000000000", version, JSON.stringify(userAuth), "{}");
  ctx.refreshAuthFields(JSON.stringify(userAuth));

  return {
    version,
    /** 生成签名+编码后的推理请求：arg1=origin，arg2=请求体 JSON 字符串，arg3=modelKey，arg4=source */
    prepareInferRequest(origin, bodyJson, modelKey, source = "system") {
      const r = ctx.prepareInferRequest(origin, bodyJson, modelKey, source);
      const headers = {};
      const pairs = r.headers instanceof Map ? [...r.headers.entries()] : Object.entries(r.headers || {});
      for (const [k, v] of pairs) headers[k] = String(v);
      return { url: r.url, headers, body: Buffer.from(r.body.buffer ?? r.body) };
    },
    /** 通用请求签名（非推理接口，如官方模型列表）：arg1=origin，arg2=path，arg3=method，
     *  arg4=kind（"auth" 走 Authorization 头、"sign" 走 Signature 头；模型列表实测须用 "auth"），
     *  arg5=body，arg6=headersJson。返回 { url, headers, body }；body 为空时 null。
     *  读属性后 free RequestResult：它是 wasm 对象，不 free 会随拉取次数线性泄漏。 */
    prepareApiRequest(origin, apiPath, method, kind, body, headersJson) {
      const r = ctx.prepareRequest(origin, apiPath, method, kind, body, headersJson);
      const headers = {};
      const pairs = r.headers instanceof Map ? [...r.headers.entries()] : Object.entries(r.headers || {});
      for (const [k, v] of pairs) headers[k] = String(v);
      const out = { url: r.url, headers, body: r.body != null ? Buffer.from(r.body.buffer ?? r.body) : null };
      try { r.free && r.free(); } catch { /* 已释放 */ }
      return out;
    },
    /** 目录缓存解密：catalog-v6 文件文本 + uid → JSON 文本 */
    modelCacheDecrypt(text, ownerUid) {
      return glue.model_cache_decrypt(text, ownerUid);
    },
    free() {
      try { ctx.free && ctx.free(); } catch { /* 忽略 */ }
    },
  };
}

/** 供自测/诊断：返回定位与加载信息 */
async function describe(product) {
  const loc = locate(product);
  const info = { product, installed: !!loc, obf: loc ? loc.obf : null, version: loc ? loc.version : null, resources: loc ? loc.resources : null, sdk: loc ? loc.sdk : null };
  if (loc) {
    try {
      const loaded = await loadGlue(product);
      info.glueLoaded = !!loaded;
      info.exports = loaded ? Object.keys(loaded.glue).length : 0;
    } catch (e) {
      info.glueError = String((e && e.message) || e).slice(0, 160);
    }
  }
  return info;
}

/**
 * 取证：对某产品的 obf 做**纯结构探测**，返回可直接回传的诊断摘要（issue #119 用）。
 * 只读客户端文件——不加载 wasm、不写缓存、不联网，可在任何机器上安全跑。
 *
 * 输出里最能定方向的三项：
 *   · entryMark.hit    入口标记是否还在 → 在的话走截断路径，通用路径根本没被用到
 *   · inlineWasm.hit   内嵌 wasm 是否还在 → 不在说明客户端把 wasm 拆成外链了，要新增读取路径
 *   · missing          通用提取缺哪几个特征 → 决定是放宽正则还是改结构
 */
function probe(product) {
  const loc = locate(product);
  if (!loc) {
    return {
      product,
      installed: false,
      message:
        "客户端未安装，或 resources 目录未定位到（可用 AGENTHUB_QODER_RESOURCES / AGENTHUB_QODER_INTL_RESOURCES 直接指定 resources 目录）",
    };
  }
  const st = fs.statSync(loc.obf);
  const text = fs.readFileSync(loc.obf, "utf8");
  const entryAt = text.indexOf(ENTRY_MARK);
  const wasmAt = text.indexOf(WASM_MAGIC);
  const features = pickByStructure(text);
  const missing = REQUIRED_FEATURES.filter((k) => !features[k]);
  const bootstrap = findWorkerBootstrap(text);
  return {
    product,
    installed: true,
    version: loc.version,
    sdk: loc.sdk,
    obf: loc.obf,
    obfSize: st.size,
    obfMtime: new Date(Math.floor(st.mtimeMs)).toISOString(),
    entryMark: { mark: ENTRY_MARK, hit: entryAt >= 0, offset: entryAt },
    inlineWasm: { magic: WASM_MAGIC, hit: wasmAt >= 0, offset: wasmAt },
    workerBootstrap: bootstrap ? { anchor: bootstrap.anchor, kind: bootstrap.kind, offset: bootstrap.at, fromEnd: bootstrap.fromEnd } : null,
    features,
    missing,
    path: entryAt >= 0 ? "截断路径（入口标记命中）" : missing.length ? "两条路径均失败" : "通用路径（结构提取成功，末尾入口已中和）",
    snippets: probeSnippets(text, entryAt),
  };
}

/** 取特征附近的短片段（客户端混淆代码，不含任何用户数据），供适配时比对结构 */
function probeSnippets(text, entryAt) {
  const near = (re) => {
    const m = text.match(re);
    return m ? text.slice(Math.max(0, m.index - 80), m.index + 220) : "";
  };
  return {
    wasmDecl: near(/([A-Za-z_$][\w$]*)=["'`]AGFzbQEAAAA/),
    wasmLoader: near(/,\s*([A-Za-z_$][\w$]*)=b\(\(\)=>\{[A-Za-z_$][\w$]*=["'`]AGFzbQEAAAA/),
    erCall: near(/er\(([A-Za-z_$][\w$]*),\s*\{[^{}]{0,800}?QoderContext:\(\)=>/),
    profileEnc: near(/ProfileEncryptor:\(\)=>([A-Za-z_$][\w$]*)/),
    entryMark: entryAt < 0 ? "" : text.slice(Math.max(0, entryAt - 160), entryAt + 160),
  };
}

module.exports = { locate, available, createSession, describe, probe, installResources, buildPatchedModule, patchText, pickByStructure, findWorkerBootstrap, findBundledModule };
