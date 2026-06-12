import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openChromeSession } from "./chrome.js";

const LEGACY_APP_ROOT = join(homedir(), "Library", "Application Support", "电商选品智能体");
const LEGACY_PROFILE_ROOT = join(LEGACY_APP_ROOT, "browser-profiles", "accounts");

const KNOWN_ACCOUNTS = [
  { id: "0b8e87b1-d8c1-4910-a176-e0aa474576f7", platform: "jd", displayName: "京东账号一" },
  { id: "403478cb-a4e1-47e6-9e18-ed3fa1fb6597", platform: "jd", displayName: "京东账号二" },
  { id: "85196a47-9964-4811-bedd-5fc8f5a57f96", platform: "taobao", displayName: "淘宝账号一" }
];

export function resolveLegacyProfileRoot(ctx) {
  const configured = String(ctx?.config?.get?.("legacyProfileRoot") || "").trim();
  if (configured) return configured;
  return LEGACY_PROFILE_ROOT;
}

export function discoverLegacyAccounts(ctx) {
  const root = resolveLegacyProfileRoot(ctx);
  return KNOWN_ACCOUNTS.map((account) => ({
    ...account,
    profileDir: join(root, account.platform, account.id),
    status: existsSync(join(root, account.platform, account.id)) ? "available" : "missing"
  }));
}

export function pickAccount(ctx, db, platform) {
  const accounts = db.listAccounts(platform).filter((account) => account.status === "available");
  if (accounts.length > 0) return accounts[0];
  const discovered = discoverLegacyAccounts(ctx).find((account) => account.platform === platform && account.status === "available");
  if (!discovered) {
    throw new Error(`${platform === "jd" ? "京东" : "淘宝"}没有可用账号 profile，请先确认旧项目账号目录存在并完成登录。`);
  }
  db.upsertAccount(discovered);
  return discovered;
}

export function profileSummary(ctx, db) {
  const discovered = discoverLegacyAccounts(ctx);
  for (const account of discovered) db.upsertAccount(account);
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
    newPage: true,
    closeOtherPages: false
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
  return join(ctx?.dataDir || join(homedir(), ".ecommerce-sourcing-agent"), "browser-profiles", "accounts", platform, id);
}

function statusEvent(status) {
  if (status === "available") return "账号已启用。";
  if (status === "paused") return "账号已停用。";
  if (status === "login_required") return "账号需要重新登录。";
  return `账号状态已更新：${status}`;
}
