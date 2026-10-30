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
// 应用级状态：配置（主题 / 动效）、当前模块与子页面
import { defineStore } from "pinia";
import { MODULES } from "../types";
import { moduleEnabled } from "../api/caps";
import type { AppConfig, SettingsTab, ModuleDef, ModuleKey, PageDef } from "../types";
import * as api from "../api/ipc";

/** 递归合并：以 base 为基线补全 patch 缺失的嵌套字段；数组与原始值一律整体取 patch（有则覆盖）。
 *  用途：后端返回的配置一旦缺某个嵌套字段（旧版后端 / 字段重命名 / mock 未同步），浅合并会让
 *  模板访问形如 proxy.creditsRefreshMin 时直接抛错白屏——这里保证任何层级都有 defaultConfig 兜底。 */
function mergeConfigDeep<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base && typeof base === "object" && patch && typeof patch === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(patch as Record<string, unknown>)) {
      out[key] = mergeConfigDeep((base as Record<string, unknown>)[key], (patch as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return patch === undefined ? base : (patch as T);
}

// 浏览器 mock / 后端加载失败时的兜底默认值；后端权威默认值见 electron/backend/config.cjs
const defaultConfig: AppConfig = {
  theme: "dark",
  admin: { token: "" },
  schedule: { minimizeToTray: true, autoStart: false },
  // 反代网关设置兜底（权威默认值见 electron/backend/config.cjs）
  proxy: {
    port: 9527,
    bind: "127.0.0.1",
    routeStrategy: "smart",
    fixedChannel: "trae",
    routeOrder: "score",
    rateLimitPerMin: 120,
    concurrency: 8,
    creditsRefreshMin: 30,
    usageRetentionDays: 90,
    expiringSoonDays: 1,
    debugStatus: false,
    modelOverrides: {},
    humanizeJitter: true,
    disabledModels: [],
    modelFallback: {},
    modelReverseAliases: {},
    modelCustom: {},
    modelCustomByChannel: {},
    autoFallbackEnabled: true,
    checkinAutoRules: {},
    fallbackModel: "",
    channelFailover: true,
    channelFailoverMax: 3,
    channelCooldownMs: 120000,
    channelCooldownCapMs: 900000,
    channelEnabled: {},
  },
};

// ===== 界面位置镜像（关窗销毁渲染进程所必需）=====
// 关窗会销毁整个渲染进程，Pinia 里的 activeModule/activePage 随之丢失。
// 若不落盘，用户每次唤回界面都会回到默认页 —— 等于每次关窗都把"我刚才在看哪"清一次。
// 用 localStorage 而非新增 IPC：渲染层自己记住即可，
// 不必让主进程参与，Web/容器端（NAS）也不受影响。
const PAGE_MIRROR_KEY = "agenthub.lastPage";

function mirrorPage(moduleKey: string, pageId: string) {
  try {
    localStorage.setItem(PAGE_MIRROR_KEY, JSON.stringify({ module: moduleKey, id: pageId }));
  } catch {
    /* 写不进只影响下次恢复位置：忽略 */
  }
}

function readMirroredPage(): { module: string; id: string } | null {
  try {
    const raw = localStorage.getItem(PAGE_MIRROR_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.module === "string" && typeof v.id === "string") {
      return { module: v.module, id: v.id };
    }
  } catch {
    /* 解析失败按没有处理 */
  }
  return null;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    activeModule: MODULES[0].key as ModuleKey,
    activePage: MODULES[0].pages[0].id,
    // ===== 全局设置弹窗（左下角设置按钮）：通用 / 刷新周期 / 局域网访问 =====
    settingsOpen: false,
    settingsTab: "general" as SettingsTab,
    /** 左栏容器收缩态：收起后主区占满，入口留在页签条最左（状态本机记住） */
    sideCollapsed: (() => {
      try {
        return localStorage.getItem("agenthub.sideCollapsed") === "1";
      } catch {
        return false;
      }
    })(),
    /** 模块配置页（各模块右上「配置」按钮切换，id=config）：进入前所在的子页面，完成时回去 */
    pageBeforeConfig: "",
  }),
  getters: {
    isDark: (s) => s.config.theme === "dark",
    moduleOf: () => (key: ModuleKey): ModuleDef => MODULES.find((m) => m.key === key) || MODULES[0],
    /** 左栏模块列表：Web 托管形态按服务端能力清单裁剪（容器版只有 proxy），桌面全量 */
    orderedModules(): ModuleDef[] {
      return MODULES.filter((m) => moduleEnabled(m.key));
    },
    /** 当前模块的子页面：全量返回（MODULES 是唯一事实源） */
    pagesOf(s): PageDef[] {
      return this.moduleOf(s.activeModule).pages;
    },
    /** 子页面徽标：各模块子页的静态兜底值（PageDef.badge） */
    pageBadge(s): (pageId: string) => string | undefined {
      return (pageId: string) => this.moduleOf(s.activeModule).pages.find((p) => p.id === pageId)?.badge;
    },
  },
  actions: {
    async load() {
      try {
        // 深合并而非 Object.assign（浅合并会把 proxy 等嵌套对象整体替换，后端一旦缺字段即白屏）
        const remote = await api.loadConfig();
        Object.assign(this.config, mergeConfigDeep(structuredClone(defaultConfig), remote));
      } catch {
        this.config = JSON.parse(JSON.stringify(defaultConfig));
      }
      // 启动默认板块：左栏第一个板块，页面取其第一个子页
      const first = this.orderedModules[0];
      if (first) {
        this.activeModule = first.key;
        this.activePage = first.pages[0].id;
      }
      // 恢复上次停留的页面（关窗销毁界面后唤回时，用户应回到原处而不是默认页）。
      // 只在模块与页面都仍然合法时恢复 —— 模块集合可能随版本变化，
      // 失效就静默回落到上面的默认位置。
      const mirrored = readMirroredPage();
      if (mirrored) {
        const mod = this.orderedModules.find((m) => m.key === mirrored.module);
        if (mod && this.moduleOf(mod.key).pages.some((p) => p.id === mirrored.id)) {
          this.activeModule = mod.key;
          this.activePage = mirrored.id;
        }
      }
      this.applyTheme(this.config.theme);
      this.loaded = true;
    },
    async save() {
      try {
        return await api.saveConfig(this.config);
      } catch (e) {
        // 保存失败不抛断：设置弹窗内的表单区有自己的错误展示
        console.warn("配置保存失败", e);
        return { ok: false, message: String((e as Error).message || e) };
      }
    },
    applyTheme(theme: "dark" | "light") {
      this.config.theme = theme;
      document.documentElement.setAttribute("data-theme", theme);
      // Element Plus 的暗色方案认 html.dark，跟应用主题一起切
      document.documentElement.classList.toggle("dark", theme === "dark");
    },
    toggleTheme() {
      this.applyTheme(this.isDark ? "light" : "dark");
      this.save();
    },
    /** 设置弹窗里的外观切换（与侧栏亮暗按钮同源） */
    setTheme(theme: "dark" | "light") {
      if (this.config.theme === theme) return;
      this.applyTheme(theme);
      this.save();
    },
    /** 把当前停留位置写进 localStorage 镜像（关窗销毁界面后唤回时据此恢复）。
     *  由 App.vue 的「loaded + 当前位置」watcher 调用，故只在配置加载完成、位置已定后记录。 */
    mirrorActivePage() {
      mirrorPage(this.activeModule, this.activePage);
    },
    /** 重拉配置到内存快照：main 侧托盘等直写配置后经 app:event 广播，渲染层据此刷新。
     *  与 load() 的区别：不动 activeModule/activePage（重拉不能把用户从当前页拽走）。 */
    async refreshConfig() {
      try {
        const remote = await api.loadConfig();
        Object.assign(this.config, mergeConfigDeep(structuredClone(defaultConfig), remote));
      } catch {
        /* 拉取失败保留当前快照 */
      }
      this.applyTheme(this.config.theme);
    },
    /** 打开全局设置弹窗：tab 缺省保持当前模块；左下角齿轮给 general，跨模块入口给 timing 等 */
    openSettings(tab?: SettingsTab) {
      if (tab) this.settingsTab = tab;
      this.settingsOpen = true;
    },
    closeSettings() {
      this.settingsOpen = false;
    },
    /** 右上「配置」按钮：切到当前模块的配置页（与左侧 tab 同一套页面切换逻辑，记住来时页） */
    openModuleConfig() {
      if (this.activePage === "config") return;
      this.pageBeforeConfig = this.activePage;
      this.settingsOpen = false;
      this.activePage = "config";
    },
    /** 配置页点「完成」：回到进配置前的子页面（来路失效则回模块第一页） */
    closeModuleConfig() {
      const pages = this.moduleOf(this.activeModule).pages;
      const back = this.pageBeforeConfig && pages.some((p) => p.id === this.pageBeforeConfig) ? this.pageBeforeConfig : pages[0].id;
      this.pageBeforeConfig = "";
      this.activePage = back;
    },
    /** 切换大模块：默认进入其第一个子页面；点模块卡 = 离开设置弹窗与配置页 */
    selectModule(key: ModuleKey) {
      this.settingsOpen = false;
      this.pageBeforeConfig = "";
      if (this.activeModule === key) return;
      this.activeModule = key;
      this.activePage = this.moduleOf(key).pages[0].id;
    },
    setPage(id: string) {
      this.settingsOpen = false;
      this.activePage = id;
    },
    /** 左栏收缩/展开：状态本机记住（与页面镜像同款 localStorage 方案） */
    toggleSideCollapsed() {
      this.sideCollapsed = !this.sideCollapsed;
      try {
        localStorage.setItem("agenthub.sideCollapsed", this.sideCollapsed ? "1" : "0");
      } catch {
        /* 写不进只影响下次冷启动 */
      }
    },
  },
});
