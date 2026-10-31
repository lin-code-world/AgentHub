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
import { createApp } from "vue";
import { createPinia } from "pinia";
import { isElectron } from "./api/ipc";
import { probeCaps } from "./api/caps";
import { clearLegacyToken, hasSession } from "./api/adminCrypto";
// 服务式 API 不经模板渲染，插件接管不到它们的样式：全库只用到这两个（② 段重数）。
// 中文 locale 的注入点随全量注册一起没了，改由 App.vue 的 <el-config-provider> 承接。
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
// Phosphor 子集：只保留全库真正用到的 98 条字形规则（全量 1530 条 / 82 KB）
// 图标增删后重跑 node tools/gen-phosphor-subset.cjs 再生成
import "./assets/phosphor/phosphor-used.css";
import "./styles/global.css";
import "./styles/element.css";

const app = createApp(App);
app.use(createPinia());

// 启动形态二选一：Electron 直接挂载（IPC）；浏览器先探测网关托管（有后端走 RPC，
// 无本地会话或会话已过期先挂登录页）。
async function bootstrap() {
  if (isElectron()) {
    app.mount("#app");
    return;
  }
  const caps = await probeCaps();
  // 升级残留清理（I4）：网页控制台改用 ECDH 会话后不再需要明文令牌，探测到托管形态即无条件删掉
  // 旧键——不等一次成功登录才删（那时令牌已经在浏览器里躺了整个升级周期）。
  if (caps) clearLegacyToken();
  // 浏览器里探测不到托管后端 = 这不是网页控制台（比如随手用浏览器打开了页面）：
  // 直接给出提示，不挂载主界面（已经没有假数据兜底，挂上去每个命令都会报错）
  if (!caps) {
    const host = document.getElementById("app");
    if (host) host.innerHTML = '<div style="padding:48px;font-family:system-ui;color:#aab5c1;line-height:1.9">' + "<b>未连接到 AgentApiGateway 后端</b><br />请在本机启动应用后，通过「设置 · 局域网访问」里给出的地址打开网页控制台。" + "</div>";
    return;
  }
  const authed = hasSession();
  if (!authed) {
    const { default: WebLogin } = await import("./views/WebLogin.vue");
    createApp(WebLogin).mount("#app");
    return;
  }
  app.mount("#app");
}
void bootstrap();
