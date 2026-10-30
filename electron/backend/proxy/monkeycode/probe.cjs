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
// 反代网关 · MonkeyCode 建任务材料发现
//
// 建任务必须带镜像 id（任务容器的 VM 镜像 UUID），而它不属于登录态。发现顺序（从准到兜底）：
//   1. 「最近任务」列表——该账号跑过任务时上游会把镜像 id 回吐出来（最贴合本账号实际）
//   2. 「用户镜像」列表——找 remark=="devbox" 的公共镜像（新号也能拿到，已实测可用）
//   3. 内置公共 devbox 镜像常量——上面两条都取不到时兜底（上游换镜像后可能失效）
// 三条都拿不到才返回空串：调用方据此如实回 400 并说清怎么补，绝不拿空值去建任务碰运气。
"use strict";

const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");
const models = require("./models.cjs");

/** 从最近的任务列表里取第一个非空 image.id */
function firstImageId(payload) {
  const data = (payload && payload.data) || payload || {};
  const rows = Array.isArray(data.tasks) ? data.tasks : Array.isArray(payload && payload.tasks) ? payload.tasks : [];
  for (const row of rows) {
    const value = row && row.image && row.image.id;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 从用户镜像列表里取公共 devbox 镜像的 UUID：优先 remark=="devbox"，其次名字里含 devbox */
function devboxImageId(payload) {
  const data = (payload && payload.data) || payload || {};
  const rows = Array.isArray(data) ? data : Array.isArray(data.images) ? data.images : [];
  for (const row of rows) {
    const remark = String((row && row.remark) || "").trim().toLowerCase();
    if (remark === "devbox" && row && row.id) return String(row.id).trim();
  }
  for (const row of rows) {
    const name = String((row && row.name) || "").toLowerCase();
    if (name.includes("devbox") && row && row.id) return String(row.id).trim();
  }
  return "";
}

/** 本地发现一次可用的镜像 id；返回空串 = 三条路都没拿到 */
async function discoverImageId(deps, region, section, session) {
  if (!region || !String(session || "").trim()) return "";
  const base = regionStore.baseUrl(region, section);
  try {
    const payload = await models.requestJson(
      deps,
      `${base}${endpoints.TASKS_PATH}${endpoints.TASKS_DISCOVER_QUERY}`,
      session,
      section,
      region,
      "任务列表查询",
    );
    const id = firstImageId(payload);
    if (id) return id;
  } catch (e) {
    deps.verbose && deps.verbose(`镜像 id 从任务列表发现失败（继续试镜像列表）：${e.message}`);
  }
  try {
    const payload = await models.requestJson(deps, `${base}${endpoints.IMAGES_PATH}`, session, section, region, "镜像列表查询");
    const id = devboxImageId(payload);
    if (id) {
      deps.verbose && deps.verbose(`镜像 id 取自公共 devbox 镜像：${id}`);
      return id;
    }
  } catch (e) {
    deps.verbose && deps.verbose(`镜像 id 从镜像列表发现失败（回落内置兜底）：${e.message}`);
  }
  deps.verbose && deps.verbose(`镜像 id 用内置公共兜底：${endpoints.FALLBACK_DEVBOX_IMAGE_ID}`);
  return endpoints.FALLBACK_DEVBOX_IMAGE_ID;
}

module.exports = { discoverImageId, firstImageId, devboxImageId };
