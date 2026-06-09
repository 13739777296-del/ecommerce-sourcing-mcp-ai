import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profileSummary } from "./accounts.js";
import { closeManagedChromeSessions, openChromeSession } from "./chrome.js";
import { buildSearchResultUrl, searchWithBrowserAgent, SelectionFlowError } from "./browser-selection.js";

const sessions = new Map();

export async function runAiBrowserAction(ctx, db, input = {}) {
  const action = String(input.action || "observe").trim();
  const platform = normalizePlatform(input.platform || "jd");
  if (action === "close" && !input.accountId) {
    let closed = 0;
    for (const key of [...sessions.keys()].filter((item) => item.startsWith(`${platform}:`))) {
      await closeSession(key);
      closed += 1;
    }
    closed += await closeManagedChromeSessions();
    return {
      ok: true,
      action,
      platform,
      accountId: "",
      message: `AI 浏览器和选品任务保留的受控 Chrome 会话已关闭 ${closed} 个。`
    };
  }

  const account = pickBrowserAccount(ctx, db, platform, input.accountId);
  const key = `${platform}:${account.id}`;

  if (action === "close") {
    await closeSession(key);
    const managedClosed = await closeManagedChromeSessions(account.profileDir);
    return {
      ok: true,
      action,
      platform,
      accountId: account.id,
      message: managedClosed > 0 ? "AI 浏览器会话和该账号保留的选品 Chrome 会话已关闭。" : "AI 浏览器会话已关闭。"
    };
  }

  const session = await ensureSession(key, account, input.url);
  const page = session.page;
  try {
    if (action === "open") {
      if (input.url) {
        await page.goto(String(input.url), { waitUntil: "domcontentloaded", timeout: 60000 });
      } else if (input.keyword) {
        await page.goto(buildSearchResultUrl(platform, input.keyword), { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(1200).catch(() => undefined);
    } else if (action === "search") {
      if (!input.keyword) throw new SelectionFlowError("search 动作需要 keyword。", "technical", "invalid_input");
      await searchWithBrowserAgent(page, platform, String(input.keyword));
    } else if (action === "click") {
      await clickBySelectorOrText(page, input);
    } else if (action === "type") {
      if (!input.text) throw new SelectionFlowError("type 动作需要 text。", "technical", "invalid_input");
      await typeIntoSelectorOrFocused(page, input);
    } else if (action === "press") {
      await page.keyboard.press(String(input.key || "Enter"));
    } else if (action === "screenshot") {
      // No-op action: the standard post-action vision snapshot below performs the capture.
    } else if (action !== "observe") {
      throw new SelectionFlowError(`未知 AI 浏览器动作：${action}`, "technical", "invalid_input");
    }

    await page.waitForTimeout(900).catch(() => undefined);
    return {
      ok: true,
      action,
      platform,
      accountId: account.id,
      ...(await captureVisionSnapshot(ctx, page, platform, input.label || `${platform}-${action}`))
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const snapshot = await captureVisionSnapshot(ctx, page, platform, input.label || `${platform}-${action}-失败`).catch(() => ({
      observation: null,
      screenshotPath: "",
      vision: {
        required: true,
        status: "failed",
        instruction: "本步操作后截图失败，请暂停并重新观察页面。"
      }
    }));
    return {
      ok: false,
      action,
      platform,
      accountId: account.id,
      message,
      ...snapshot
    };
  }
}

export async function closeAllAiBrowserSessions() {
  for (const key of [...sessions.keys()]) {
    await closeSession(key);
  }
  await closeManagedChromeSessions();
}

async function ensureSession(key, account, initialUrl = "") {
  const existing = sessions.get(key);
  if (existing?.page && !existing.page.isClosed()) return existing;
  if (existing) await closeSession(key);
  const session = await openChromeSession(account.profileDir, initialUrl || "about:blank");
  sessions.set(key, session);
  return session;
}

async function closeSession(key) {
  const session = sessions.get(key);
  sessions.delete(key);
  await session?.close?.().catch(() => undefined);
}

function pickBrowserAccount(ctx, db, platform, accountId) {
  profileSummary(ctx, db);
  const accounts = db.listAccounts(platform).filter((account) => account.status === "available");
  const explicit = accountId ? accounts.find((account) => account.id === accountId) : null;
  const account = explicit || accounts[0];
  if (!account) {
    throw new SelectionFlowError(`${platform === "jd" ? "京东" : "淘宝"}没有可用账号，请先检查账号池。`, "login", "login_expired");
  }
  return account;
}

function normalizePlatform(platform) {
  const value = String(platform || "").toLowerCase();
  if (value === "taobao" || value === "tb") return "taobao";
  return "jd";
}

async function clickBySelectorOrText(page, input) {
  if (input.selector) {
    await page.locator(String(input.selector)).first().click({ timeout: 8000 });
    return;
  }
  const text = String(input.text || input.label || "").trim();
  if (!text) throw new SelectionFlowError("click 动作需要 selector 或 text。", "technical", "invalid_input");
  const locator = page.getByText(text, { exact: false }).first();
  await locator.click({ timeout: 8000 });
}

async function typeIntoSelectorOrFocused(page, input) {
  const text = String(input.text || "");
  if (input.selector) {
    const locator = page.locator(String(input.selector)).first();
    await locator.click({ timeout: 8000 });
  }
  for (const char of text) {
    await page.keyboard.type(char, { delay: /[a-zA-Z0-9]/.test(char) ? 45 : 85 });
  }
}

async function observePage(page, platform) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const viewport = page.viewportSize();
  const pageText = await page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
  const elements = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
    };
    const selectorFor = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const attr = ["data-testid", "data-spm", "name", "aria-label", "placeholder"]
        .map((name) => [name, element.getAttribute(name)])
        .find(([, value]) => value && String(value).length <= 48);
      if (attr) return `${element.tagName.toLowerCase()}[${attr[0]}="${String(attr[1]).replaceAll('"', '\\"')}"]`;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
        const tag = node.tagName.toLowerCase();
        const siblings = Array.from(node.parentElement?.children || []).filter((item) => item.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    return Array.from(document.querySelectorAll("input, textarea, button, a, [role='button'], [contenteditable='true']"))
      .filter(visible)
      .slice(0, 80)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("value") || "").replace(/\s+/g, " ").trim();
        return {
          tag: element.tagName.toLowerCase(),
          selector: selectorFor(element),
          text: text.slice(0, 80),
          href: element.href || "",
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
  }).catch(() => []);
  return {
    platform,
    title,
    url,
    viewport,
    textSample: pageText.replace(/\s+/g, " ").trim().slice(0, 1200),
    elements
  };
}

async function saveAiBrowserScreenshot(ctx, page, label) {
  const dir = join(ctx?.dataDir || process.cwd(), "ai-browser-screenshots");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(label)}.png`);
  await page.screenshot({ path: filePath, fullPage: false, timeout: 8000 });
  return filePath;
}

async function captureVisionSnapshot(ctx, page, platform, label) {
  const observation = await observePage(page, platform);
  const screenshotPath = await saveAiBrowserScreenshot(ctx, page, label);
  return {
    observation,
    screenshotPath,
    vision: {
      required: true,
      status: "ready",
      instruction: [
        "必须先用多模态模型识别截图。",
        "再用 observation.textSample、observation.elements、URL 和页面标题交叉验证。",
        "商品 SKU、最小规格单价、已售数量、发货时效等关键字段不能只依赖 DOM 或代码抽取。"
      ].join(" ")
    }
  };
}

function safeName(value) {
  return String(value || "screenshot").replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-").slice(0, 80) || "screenshot";
}
