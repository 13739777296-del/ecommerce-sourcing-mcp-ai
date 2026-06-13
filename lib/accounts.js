import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openChromeSession } from "./chrome.js";

// 产品标准数据目录：账号 profile、选品库、导出都收口到这里。
const DEFAULT_DATA_ROOT = join(homedir(), ".ecommerce-sourcing-agent");
const DEFAULT_PROFILE_ROOT = join(DEFAULT_DATA_ROOT, "browser-profiles", "accounts");

// 账号一律由用户自己 account_add 添加；仓库不内置任何真实账号。
// 仅为老用户保留一个可选的本地迁移入口：在数据目录放 legacy-accounts.json
// （[{ id, platform, displayName }]，git 忽略），或用环境变量 ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT
// 指定旧 profile 根目录，才会去发现老账号；默认没有这些配置时返回空，账号池从空开始。
function loadLegacyAccountDefs(root) {
  const file = join(root, "legacy-accounts.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.id && item.platform)
      .map((item) => ({
        id: String(item.id),
        platform: normalizePlatform(item.platform),
        displayName: String(item.displayName || `${item.platform === "jd" ? "京东" : "淘宝"}账号`)
      }));
  } catch {
    return [];
  }
}

// 风控封控冷却：第一次封控歇 3 小时，第二次及以后歇 5 小时。
// 封控不是永久的——歇够时间后重新探测，登录态还在就恢复使用，避免一个账号被永久弃用。
export const COOLDOWN_FIRST_MS = 3 * 60 * 60 * 1000;
export const COOLDOWN_REPEAT_MS = 5 * 60 * 60 * 1000;

/** 按累计封控次数返回该次冷却时长（毫秒）：首次 3h，第二次起 5h。 */
export function cooldownMsForPauseCount(pauseCount) {
  const n = Number(pauseCount) || 0;
  return n >= 2 ? COOLDOWN_REPEAT_MS : COOLDOWN_FIRST_MS;
}

/**
 * 计算某账号的冷却状态。
 * @param {{status?: string, pausedAt?: string|null, pauseCount?: number}} account
 * @param {number} now 当前时间戳（毫秒），默认 Date.now()
 * @returns {{cooling: boolean, readyAt: number|null}} cooling=是否仍在冷却期；readyAt=可重试的时间戳
 */
export function accountCooldownState(account, now = Date.now()) {
  if (!account || account.status !== "paused" || !account.pausedAt) {
    return { cooling: false, readyAt: null };
  }
  const pausedAtMs = Date.parse(account.pausedAt);
  if (Number.isNaN(pausedAtMs)) return { cooling: false, readyAt: null };
  const readyAt = pausedAtMs + cooldownMsForPauseCount(account.pauseCount);
  return { cooling: now < readyAt, readyAt };
}

export function resolveLegacyProfileRoot(ctx) {
  const configured = String(ctx?.config?.get?.("legacyProfileRoot") || "").trim();
  if (configured) return configured;
  return DEFAULT_PROFILE_ROOT;
}

export function discoverLegacyAccounts(ctx) {
  const root = resolveLegacyProfileRoot(ctx);
  const defs = loadLegacyAccountDefs(ctx?.dataDir || DEFAULT_DATA_ROOT);
  if (defs.length === 0) return [];
  return defs.map((account) => ({
    ...account,
    profileDir: join(root, account.platform, account.id),
    status: existsSync(join(root, account.platform, account.id)) ? "available" : "missing"
  }));
}

export function pickAccount(ctx, db, platform) {
  const accounts = db.listAccounts(platform).filter((account) => account.status === "available");
  if (accounts.length > 0) {
    // 轮换：选最久未用的（updated_at 最早）；时间戳相同时按 id 兜底，保证排序确定、轮换稳定。
    const picked = [...accounts].sort((a, b) =>
      String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || String(a.id).localeCompare(String(b.id))
    )[0];
    if (typeof db.touchAccount === "function") db.touchAccount(picked.id);
    return picked;
  }
  const discovered = discoverLegacyAccounts(ctx).find((account) => account.platform === platform && account.status === "available");
  if (!discovered) {
    throw new Error(`${platform === "jd" ? "京东" : "淘宝"}没有可用账号，请先用 account_add 添加账号并 account_login 扫码登录。`);
  }
  db.upsertAccount(discovered);
  return discovered;
}

export function profileSummary(ctx, db) {
  // 迁移发现只用于"补充 DB 里还没有的老账号"。DB 一旦有这个账号就以 DB 为准，
  // 绝不用发现结果覆盖已有账号的状态/profile 路径（否则发现侧探测到的 missing 会把
  // 数据库里 available/paused 的真实状态冲掉，profile_dir 也会被改到错的根目录）。
  const existingIds = new Set(db.listAccounts().map((a) => a.id));
  const discovered = discoverLegacyAccounts(ctx);
  for (const account of discovered) {
    if (existingIds.has(account.id)) continue;
    db.upsertAccount(account);
  }
  return db.listAccounts();
}

export function createAccount(ctx, db, input = {}) {
  const platform = normalizePlatform(input.platform);
  const displayName = String(input.displayName || `${platform === "jd" ? "京东" : "淘宝"}账号`).trim();
  const id = String(input.id || randomUUID()).trim();
  if (!displayName) throw new Error("新增账号需要 displayName。");
  const profileDir = String(input.profileDir || defaultAccountProfileDir(ctx, platform, id)).trim();
  const account = {
    id,
    platform,
    displayName,
    profileDir,
    status: input.status || "login_required",
    lastEvent: "账号已创建，请打开登录页扫码登录。"
  };
  db.upsertAccount(account);
  return db.getAccount(id) || account;
}

export function setAccountStatus(db, id, status, event = "") {
  const account = db.getAccount(id);
  if (!account) throw new Error(`账号不存在：${id}`);
  db.updateAccount(id, status, event || statusEvent(status));
  return db.getAccount(id);
}

export function removeAccount(db, id) {
  const account = db.getAccount(id);
  if (!account) throw new Error(`账号不存在：${id}`);
  db.deleteAccount(id);
  return account;
}

export function accountLoginUrl(platform) {
  const value = normalizePlatform(platform);
  return value === "jd" ? "https://passport.jd.com/new/login.aspx" : "https://login.taobao.com/";
}

export async function probeAccountLoginStatus(account) {
  const target = account.platform === "jd" ? "https://www.jd.com/" : "https://www.taobao.com/";
  const session = await openChromeSession(account.profileDir, target, {
    keepAlive: true,
    newPage: false,
    closeOtherPages: true
  });
  try {
    await session.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await session.page.waitForTimeout(2000);
    const url = session.page.url();
    const title = await session.page.title().catch(() => "");
    const text = await session.page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
    if (/passport\.jd\.com|login\.taobao\.com|login\.tmall\.com|login\.jd\.com/i.test(url)) {
      return { status: "login_required", event: "页面跳转到登录页" };
    }
    if (/验证码|滑块|安全验证|访问频繁|账号异常|环境异常/i.test(text)) {
      return { status: "paused", event: "页面出现安全验证或风险提示" };
    }
    if (/请登录|亲，请登录|扫码登录|账号登录|密码登录/.test(`${title}\n${text}`)) {
      return { status: "login_required", event: "首页显示未登录入口" };
    }
    return { status: "available", event: "首页可访问，未发现明显登录失效提示" };
  } finally {
    // 不关浏览器，保持打开避免反复开闭触发风控
  }
}

export function normalizePlatform(platform) {
  const value = String(platform || "").toLowerCase();
  if (value === "taobao" || value === "tb" || value === "淘宝") return "taobao";
  if (value === "jd" || value === "jingdong" || value === "京东") return "jd";
  throw new Error("platform 只能是 jd 或 taobao。");
}

function defaultAccountProfileDir(ctx, platform, id) {
  return join(ctx?.dataDir || DEFAULT_DATA_ROOT, "browser-profiles", "accounts", platform, id);
}

function statusEvent(status) {
  if (status === "available") return "账号已启用。";
  if (status === "paused") return "账号已停用。";
  if (status === "login_required") return "账号需要重新登录。";
  return `账号状态已更新：${status}`;
}
