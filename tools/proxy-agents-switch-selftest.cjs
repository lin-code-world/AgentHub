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
// 号池页顶部渠道切换（一排名称胶囊）的静态契约自测。
// 这一层不依赖 Electron 窗口，只锁住「改版后不能退回去」的几件事：
//   ① 形态就是「一排横向滚动的名称胶囊」——be40435 起移除了旧的收起/展开两形态与展开箭头，
//      「添加账号」移到渠道行右侧常驻，所以这里同时钉住「旧的折叠态不再出现」；
//   ② 行高与胶囊尺寸各由一个 token 推导，不再各自漂移；
//   ③ 胶囊直接显示渠道名（图标另用于添加账号弹窗的渠道下拉，不在这一层）；
//   ④ 一行不成高/不出宽的结构约束（定高 + 横向滚动 + 胶囊固定不收缩 + 右侧按钮常驻）。
// 真实渲染（像素级高度、点击切换）另由 Electron 探针验证，这里只守源码契约。
// 用法：node tools/proxy-agents-switch-selftest.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VIEW = path.join(ROOT, "src", "views", "proxy", "ProxyAgentsView.vue");
const ICONS = path.join(ROOT, "src", "views", "proxy", "channelIcons.ts");
const UPSTREAM = path.join(ROOT, "src", "components", "ProxyUpstreamDialog.vue");

let pass = 0;
let fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}

const view = fs.readFileSync(VIEW, "utf8");
const icons = fs.readFileSync(ICONS, "utf8");
const upstream = fs.readFileSync(UPSTREAM, "utf8");

// ---- ① 形态：一排名称胶囊（旧的收起 / 展开两形态已下线） ----
ok("顶部切换是一行容器 .ch-switch（胶囊区 + 右侧「添加账号」）", /class="ch-switch"/.test(view));
ok("有独立胶囊行 .ch-strip", /class="ch-strip"/.test(view));
ok("胶囊区自成一个横向滚动容器 .ch-strip-list", /class="ch-strip-list"/.test(view));
ok("只列有账号的渠道（空号池没有浏览价值）", /switchableChannels = computed\(\(\) => pool\.value\.filter\(\(c\) => \(c\.summary\?\.accountCount \?\? 0\) > 0\)/.test(view));
// 回归守卫：be40435 已移除的折叠状态与展开箭头不得再被引入（引入即退回旧的两形态）
ok("旧的收起/展开折叠状态（switcherCollapsed）不再出现", !/switcherCollapsed/.test(view));
ok("旧的展开箭头方块（ch-sq-arrow）不再出现", !/ch-sq-arrow/.test(view));

// ---- ② 高度 / 尺寸 token（行高 40 / 胶囊 30） ----
const stripH = view.match(/--ch-strip-h:\s*(\d+)px/);
const chipH = view.match(/--ch-sq:\s*(\d+)px/);
ok("定义了渠道行高度 token --ch-strip-h", !!stripH, stripH ? stripH[0] : "missing");
ok("定义了胶囊尺寸 token --ch-sq", !!chipH, chipH ? chipH[0] : "missing");
ok("渠道行是「固定高度」（height 而不是 min-height）", /\.ch-strip\s*\{[^}]*height:\s*var\(--ch-strip-h\)/s.test(view));
ok("胶囊高度吃同一个 token（行高与胶囊不会各自漂移）", /\.ch-chip\s*\{[^}]*height:\s*var\(--ch-sq\)/s.test(view));
if (stripH && chipH) {
  const h = Number(stripH[1]);
  const s = Number(chipH[1]);
  ok("行高大于胶囊高度（胶囊在行内上下留白，不顶格）", h > s, `strip=${h} chip=${s}`);
}

// ---- ③ 胶囊内容与首字母回落 ----
ok("胶囊直接渲染渠道名（display 优先，回落静态名表）", /class="ch-chip-name">\{\{\s*ch\.display \|\| channelName\(ch\.id\)\s*\}\}/.test(view));
ok("首字母函数优先用服务端 display（与卡片同名，不各叫各的）", /display \|\| channelName\(id\)/.test(icons));
ok("图标映射是单一来源（上游启闭弹窗复用同一份，不各存一张表）", /from "\.\.\/views\/proxy\/channelIcons"/.test(upstream) && !/import traeIcon from/.test(upstream));
ok("图标映射按渠道 id 提供（覆盖内置渠道）", /trae:\s*traeIcon/.test(icons) && /zcode:\s*zcodeIcon/.test(icons));

// ---- ④ 一行不成高 / 不出宽 ----
ok("胶囊区横向滚动（胶囊多了不换行、不撑高）", /\.ch-strip-list\s*\{[^}]*overflow-x:\s*auto/s.test(view));
ok("胶囊区纵向被裁掉（overflow-y: hidden 锁死行高）", /\.ch-strip-list\s*\{[^}]*overflow-y:\s*hidden/s.test(view));
ok("胶囊不参与收缩（flex: 0 0 auto，多了靠横向滚动而不是挤扁）", /\.ch-chip\s*\{[^}]*flex:\s*0 0 auto/s.test(view));
ok("方形基础盒保持正方形（aspect-ratio: 1）", /\.ch-sq\s*\{[^}]*aspect-ratio:\s*1/s.test(view));
ok("方形基础盒有收缩下限（不会缩成看不清的小条）", /\.ch-sq\s*\{[^}]*min-width:\s*\d+px/s.test(view));
ok("右侧「添加账号」常驻不被胶囊挤出（flex-shrink: 0）", /\.ch-add\s*\{[^}]*flex-shrink:\s*0/s.test(view));
ok("「添加账号」在号池为空时置灰", /class="btn btn-primary ch-add"[^>]*:disabled="!pool\.length"/.test(view));

// ---- 交互 ----
ok("点胶囊即切换渠道（复用 activeChannel）", /class="ch-sq ch-chip"[\s\S]{0,400}@click="activeChannel = ch\.id"/.test(view));
ok("选中态由 activeChannel 驱动（含 aria-pressed，辅助技术可读）", /class="ch-sq ch-chip"[\s\S]{0,200}?aria-pressed="activeChannel === ch\.id"/.test(view));
ok("每个胶囊有悬浮提示（胶囊只写名称，可用数与降级靠悬浮补充）", /function stripTip\(ch: ProxyChannelView\)/.test(view));
ok("悬浮提示包含可用数与降级倒计时", /accountCount \? `\$\{ch\.summary\.onlineCount\}\/\$\{ch\.summary\.accountCount\} 可用`/.test(view) && /降级 \$\{channelCoolLeft\(ch\)\}/.test(view));
ok("降级中的渠道在胶囊上有红点提示", /class="ch-sq-dot"/.test(view));
ok("切换条有加载 / 失败 / 无渠道三态占位", /class="ch-strip-empty"/.test(view));
ok("两处入口共用同一个选中渠道（点胶囊不影响下方列表结构）", (view.match(/activeChannel/g) || []).length > 6);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  bad.forEach((b) => console.log("  - " + b));
  process.exit(1);
}
