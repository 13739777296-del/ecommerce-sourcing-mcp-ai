import { openChromeSession, closeManagedChromeSessions } from "./chrome.js";
import { pickAccount } from "./accounts.js";
import { detectRiskControl, waitForManualResolve, captureRiskShot } from "./risk-guard.js";
import { parseCommentCount, taobaoSelectedSkuRejectReason } from "./logic.js";
import { mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";

/**
 * AI 驱动的浏览器控制器 - 改进版
 * 使用智能元素识别，不依赖固定选择器
 * 使用正式Chrome浏览器和已登录的账号Cookie
 */

const sessions = new Map();

// 京东搜索框/按钮选择器（2026 React 版）
const SEARCH_INPUT_SELECTOR = "input.jd_pc_search_bar_react_search_input";
const SEARCH_BTN_SELECTOR = "button.jd_pc_search_bar_react_search_btn";

/**
 * 打开AI浏览器会话（使用已登录账号）
 */
export async function openAiSessionWithAccount(ctx, db, platform, initialUrl = "about:blank", accountId = null) {
  const account = accountId
    ? db.getAccount(accountId)
    : pickAccount(ctx, db, platform);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  const sessionId = `ai-${platform}-${account.id}`;

  // 检查是否已有会话
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.page && !existing.page.isClosed()) {
      console.log(`[AI] 复用已有会话: ${sessionId}`);
      const compacted = await compactSessionTabs(existing.context, existing.page, `复用${sessionId}`);
      if (compacted.page) existing.page = compacted.page;
      return {
        sessionId,
        page: existing.page,
        browser: existing.browser,
        context: existing.context,
        account
      };
    }
  }

  console.log(`[AI] 创建新会话，使用账号: ${account.displayName}`);
  console.log(`[AI] Profile目录: ${account.profileDir}`);

  // 使用正式Chrome和已登录的profile
  const session = await openChromeSession(account.profileDir, initialUrl, {
    keepAlive: true,
    newPage: true,
    closeOtherPages: true
  });

  sessions.set(sessionId, {
    ...session,
    profileDir: account.profileDir,
    account,
    createdAt: Date.now()
  });

  return {
    sessionId,
    page: session.page,
    browser: session.browser,
    context: session.context,
    account
  };
}

function createRiskControlError(message, opts = {}) {
  const error = new Error(message);
  error.code = "RISK_CONTROL";
  error.platform = opts.platform || "jd";
  error.accountId = opts.account?.id || opts.accountId || "";
  error.accountName = opts.account?.displayName || opts.accountName || "";
  error.signal = opts.signal || "";
  error.screenshotPath = opts.screenshotPath || "";
  return error;
}

/**
 * 打开AI浏览器会话（直接指定profileDir，用于测试）
 */
export async function openAiSession(profileDir, initialUrl = "about:blank") {
  const sessionId = `ai-test-${Date.now()}`;

  const session = await openChromeSession(profileDir, initialUrl, {
    keepAlive: true,
    newPage: true,
    closeOtherPages: true
  });

  sessions.set(sessionId, {
    ...session,
    profileDir,
    createdAt: Date.now()
  });

  return {
    sessionId,
    page: session.page,
    browser: session.browser,
    context: session.context
  };
}

/**
 * 收敛同一 Chrome profile 下的标签页。
 *
 * 目标是保留浏览器进程和账号 profile，不反复开关 Chrome；但每个账号会话只留
 * 一个可控工作标签，避免长任务不断堆积详情页导致电脑卡顿。
 */
export async function compactSessionTabs(context, keepPage = null, label = "浏览器会话") {
  const openPages = (context?.pages?.() || []).filter((page) => !isPageClosed(page));
  if (!openPages.length) return { closed: 0, failed: 0, kept: 0, page: null };

  const targetPage = keepPage && !isPageClosed(keepPage) ? keepPage : openPages.at(-1);
  let closed = 0;
  let failed = 0;

  for (const page of openPages) {
    if (page === targetPage || isPageClosed(page)) continue;
    try {
      await page.close({ runBeforeUnload: false });
      closed += 1;
    } catch {
      failed += 1;
    }
  }

  await targetPage?.bringToFront?.().catch(() => undefined);
  if (closed || failed) {
    console.log(`[AI] 标签页收敛(${label}): 关闭${closed}个，失败${failed}个，保留1个`);
  }

  return { closed, failed, kept: targetPage ? 1 : 0, page: targetPage };
}

function isPageClosed(page) {
  try {
    return typeof page?.isClosed === "function" ? page.isClosed() : Boolean(page?.closed);
  } catch {
    return true;
  }
}

/**
 * 京东搜索（真人节奏 + 风控守卫）
 *
 * 设计：
 * - 全程拟人：鼠标移动、拟人打字、随机停顿（5-15秒级别的真人节奏由调用方批量控制，
 *   单次内部各步之间也有随机停顿）
 * - 提交用搜索按钮，避免 Enter 被京东联想词接管，导致搜索词被替换
 * - 关键节点检测风控，触发就截图 + 通知用户手动处理（人工过验证后继续）
 * - 恢复用回退/重新导航，绝不 reload
 *
 * @param {object} page
 * @param {string} keyword
 * @param {object} opts { onNotify }
 */
export async function aiJdSearch(page, keyword, opts = {}) {
  const onNotify = opts.onNotify || ((m) => console.log(m));
  console.log(`[AI] 京东搜索: ${keyword}`);

  // 1. 如果已在京东页面有搜索框，直接搜（更像真人）；否则回首页
  const alreadyOnJD = page.url().includes('jd.com');
  const hasBox = alreadyOnJD && await page.locator(SEARCH_INPUT_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
  if (!hasBox) {
    await page.goto("https://www.jd.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[AI] 已打开京东首页`);
  } else {
    console.log(`[AI] 已在京东页面，直接搜索`);
  }
  await randomPause(1000, 2000);

  // 1.5 首页就检测一次风控（连续操作后京东常在首页拦截）
  const homeRisk = await detectRiskControl(page);
  if (homeRisk.blocked) {
    const shot = await captureRiskShot(page, "jd-home");
    onNotify(`[AI] ⚠️ 首页检测到风控（${homeRisk.signal}），截图: ${shot}`);
    const r = await waitForManualResolve(page, {
      onNotify,
      expectReady: (p) => p.locator(SEARCH_INPUT_SELECTOR).first().isVisible({ timeout: 5000 }).catch(() => false)
    });
    if (!r.resolved) {
      throw createRiskControlError("首页风控未解除，搜索中止", {
        platform: opts.platform || "jd",
        account: opts.account,
        signal: homeRisk.signal,
        screenshotPath: shot
      });
    }
  }

  // 2. 找到搜索框
  const searchBox = await aiFindSearchBox(page);
  if (!searchBox) {
    const shot = await captureRiskShot(page, "jd-nobox");
    throw new Error(`未找到搜索框（可能风控或改版），截图: ${shot}`);
  }

  // 3. 真实输入 + 点击搜索按钮。Enter 容易触发联想词，导致关键词被京东改写。
  console.log(`[AI] 输入关键词并提交: ${keyword}`);
  await submitJdSearchKeyword(page, searchBox, keyword);
  await randomPause(2000, 3500);

  // 4. 等待结果页商品卡片
  await page.waitForSelector('div[data-sku]', { timeout: 20000 }).catch(() => {});
  await randomPause(800, 1500);

  // 5. 提交后检测风控（搜索这一步最容易触发）
  const searchRisk = await detectRiskControl(page);
  if (searchRisk.blocked) {
    const shot = await captureRiskShot(page, "jd-search");
    onNotify(`[AI] ⚠️ 搜索后检测到风控（${searchRisk.signal}），截图: ${shot}`);
    const r = await waitForManualResolve(page, {
      onNotify,
      expectReady: (p) => p.locator('div[data-sku]').count().then((c) => c > 0).catch(() => false)
    });
    if (!r.resolved) {
      throw createRiskControlError("搜索风控未解除", {
        platform: opts.platform || "jd",
        account: opts.account,
        signal: searchRisk.signal,
        screenshotPath: shot
      });
    }
  }

  // 6. 搜索页状态收敛：联想词改写、首页重定向都只兜底一次，失败就报错。
  await ensureJdSearchResult(page, keyword);

  // 7. 搜品牌词时轻滚一两次，让页面懒加载；搜具体买手店时跳过，直接逐个点击。
  if (!opts.skipScroll) {
    await browseSearchResultsLightly(page, opts.scrollTimes ?? 2, "搜索结果");
  }

  // 8. 检查结果
  const currentUrl = page.url();
  const productsCount = await page.locator('div[data-sku]').count();
  console.log(`[AI] 当前URL: ${currentUrl}`);
  console.log(`[AI] 找到商品: ${productsCount} 个`);

  console.log(`[AI] ✅ 搜索完成`);
  return {
    url: currentUrl,
    title: await page.title(),
    productsCount
  };
}

async function ensureJdSearchResult(page, keyword) {
  const firstState = await readJdSearchState(page, keyword);
  if (firstState.ok) return firstState;

  console.log(`[AI] 搜索状态异常(${firstState.reason})，兜底一次。实际: ${firstState.actualKeyword || firstState.url}`);
  const retryBox = await aiFindSearchBox(page);
  if (retryBox) {
    await submitJdSearchKeyword(page, retryBox, keyword, { allowUrlFallback: true });
  } else {
    await page.goto(jdSearchUrl(keyword), { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await randomPause(1500, 2500);
  await page.waitForSelector('div[data-sku]', { timeout: 20000 }).catch(() => {});

  const finalState = await readJdSearchState(page, keyword);
  if (finalState.ok) return finalState;

  const shot = await captureRiskShot(page, "jd-search-state-fail");
  throw new Error(`京东搜索失败：${finalState.reason}。URL: ${finalState.url}，截图: ${shot}`);
}

async function readJdSearchState(page, keyword) {
  const url = page.url();
  const productsCount = await page.locator('div[data-sku]').count().catch(() => 0);
  if (!url.includes("search.jd.com")) {
    return { ok: false, reason: "not_search_page", url, productsCount };
  }
  const actualKeyword = extractJdSearchKeyword(url);
  if (!jdSearchKeywordMatches(url, keyword)) {
    return { ok: false, reason: "keyword_mismatch", url, productsCount, actualKeyword };
  }
  return { ok: true, reason: "ok", url, productsCount, actualKeyword };
}

async function submitJdSearchKeyword(page, searchBox, keyword, opts = {}) {
  await searchBox.click({ timeout: 5000 }).catch(() => {});
  await randomPause(250, 600);
  await searchBox.fill("", { timeout: 5000 }).catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
  });
  await randomPause(200, 500);
  await aiTypeText(page, keyword);
  await syncJdSearchInputValue(page, keyword);

  const inputValue = await searchBox.inputValue({ timeout: 2000 }).catch(() => "");
  if (normalizeSearchKeywordForCheck(inputValue) !== normalizeSearchKeywordForCheck(keyword)) {
    await syncJdSearchInputValue(page, keyword);
  }

  const beforeUrl = page.url();
  const searchButton = await aiFindSearchButton(page);
  if (searchButton) {
    await searchButton.click({ timeout: 8000 }).catch(() => undefined);
  } else {
    await submitJdSearchForm(page, keyword);
  }

  await page.waitForFunction((previousUrl) => location.href !== previousUrl || document.querySelectorAll("div[data-sku]").length > 0, beforeUrl, { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);

  if (page.url().includes("search.jd.com") && jdSearchKeywordMatches(page.url(), keyword)) return;
  if (!opts.allowUrlFallback) return;

  console.log(`[AI] 搜索结果关键词不匹配，使用京东搜索页参数兜底: ${keyword}`);
  await page.goto(jdSearchUrl(keyword), { waitUntil: "domcontentloaded", timeout: 30000 });
}

async function syncJdSearchInputValue(page, keyword) {
  await page.evaluate((kw) => {
    const el = document.querySelector('input.jd_pc_search_bar_react_search_input')
      || document.querySelector('input[type="text"]#key')
      || document.querySelector('input[type="text"][name="keyword"]')
      || document.querySelector('input[type="search"]');
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, kw);
    else el.value = kw;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, keyword);
}

async function submitJdSearchForm(page, keyword) {
  const submitted = await page.evaluate((kw) => {
    const el = document.querySelector('input.jd_pc_search_bar_react_search_input')
      || document.querySelector('input[type="text"]#key')
      || document.querySelector('input[type="text"][name="keyword"]')
      || document.querySelector('input[type="search"]');
    const form = el?.closest?.("form");
    if (!form) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, kw);
    else el.value = kw;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  }, keyword).catch(() => false);
  if (!submitted) await page.goto(jdSearchUrl(keyword), { waitUntil: "domcontentloaded", timeout: 30000 });
}

async function aiFindSearchButton(page) {
  const selectors = [
    SEARCH_BTN_SELECTOR,
    'button[class*="search"][class*="btn"]',
    'button[type="submit"]',
    '.search-m button',
    '.form button'
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) return button;
  }
  return null;
}

export function jdSearchKeywordMatches(url, expectedKeyword) {
  const actual = extractJdSearchKeyword(url);
  if (!actual) return false;
  const actualNormalized = normalizeSearchKeywordForCheck(actual);
  const requiredTokens = expectedKeywordTokens(expectedKeyword);
  if (requiredTokens.length === 0) return true;
  return requiredTokens.every((token) => actualNormalized.includes(token));
}

export function extractJdSearchKeyword(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.searchParams.get("keyword") || parsed.searchParams.get("wq") || "";
  } catch {
    return "";
  }
}

function expectedKeywordTokens(keyword) {
  return String(keyword || "")
    .split(/\s+/)
    .map(normalizeSearchKeywordForCheck)
    .filter((token) => token.length >= 2);
}

function normalizeSearchKeywordForCheck(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function jdSearchUrl(keyword) {
  return `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}&enc=utf-8`;
}

export function jdProductMatchesBrandSeed(product = {}, seedKeyword = "") {
  const seed = String(seedKeyword || "").replace(/买手店/g, " ").trim();
  if (!seed) return true;
  const title = String(product.title || "");
  if (!title.trim()) return false;
  return brandMatchesSeed(title, seed);
}

export function jdProductMatchesAllowedBrands(product = {}, allowedBrands = [], fallbackSeed = "") {
  return findJdAllowedBrandMatch(product, allowedBrands, fallbackSeed).matched;
}

function findJdAllowedBrandMatch(product = {}, allowedBrands = [], fallbackSeed = "") {
  const title = String(product.title || "");
  if (!title.trim()) return { matched: false, brand: "" };
  const brands = normalizeAllowedBrandsForJd(allowedBrands);
  if (!brands.length) {
    return {
      matched: jdProductMatchesBrandSeed(product, fallbackSeed),
      brand: fallbackSeed || ""
    };
  }
  for (const brand of brands) {
    if (brandMatchesAllowedBrand(title, brand)) {
      return { matched: true, brand };
    }
  }
  return { matched: false, brand: "" };
}

function brandMatchesSeed(title, seedKeyword) {
  const titleNormalized = normalizeSearchKeywordForCheck(title);
  const aliases = brandAliasesForSeed(seedKeyword);
  if (aliases.length === 0) return true;

  return aliases.some((alias) => titleNormalized.includes(normalizeSearchKeywordForCheck(alias)));
}

function brandMatchesAllowedBrand(title, brand) {
  const aliases = brandAliasesForAllowedBrand(brand);
  if (!aliases.length) return false;
  return aliases.some((alias) => titleMatchesBrandAlias(title, alias));
}

function brandAliasesForAllowedBrand(brand) {
  const value = String(brand || "").replace(/买手店/g, " ").trim();
  if (!value || isGenericAllowedBrand(value)) return [];
  const aliases = new Set();
  const asciiTokens = value.match(/[A-Za-z][A-Za-z0-9+.-]{1,30}/g) || [];
  if (asciiTokens.length > 1) {
    aliases.add(value);
  } else {
    for (const alias of brandAliasesForSeed(value)) aliases.add(alias);
  }
  for (const match of value.matchAll(/[\u4e00-\u9fa5]{2,10}/g)) {
    aliases.add(match[0]);
  }
  if (asciiTokens.length <= 1) {
    for (const token of asciiTokens) {
      for (const alias of brandAliases(token)) aliases.add(alias);
    }
  }
  return [...aliases].map((item) => String(item || "").trim()).filter((item) => item.length >= 2);
}

function titleMatchesBrandAlias(title, alias) {
  const rawAlias = String(alias || "").trim();
  if (!rawAlias) return false;
  const normalizedAlias = normalizeSearchKeywordForCheck(rawAlias);
  if (!normalizedAlias || normalizedAlias.length < 2) return false;
  if (/^[a-z0-9+.-]+$/i.test(rawAlias) && normalizedAlias.length <= 3) {
    const escaped = rawAlias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(String(title || "").toLowerCase());
  }
  return normalizeSearchKeywordForCheck(title).includes(normalizedAlias);
}

function normalizeAllowedBrandsForJd(allowedBrands) {
  if (!Array.isArray(allowedBrands)) return [];
  const seen = new Set();
  const result = [];
  for (const item of allowedBrands) {
    const brand = String(item || "").trim();
    const key = normalizeSearchKeywordForCheck(brand);
    if (!brand || key.length < 2 || seen.has(key) || isGenericAllowedBrand(brand)) continue;
    seen.add(key);
    result.push(brand);
  }
  return result;
}

function isGenericAllowedBrand(brand) {
  const normalized = normalizeSearchKeywordForCheck(brand).replace(/[\s/_-]+/g, "");
  return /^(?:other|others|unknown|misc|nobrand|generic|其他|其它|无品牌)$/.test(normalized);
}

function brandAliasesForSeed(seedKeyword) {
  const seed = String(seedKeyword || "");
  const seedNormalized = normalizeSearchKeywordForCheck(seed);
  const directAliases = [];
  for (const aliases of BRAND_ALIAS_MAP.values()) {
    if (aliases.some((alias) => seedNormalized.includes(normalizeSearchKeywordForCheck(alias)))) {
      directAliases.push(...aliases);
    }
  }
  if (directAliases.length > 0) return [...new Set(directAliases)];

  const brandTokens = seed.match(/[A-Za-z][A-Za-z0-9+.-]{1,20}/g) || [];
  if (brandTokens.length > 0) {
    return [...new Set(brandTokens.flatMap(brandAliases))];
  }

  const firstChineseToken = seed.replace(/买手店/g, " ").trim().split(/\s+/)[0] || "";
  if (/[\u4e00-\u9fa5]{2,}/.test(firstChineseToken)) return [firstChineseToken];
  return [];
}

function brandAliases(token) {
  const key = normalizeSearchKeywordForCheck(token);
  return BRAND_ALIAS_MAP.get(key) || [token];
}

const BRAND_ALIAS_MAP = new Map([
  ["swisse", ["swisse", "斯维诗"]],
  ["gnc", ["gnc", "健安喜"]],
  ["blackmores", ["blackmores", "澳佳宝"]],
  ["puritan", ["puritan", "普丽普莱"]],
  ["newink", ["newink", "纽维可"]],
  ["xikang", ["xikang", "希康"]]
]);

/**
 * AI查找搜索框
 */
async function aiFindSearchBox(page) {
  // 京东2026年版搜索框选择器（React组件，动态class）
  const selectors = [
    'input.jd_pc_search_bar_react_search_input',  // 京东2026新版
    'input[type="text"][class*="search"]',
    'input[type="text"]#key',
    'input[type="text"][name="keyword"]',
    '.search-m input[type="text"]',
    'input[type="search"]'
  ];

  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      const isVisible = await element.isVisible({ timeout: 1000 }).catch(() => false);
      if (isVisible) {
        console.log(`[AI] 找到搜索框: ${selector}`);
        return element;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * AI模拟打字
 */
async function aiTypeText(page, text) {
  for (const char of text) {
    const delay = /[a-zA-Z0-9]/.test(char) ? randomInt(50, 120) : randomInt(80, 180);
    await page.keyboard.type(char, { delay });
  }
}

/**
 * AI滚动页面
 */
export async function aiScrollPage(page, times = 1, label = "") {
  for (let i = 0; i < times; i++) {
    const distance = randomInt(200, 500);
    console.log(`[滚动] ${label} 第${i+1}/${times}次 wheel(${distance})`);
    await page.mouse.wheel(0, distance);
    await randomPause(300, 600);
  }
}

async function browseSearchResultsLightly(page, times = 2, label = "搜索结果") {
  const count = Math.max(0, Math.min(Number(times) || 0, 3));
  if (count === 0) return;
  await aiScrollPage(page, count, label);
}

async function ensurePageTop(page, label = "页面") {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    console.log(`[滚动] ${label} 回到顶部 第${attempt + 1}次`);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    await page.waitForTimeout(300).catch(() => undefined);
    const y = await page.evaluate(() => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0).catch(() => 0);
    if (y <= 5) return true;
  }
  return false;
}

/**
 * 提取京东商品列表（智能解析innerText，适配新版京东）
 * 关键策略：
 * - 跳过广告
 * - 标记店铺类型（买手店 vs 旗舰店/官方店/海外店等）
 * - 京东选品规则：只要"买手店"！
 */
export async function aiExtractJdProducts(page, maxCount = 10) {
  console.log(`[AI] 提取商品列表，最多${maxCount}个`);

  const products = await page.evaluate((max) => {
    const cards = document.querySelectorAll('div[data-sku]');
    const results = [];

    for (let i = 0; i < cards.length && results.length < max; i++) {
      const card = cards[i];
      const sku = card.getAttribute('data-sku');
      if (!sku) continue;

      const text = card.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // 跳过纯广告
      if (lines[0] === '广告' && lines.length < 3) continue;

      // 标题：第一个长度>5、不是"广告"、不是价格、不是标签的行
      let title = '';
      for (const line of lines) {
        if (line === '广告' || line === '¥' || /^¥\d+/.test(line)) continue;
        if (/^\d+(\.\d+)?$/.test(line)) continue;
        if (line.startsWith('|')) continue;
        if (line.length < 5) continue;
        if (/到手价|券满|人看过|已售|人付款/.test(line)) continue;
        title = line;
        break;
      }

      // 价格：找¥后面的数字 或 ¥XXX格式
      let price = '';
      const yenIdx = lines.findIndex(l => l === '¥');
      if (yenIdx >= 0 && lines[yenIdx + 1]) {
        price = lines[yenIdx + 1];
      } else {
        const priceLine = lines.find(l => /^¥\d+/.test(l));
        if (priceLine) price = priceLine.replace(/^¥/, '');
      }

      // 销量
      const salesLine = lines.find(l => /人看过|已售|人付款/.test(l));
      const sales = salesLine || '';

      // 店铺：包含"店"、"旗舰店"等
      const shop = [...lines].reverse().find(l =>
        /旗舰店|专营店|专卖店|官方店/.test(l) ||
        (l.endsWith('店') && l.length < 30)
      ) || '';

      // 店铺类型识别（中性标记，由策略库决定取舍）
      let shopType = 'unknown';
      if (shop) {
        if (/旗舰店/.test(shop)) shopType = 'flagship';        // 旗舰店
        else if (/海外/.test(shop)) shopType = 'overseas';      // 海外店
        else if (/京东自营/.test(shop)) shopType = 'jd_self';   // 京东自营
        else if (/官方/.test(shop)) shopType = 'official';      // 官方店
        else if (/专营店/.test(shop)) shopType = 'franchise';   // 专营店
        else if (/专卖店/.test(shop)) shopType = 'dealer';      // 专卖店
        else if (shop.endsWith('店')) shopType = 'buyer';       // 买手店（普通店铺）
      }

      // 图片
      const img = card.querySelector('img');
      const imgSrc = img ? (img.src || img.getAttribute('data-lazy-img') || '') : '';

      // 链接（京东详情页URL格式固定）
      const url = `https://item.jd.com/${sku}.html`;

      if (title) {
        results.push({
          productId: sku,
          title,
          price,
          sales,
          shop,
          shopType,        // 店铺类型：buyer/flagship/overseas/jd_self/official/franchise/dealer
          imgSrc: imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc,
          url
        });
      }
    }

    return results;
  }, maxCount);

  console.log(`[AI] 成功提取 ${products.length} 个商品`);
  if (products.length > 0) {
    console.log(`[AI] 示例: ${products[0].title.substring(0, 30)}... ¥${products[0].price}`);
  }

  return products;
}

/**
 * 京东搜索结果页：翻到下一页
 *
 * 京东新版分页是 React 组件：<div class="_pagination_next_xxx">下一页</div>
 * （旧版 .pn-next 已失效，无限滚动也无效，必须点"下一页"按钮）
 *
 * @returns {Promise<boolean>} 是否成功翻页
 */
export async function aiJdNextPage(page, opts = {}) {
  const nextBtn = page.locator('[class*="pagination_next"]').filter({ hasText: "下一页" }).first();
  const visible = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) {
    console.log(`[AI] 没有"下一页"按钮，已到末页`);
    return false;
  }

  // 是否已禁用（末页）
  const disabled = await nextBtn.evaluate((el) =>
    el.className.includes("disabled") || el.getAttribute("aria-disabled") === "true"
  ).catch(() => false);
  if (disabled) {
    console.log(`[AI] "下一页"已禁用，到末页`);
    return false;
  }

  console.log("[滚动] scrollIntoView(翻页按钮)"); await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
  await randomPause(600, 1200);
  await nextBtn.click().catch(() => {});
  await randomPause(2500, 4000);
  await ensurePageTop(page, "翻页后列表");
  await browseSearchResultsLightly(page, opts.afterScrollTimes ?? 0, "翻页后列表");
  console.log(`[AI] ✅ 已翻到下一页`);
  return true;
}


export async function aiJdEnterShop(page, shopUrl) {
  if (!shopUrl || !shopUrl.includes('mall.jd.com')) {
    throw new Error(`无效的店铺URL: ${shopUrl}`);
  }
  console.log(`[AI] 进入店铺: ${shopUrl}`);

  // 直达店铺页（京东店铺是标准页，直接goto最稳）
  await page.goto(shopUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomPause(2000, 3500);
  await aiScrollPage(page, 1, "列表");

  console.log(`[AI] ✅ 已进入店铺页面: ${await page.title()}`);
  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * 扒某个买手店的全部商品
 *
 * 方案：用店铺名回搜索页搜（京东会优先展示该店商品，实测80%+是该店），
 * 再用已验证的翻页能力(aiJdNextPage)翻页扒货。比进店铺页稳——
 * 因为店铺首页是营销页不列商品，而搜索+翻页都已验证可靠。
 *
 * @param page
 * @param shopName 店铺名（从详情页提取，如"香港直供保健买手店"）
 * @param maxPages 最多翻几页
 * @returns 该店商品数组（已去重、只保留该店的）
 */
export async function aiExtractShopAllProducts(page, shopName, maxPages = 5) {
  console.log(`[AI] 扒店铺商品: "${shopName}"，最多${maxPages}页`);

  // 用店铺名回搜索页
  await aiJdSearch(page, shopName, { skipScroll: true });

  const allProducts = [];
  const seenIds = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const products = await aiExtractJdProducts(page, 60);

    // 只保留该店的商品 + 去重
    const newProducts = products.filter((p) => {
      if (seenIds.has(p.productId)) return false;
      // 店铺名匹配（宽松：含店铺名即可）
      const isThisShop = p.shop && p.shop.includes(shopName);
      if (!isThisShop) return false;
      seenIds.add(p.productId);
      return true;
    });

    allProducts.push(...newProducts);
    console.log(`[日志] 页${pageNum} 该店新增${newProducts.length}个（页内共${products.length}个）`);

    if (pageNum < maxPages) {
      const ok = await aiJdNextPage(page);
      if (!ok) {
        console.log(`[AI] 无下一页，停止`);
        break;
      }
    }
  }

  console.log(`[AI] ✅ 店铺"${shopName}"共扒到 ${allProducts.length} 个商品`);
  return allProducts;
}
export async function aiClickProduct(page, productIndex = 0) {
  console.log(`[AI] 点击商品 索引 ${productIndex}`);

  // 找出所有有效的商品卡片（有sku且有内容）
  const validIndices = await page.evaluate(() => {
    const cards = document.querySelectorAll('div[data-sku]');
    const indices = [];
    for (let i = 0; i < cards.length; i++) {
      const sku = cards[i].getAttribute('data-sku');
      const text = cards[i].innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      // 跳过纯广告
      if (sku && (lines[0] !== '广告' || lines.length > 3)) {
        indices.push(i);
      }
    }
    return indices;
  });

  if (validIndices.length === 0) {
    throw new Error('没有可点击的商品卡片');
  }

  const realIndex = validIndices[productIndex];
  if (realIndex === undefined) {
    throw new Error(`有效商品索引超出范围: ${productIndex} >= ${validIndices.length}`);
  }

  console.log(`[AI] 实际点击第 ${realIndex} 个卡片（共${validIndices.length}个有效商品）`);

  const cards = await page.locator('div[data-sku]').all();
  const card = cards[realIndex];

  // 1. 滚动到商品（人类视野范围）
  console.log("[滚动] scrollIntoView(商品卡片)");
  await card.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await randomPause(800, 1500);

  // 2. 找图片（点击图片是最自然的人类操作）
  const img = card.locator('img').first();
  const imgVisible = await img.isVisible({ timeout: 3000 }).catch(() => false);

  // 3. hover一下图片（force跳过Playwright内置滚动）
  if (imgVisible) {
    await img.hover({ timeout: 5000, force: true }).catch(() => {});
  } else {
    await card.hover({ timeout: 5000, force: true }).catch(() => {});
  }
  await randomPause(600, 1200);

  // 4. 思考停顿
  await randomPause(400, 900);

  // 5. 监听新页面打开
  const context = page.context();
  const pagesBefore = context.pages().length;

  // 京东商品卡片的图片或标题区域点击会触发JS跳转
  // 优先点击图片（最自然），失败再点卡片
  const clickTarget = imgVisible ? img : card;

  try {
    await clickTarget.click({ timeout: 10000, force: true });
  } catch (e) {
    console.log(`[AI] 点击失败: ${e.message}`);
  }

  await randomPause(2000, 3500);

  // 6. 等待新标签页或URL变化
  let detailPage = page;
  for (let i = 0; i < 10; i++) {
    const pagesAfter = context.pages();
    if (pagesAfter.length > pagesBefore) {
      detailPage = pagesAfter[pagesAfter.length - 1];
      break;
    }
    if (page.url().includes('item.jd.com')) {
      detailPage = page;
      break;
    }
    await page.waitForTimeout(500);
  }

  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await detailPage.bringToFront().catch(() => {});  // 切到前台，让用户看见
  await randomPause(2000, 3500);

  // 7. 等详情页加载（滚动在extract里做）
  return {
    page: detailPage,
    url: detailPage.url(),
    title: await detailPage.title()
  };
}

/**
 * 提取商品详情（智能解析，包含已售/评论/SKU）
 */
export async function aiExtractJdDetail(page) {
  console.log(`[AI] 提取商品详情`);
  await page.waitForLoadState("domcontentloaded");
  await randomPause(2000, 3500);

  // 模拟人类查看详情：轻滚两次拿到懒加载/SKU区域，然后截图前必须回到顶部。
  await aiScrollPage(page, 2, "详情");
  await randomPause(800, 1500);

  const detail = await page.evaluate(() => {
    const text = document.body.innerText || '';

    // 标题：京东详情页标题在多个位置，找最合理的
    let title = '';
    const titleSelectors = [
      '.sku-name',
      '.itemInfo-wrap .sku-name',
      'div[class*="sku-name"]',
      '.product-intro .sku-name',
      'h1.title',
    ];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 5) {
        title = el.innerText.trim();
        break;
      }
    }
    // 备用：从 document.title 取
    if (!title) {
      const docTitle = document.title || '';
      // 去掉【京东】等后缀
      title = docTitle.replace(/【.*?】/g, '').replace(/[-_|]\s*京东.*$/, '').trim();
    }

    // 价格：找页面上的"¥XXX"模式，但要在主商品区域
    let price = '';
    const priceSelectors = [
      '.p-price .price',
      '.price-now',
      '.summary-price .p-price',
      'span[class*="price"][class*="num"]',
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const t = el.innerText.replace(/[¥￥\s]/g, '');
        if (/^\d+(\.\d+)?$/.test(t)) {
          price = t;
          break;
        }
      }
    }
    if (!price) {
      const m = text.match(/¥\s*(\d+(?:\.\d+)?)/);
      if (m) price = m[1];
    }

    // 已售/销量
    let sales = '';
    const salesPatterns = [
      /已售\s*(\d+(?:\.\d+)?[万千]?\+?)/,
      /销量\s*[：:]\s*(\d+(?:\.\d+)?[万千]?\+?)/,
      /(\d+(?:\.\d+)?[万千]?\+?)\s*人付款/,
      /(\d+(?:\.\d+)?[万千]?\+?)\s*人看过/,
      /累计销量\s*(\d+(?:\.\d+)?[万千]?\+?)/,
      /月销\s*(\d+(?:\.\d+)?[万千]?\+?)/
    ];
    for (const pattern of salesPatterns) {
      const m = text.match(pattern);
      if (m) {
        sales = m[1];
        break;
      }
    }

    // 评论数：只取数字部分
    let comments = '';
    const commentMatch = text.match(/(?:买家评价|累计评价|商品评价)[（(]?(\d+(?:\.\d+)?[万千]?\+?)[）)]?/);
    if (commentMatch) {
      comments = commentMatch[1];
    } else {
      const m2 = text.match(/(\d+(?:\.\d+)?[万千]?\+?)\s*条评价/);
      if (m2) comments = m2[1];
    }

    // 品牌
    let brand = '';
    const brandRow = document.querySelector('#parameter-brand');
    if (brandRow) {
      brand = brandRow.innerText.replace(/品牌[:：]\s*/, '').trim();
    } else {
      const m = text.match(/品牌[:：]\s*([^\n]{1,30})/);
      if (m) brand = m[1].trim();
    }

    // 店铺名 + 店铺URL（关键：京东店铺是 mall.jd.com/index-{id}.html 固定格式）
    let shop = '';
    let shopUrl = '';
    // 先从店铺链接拿（最可靠）：找指向 mall.jd.com 的链接
    const mallLink = Array.from(document.querySelectorAll('a')).find((a) =>
      (a.href || '').includes('mall.jd.com')
    );
    if (mallLink) {
      shopUrl = mallLink.href.split('?')[0]; // 去掉query，保留 index-xxx.html
      const t = (mallLink.innerText || '').trim();
      if (t) shop = t;
    }
    // 店铺名兜底：旧选择器
    if (!shop) {
      const shopSelectors = [
        '.J-hove-wrap .name a',
        '.popbox-inner .seller-infor a',
        '[class*="shopName"] a',
        '.crumb-wrap .item a',
      ];
      for (const sel of shopSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) {
          shop = el.innerText.trim();
          break;
        }
      }
    }

    // SKU规格
    let skuInfo = '';
    const skuEl = document.querySelector('.summary-top, .choose-result, [class*="specification"], #choose-attrs');
    if (skuEl) {
      skuInfo = skuEl.innerText.trim().substring(0, 300);
    }

    // 规格参数
    const params = {};
    const paramRows = document.querySelectorAll('.parameter2 li, .Ptable-item li, [class*="param"] li');
    for (const row of paramRows) {
      const t = row.innerText;
      const colonIdx = t.indexOf('：');
      if (colonIdx > 0) {
        const key = t.substring(0, colonIdx).trim();
        const val = t.substring(colonIdx + 1).trim();
        if (key && val && key.length < 30 && val.length < 100) {
          params[key] = val;
        }
      }
    }

    return {
      url: location.href,
      title,
      price,
      sales,
      comments,
      brand,
      shop,
      shopUrl,
      skuInfo,
      params
    };
  });

  // 3) 滚回顶部，方便后续截图截到主图、标题、价格和SKU区域。
  await ensurePageTop(page, "详情页");
  await randomPause(500, 900);

  console.log(`[AI] 详情提取完成: ${detail.title.substring(0, 30)}... | ¥${detail.price} | 评价${detail.comments || '?'} | 店铺:${detail.shop || '?'}`);

  return detail;
}

/**
 * 京东选品总成：搜"品牌+买手店" → 翻页拉买手店品 → 逐个进详情拿评价 → 筛评价>=minComments
 *
 * 这是京东线的总成函数，串起已验证的所有动作：
 *   aiJdSearch + aiJdNextPage + aiExtractJdProducts + aiClickProduct + aiExtractJdDetail
 *
 * 返回的是"原始候选品"，去重和算最小规格单价交给调用方(Agent大模型)做。
 *
 * @param page
 * @param brand 品牌词（如 "SWISSE"，内部会拼成 "SWISSE 买手店"）
 * @param opts { maxPages=3, maxDetail=20, minComments=2 }
 * @returns { candidates: [], stats: {} }
 */
/**
 * 京东选品总成：
 * 1. 搜"品牌+买手店" → 从结果页收集所有买手店的名字
 * 2. 逐个搜买手店名 → 在该店的搜索结果里一个一个点进详情
 * 3. 拿评价/SKU/截图 → 筛评价>=minComments → 去重
 * 4. 直到去重商品数达到 targetCount
 *
 * @param page
 * @param brand 品牌词
 * @param opts { targetCount=10, maxPagesPerShop=3, maxShopsPerBrand=12, minComments=2 }
 */
export async function aiJdHarvest(page, brand, opts = {}) {
  const targetCount = opts.targetCount || 999;
  const maxPagesPerShop = opts.maxPagesPerShop || 5;
  const maxShopsPerBrand = opts.maxShopsPerBrand || 12;
  const maxDetailPerShop = positiveInteger(opts.maxDetailPerShop, 12);
  const maxConsecutiveCommentRejectsPerShop = positiveInteger(opts.maxConsecutiveCommentRejectsPerShop, 8);
  const minComments = opts.minComments ?? 2;
  const priceRange = opts.priceRange || [80, 999999];
  const shotDir = opts.screenshotDir || "";
  const searchSuffix = opts.searchSuffix || "";
  const searchKeyword = searchSuffix ? `${brand} ${searchSuffix}` : brand;
  const onCandidate = typeof opts.onCandidate === "function" ? opts.onCandidate : null;
  const allowedBrands = normalizeAllowedBrandsForJd(opts.allowedBrands);

  console.log(`[日志] STEP1 开始京东选品: "${searchKeyword}" (目标${targetCount}品) ===`);
  if (allowedBrands.length) console.log(`[日志] 可用品牌池: ${allowedBrands.length} 个，买手店页保留任一可用品牌商品`);

  // 1) 搜"品牌+买手店" → 从结果页收集买手店名字
  const searchOpts = { platform: "jd", account: opts.account };
  await aiJdSearch(page, searchKeyword, searchOpts);
  const allSeenSku = new Set();
  const allCandidates = [];
  let qualifiedCount = 0;

  const shopNames = new Set();
  const shopStats = [];
  const shopStops = [];
  // 从第1页收集店铺名（必要时翻几页）
  for (let sPage = 1; sPage <= 2; sPage++) {
    const prods = await aiExtractJdProducts(page, 60);
    for (const p of prods) {
      if (p.shopType === "buyer" && p.shop && !shopNames.has(p.shop)) {
        shopNames.add(p.shop);
      }
    }
    if (sPage < 2) { const ok = await aiJdNextPage(page, { afterScrollTimes: 1 }); if (!ok) break; }
  }
  const shopsToTry = [...shopNames].slice(0, maxShopsPerBrand);
  console.log(`[日志] STEP2 收集到 ${shopNames.size} 个买手店，本轮尝试 ${shopsToTry.length} 个: ${shopsToTry.slice(0,5).join(', ')}...`);

  // 2) 逐个搜买手店名 → 进详情
  for (const shopName of shopsToTry) {
    if (qualifiedCount >= targetCount) break;
    console.log(`[日志] STEP3 搜店: "${shopName}" ---`);
    let detailCheckedInShop = 0;
    let consecutiveCommentRejects = 0;
    let stopShop = false;
    let stopReason = "";

    // 第二段只搜买手店名。不要拼产品名，否则会漏掉该买手店里的其它同品牌可选品。
    await aiJdSearch(page, shopName, { ...searchOpts, skipScroll: true });
    for (let pageNum = 1; pageNum <= maxPagesPerShop && !stopShop; pageNum++) {
      const currentListUrl = page.url();
      const products = await aiExtractJdProducts(page, 60);
      const filtered = filterJdProductsForShop(products, shopName, brand, allSeenSku, allowedBrands);
      const shopProds = filtered.matches;
      shopStats.push({
        shopName,
        page: pageNum,
        total: products.length,
        matched: shopProds.length,
        skipped: filtered.skipped
      });
      console.log(`[日志] 页${pageNum} 店铺「${shopName}」原始${products.length}个，可用品牌命中${shopProds.length}个，跳过：${formatSkipStats(filtered.skipped)}`);
      if (!shopProds.length && filtered.examples.length) {
        console.log(`[日志] 跳过示例：${filtered.examples.slice(0, 3).join("；")}`);
      }

      for (const target of shopProds) {
        if (qualifiedCount >= targetCount) break;
        const guardBefore = shouldStopJdShopHarvest({
          detailCheckedInShop,
          consecutiveCommentRejects
        }, {
          maxDetailPerShop,
          maxConsecutiveCommentRejectsPerShop
        });
        if (guardBefore.stop) {
          console.log(`[日志] 店铺「${shopName}」提前跳过：${guardBefore.reason}`);
          stopShop = true;
          stopReason = guardBefore.reason;
          break;
        }
        allSeenSku.add(target.productId);

        const idx = await page.evaluate((sku) => {
          const cards = document.querySelectorAll('div[data-sku]');
          const validSkus = [];
          for (const card of cards) {
            const cardSku = card.getAttribute('data-sku');
            const text = card.innerText || '';
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (cardSku && (lines[0] !== '广告' || lines.length > 3)) {
              validSkus.push(cardSku);
            }
          }
          return validSkus.indexOf(sku);
        }, target.productId);
        if (idx < 0) continue;

        let detailPage = null;
        try {
          const clicked = await aiClickProduct(page, idx);
          detailPage = clicked.page;
          const detail = await aiExtractJdDetail(detailPage);
          const commentsNum = parseCommentCount(detail.comments);
          const passComments = commentsNum >= minComments;
          detailCheckedInShop += 1;
          consecutiveCommentRejects = passComments ? 0 : consecutiveCommentRejects + 1;
          const priceNum = parseFloat(detail.price || target.price) || 0;
          const inPriceRange = priceNum >= priceRange[0] && priceNum <= priceRange[1];
          const pass = passComments && inPriceRange;
          const rejectReason = pass
            ? ""
            : (!passComments
              ? `京东评论数不足 ${minComments}（当前 ${commentsNum}）`
              : `京东价格不在策略区间 ${priceRange[0]}-${priceRange[1]}（当前 ${priceNum}）`);

          let screenshotPath = "";
          if (shotDir) {
            try {
              mkdirSync(shotDir, { recursive: true });
              screenshotPath = pathJoin(shotDir, `jd_${target.productId}.png`);
              await ensurePageTop(detailPage, "京东截图前");
              await detailPage.waitForTimeout(500).catch(() => undefined);
              await detailPage.screenshot({ path: screenshotPath, fullPage: false });
            } catch (e) { /* ignore */ }
          }

          const candidate = {
            productId: target.productId, title: detail.title || target.title,
            price: detail.price || target.price, shop: detail.shop || target.shop,
            shopType: "buyer", sales: target.sales || "", shopUrl: detail.shopUrl || "",
            comments: detail.comments || "0", commentsNum,
            skuInfo: detail.skuInfo || "", brand: target.matchedAllowedBrand || detail.brand || "",
            matchedBrand: target.matchedAllowedBrand || "",
            imgSrc: target.imgSrc || "", url: detail.url || target.url,
            screenshotPath, passComments, inPriceRange, passed: pass, rejectReason
          };
          allCandidates.push(candidate);
          if (candidate.passed) qualifiedCount += 1;
          if (candidate.passed && onCandidate) {
            try {
              await onCandidate(candidate);
            } catch (error) {
              console.log(`[AI] 候选即时入库失败: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const skuBrief = summarizeSkuInfo(detail.skuInfo || "");
          console.log(`[日志] 进详情 #${allCandidates.length} ${(detail.title||'').slice(0,24)} | 价¥${priceNum || "-"} | 评${commentsNum}/需${minComments} | SKU:${skuBrief || "未识别"} | ${pass ? "通过" : `淘汰：${rejectReason}`}`);

          if (!page.url().includes("search.jd.com")) {
            await page.goto(currentListUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1500);
          }

          const guardAfter = shouldStopJdShopHarvest({
            detailCheckedInShop,
            consecutiveCommentRejects
          }, {
            maxDetailPerShop,
            maxConsecutiveCommentRejectsPerShop
          });
          if (guardAfter.stop) {
            console.log(`[日志] 店铺「${shopName}」提前跳过：${guardAfter.reason}`);
            stopShop = true;
            stopReason = guardAfter.reason;
            break;
          }
        } catch (e) {
          console.log(`[AI] 进详情失败: ${e instanceof Error ? e.message.slice(0,40) : e}`);
          if (!page.url().includes("search.jd.com")) {
            await page.goto(currentListUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1500);
          }
        } finally {
          if (detailPage && detailPage !== page && !isPageClosed(detailPage)) {
            await detailPage.close().catch(() => undefined);
          }
          await page.bringToFront().catch(() => undefined);
          if ((page.context?.().pages?.() || []).filter((item) => !isPageClosed(item)).length > 2) {
            await compactSessionTabs(page.context(), page, "京东详情后");
          }
        }
        await randomPause(4000, 8000);
      }

      if (!stopShop && pageNum < maxPagesPerShop && qualifiedCount < targetCount) {
        const ok = await aiJdNextPage(page);
        if (!ok) break;
      }
    }
    if (stopShop && stopReason) {
      shopStops.push({ shopName, reason: stopReason });
    }
  }

  const qualified = allCandidates.filter((c) => c.passed);
  const rejected = allCandidates.filter((c) => !c.passed);
  console.log(`[日志] 完成 京东选品:: 共拉${allCandidates.length}个, 评价>=${minComments}且价格达标的${qualified.length}个 ===`);
  await compactSessionTabs(page.context(), page, "京东选品结束");
  return {
    candidates: qualified,
    rejected,
    stats: { totalHarvested: allCandidates.length, passed: qualified.length, rejected: rejected.length, shopsCollected: shopNames.size, shopsTried: shopsToTry.length, allowedBrands: allowedBrands.length, shopStats, shopStops }
  };
}

export function shouldStopJdShopHarvest(stats = {}, opts = {}) {
  const detailCheckedInShop = Number(stats.detailCheckedInShop || 0);
  const consecutiveCommentRejects = Number(stats.consecutiveCommentRejects || 0);
  const maxDetailPerShop = positiveInteger(opts.maxDetailPerShop, 12);
  const maxConsecutiveCommentRejectsPerShop = positiveInteger(opts.maxConsecutiveCommentRejectsPerShop, 8);

  if (detailCheckedInShop >= maxDetailPerShop) {
    return {
      stop: true,
      code: "max_detail_per_shop",
      reason: `已查看 ${detailCheckedInShop} 个详情，达到每店上限 ${maxDetailPerShop}`
    };
  }

  if (consecutiveCommentRejects >= maxConsecutiveCommentRejectsPerShop) {
    return {
      stop: true,
      code: "consecutive_comment_rejects",
      reason: `连续 ${consecutiveCommentRejects} 个商品评论不达标，跳过低质量店铺`
    };
  }

  return { stop: false, code: "", reason: "" };
}


/**
 * 关闭会话
 */
export async function closeAiSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    await session.close();
    sessions.delete(sessionId);
  }
}

function filterJdProductsForShop(products, shopName, brand, seenSkuSet, allowedBrands = []) {
  const skipped = {
    noProductId: 0,
    duplicate: 0,
    shopMismatch: 0,
    brandMismatch: 0
  };
  const examples = [];
  const matches = [];

  for (const product of products || []) {
    const title = String(product?.title || "").slice(0, 28);
    if (!product?.productId) {
      skipped.noProductId += 1;
      if (examples.length < 5) examples.push(`缺SKU:${title || "无标题"}`);
      continue;
    }
    if (seenSkuSet.has(product.productId)) {
      skipped.duplicate += 1;
      if (examples.length < 5) examples.push(`重复:${title}`);
      continue;
    }
    if (!product.shop || !product.shop.includes(shopName)) {
      skipped.shopMismatch += 1;
      if (examples.length < 5) examples.push(`非本店:${title || product.shop || product.productId}`);
      continue;
    }
    const brandMatch = findJdAllowedBrandMatch(product, allowedBrands, brand);
    if (!brandMatch.matched) {
      skipped.brandMismatch += 1;
      if (examples.length < 5) examples.push(`${allowedBrands.length ? "非可用品牌" : "非品牌"}:${title || product.productId}`);
      continue;
    }
    matches.push({ ...product, matchedAllowedBrand: brandMatch.brand });
  }

  return { matches, skipped, examples };
}

function formatSkipStats(skipped) {
  return [
    `非本店${skipped.shopMismatch || 0}`,
    `非可用品牌${skipped.brandMismatch || 0}`,
    `重复${skipped.duplicate || 0}`,
    `缺SKU${skipped.noProductId || 0}`
  ].join("、");
}

function summarizeSkuInfo(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^规格$/.test(line));
  if (!lines.length) return "";
  const joined = lines.slice(0, 2).join(" / ");
  return joined.length > 60 ? `${joined.slice(0, 60)}...` : joined;
}

// 按平台释放受控会话句柄（sessionId 形如 ai-jd-<accountId>）。
// 这里只解除 MCP 对 Chrome 的托管记录，不杀正式 Chrome 进程。
export async function closeAiSessionsByPlatform(platform) {
  const prefix = `ai-${platform}-`;
  let closed = 0;
  for (const [id, session] of [...sessions.entries()]) {
    if (id.startsWith(prefix) || id === `ai-${platform}`) {
      try {
        if (session.profileDir) await closeManagedChromeSessions(session.profileDir);
        else await session.close();
      } catch (e) {}
      sessions.delete(id);
      closed++;
    }
  }
  return closed;
}

// ============ 淘宝部分 ============

/**
 * 淘宝搜索（关键词，直接构造URL）
 */
export async function aiTaobaoSearch(page, keyword) {
  console.log(`[AI] 淘宝搜索: ${keyword}`);

  // 直接构造URL（最可靠）
  const encodedKeyword = encodeURIComponent(keyword);
  const searchUrl = `https://s.taobao.com/search?q=${encodedKeyword}`;

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomPause(2000, 3000);
  await aiScrollPage(page, 1, "列表");

  console.log(`[AI] ✅ 淘宝搜索成功`);
  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * 淘宝搜索翻页（按钮：BUTTON.next-btn + 文本"下一页"）
 */
export async function aiTaobaoNextPage(page) {
  const nextBtn = page.locator('[class*="next-btn"]').filter({ hasText: '下一页' }).first();
  const visible = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) { console.log('[AI] 淘宝无下一页'); return false; }
  const disabled = await nextBtn.evaluate(el =>
    el.className.includes('disabled') || el.getAttribute('aria-disabled') === 'true'
  ).catch(() => false);
  if (disabled) { console.log('[AI] 淘宝下一页已禁用'); return false; }
  console.log("[滚动] scrollIntoView(翻页按钮)"); await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
  await randomPause(500, 1000);
  await nextBtn.click().catch(() => {});
  await randomPause(2000, 3000);
  await aiScrollPage(page, 1, "列表");
  console.log('[AI] ✅ 淘宝翻到下一页');
  return true;
}

/**
 * 淘宝以图搜图（修复URL格式）
 */
export async function aiTaobaoSearchByImage(page, imageUrl) {
  console.log(`[AI] 淘宝以图搜图: ${imageUrl.substring(0, 60)}...`);

  // 淘宝拍立淘的正确URL格式
  const encodedImg = encodeURIComponent(imageUrl);
  const searchUrl = `https://s.taobao.com/search?imgfile=${encodedImg}&commend=all&ssid=s5-e&search_type=item&sourceId=tb.index&spm=a21bo.jianhua.201856-taobao-item.2&ie=utf8&initiative_id=tbindexz_20170306&bcoffset=3&ntoffset=3&p4ppushleft=1%2C48&s=0`;

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomPause(3000, 4000);
    await aiScrollPage(page, 1, "列表");

    console.log(`[AI] ✅ 淘宝以图搜图成功`);
    return {
      url: page.url(),
      title: await page.title()
    };
  } catch (error) {
    console.log(`[AI] 以图搜图失败，降级为关键词搜索`);
    // 降级：从图片URL提取品牌/型号作为关键词
    const keywords = imageUrl.match(/[a-zA-Z0-9]+/g)?.slice(0, 3).join(' ') || '商品';
    return await aiTaobaoSearch(page, keywords);
  }
}

/**
 * 提取淘宝商品列表（智能解析）
 * 关键字段：价格、已售、发货地、发货时效、店铺
 */
export async function aiExtractTaobaoProducts(page, maxCount = 10) {
  console.log(`[AI] 提取淘宝商品列表，最多${maxCount}个`);

  const products = await page.evaluate((max) => {
    const links = document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
    const results = [];
    const seenIds = new Set();

    for (let i = 0; i < links.length && results.length < max; i++) {
      const link = links[i];
      const href = link.href;
      const idMatch = href.match(/id=(\d+)/);
      if (!idMatch) continue;
      const productId = idMatch[1];
      if (seenIds.has(productId)) continue;
      seenIds.add(productId);

      // 用整张卡片的文本（比link本身更全，含发货地/48h等）
      const card = link.closest('div[class*="Card"], div[class*="content-col"], div[class*="item"]') || link;
      const text = (card.innerText || link.innerText || '').trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // 标题：第一个像标题的长行（排除价格/销量/规格/发货等噪声）
      let title = '';
      for (const line of lines) {
        if (
          line.length > 8 &&
          !/^[¥￥]|^\d+(\.\d+)?$/.test(line) &&
          !/人付款|发货|包邮|优惠|补贴|片剂|胶囊|个月|秒杀|直降|淘金币|期$/.test(line)
        ) {
          title = line;
          break;
        }
      }
      if (!title) continue;

      // 价格：淘宝把"¥ 67 .08"拆成多行，需合并。找"¥"后面的数字片段拼起来
      let price = '';
      const priceM = text.replace(/\s/g, '').match(/[¥￥](\d+(?:\.\d+)?)/);
      if (priceM) {
        price = priceM[1];
      } else {
        // 兜底：找形如 67 / .08 相邻的数字行
        for (let j = 0; j < lines.length; j++) {
          if (/^\d+$/.test(lines[j]) && lines[j + 1] && /^\.\d+$/.test(lines[j + 1])) {
            price = lines[j] + lines[j + 1];
            break;
          }
          if (/^\d+\.\d+$/.test(lines[j])) { price = lines[j]; break; }
        }
      }

      // 销量：保留"万+/千+"原样（如 "20万+"），并算出数值用于筛选
      let sales = '';
      let salesNum = 0;
      const salesM = text.match(/(\d+(?:\.\d+)?)\s*(万|千)?\+?\s*人付款/);
      if (salesM) {
        sales = salesM[0].replace(/\s/g, '');
        const base = parseFloat(salesM[1]);
        salesNum = salesM[2] === '万' ? base * 10000 : (salesM[2] === '千' ? base * 1000 : base);
      }

      // 发货地（省份/直辖市）
      let shipFrom = '';
      const shipM = text.match(/(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/);
      if (shipM) shipFrom = shipM[1];
      const isDomestic = !!shipFrom && !/(香港|澳门|台湾)/.test(shipFrom);

      // 48小时内发货
      const ship48h = /48小时内发|24小时内发|当日发|次日达/.test(text);

      // 店铺名（最后一行通常是店铺）
      const shop = lines[lines.length - 1] || '';

      // 图片
      const img = (card.querySelector && card.querySelector('img')) || link.querySelector('img');
      let imgSrc = img ? (img.src || img.getAttribute('data-src') || '') : '';
      if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;

      results.push({
        productId, title, price, sales, salesNum,
        shipFrom, isDomestic, ship48h, shop, imgSrc, url: href
      });
    }
    return results;
  }, maxCount);

  console.log(`[AI] 成功提取 ${products.length} 个淘宝商品`);
  if (products.length > 0) {
    const p = products[0];
    console.log(`[AI] 示例: ${p.title.substring(0, 26)}... ¥${p.price} | ${p.shipFrom || '?'}${p.isDomestic ? '(国内)' : ''} | ${p.sales || '?'} | ${p.ship48h ? '48h发' : ''}`);
  }

  return products;
}

/**
 * 提取淘宝商品详情（进入详情页后）
 * 关键字段：完整SKU、48小时发货、精确价格、评论数
 */
export async function aiExtractTaobaoDetail(page) {
  console.log(`[AI] 提取淘宝商品详情`);

  await randomPause(2000, 3000);
  await aiScrollPage(page, 1, "详情");

  const detail = await page.evaluate(() => {
    const text = document.body.innerText;

    // 标题：优先h1/ItemHead，降级用document.title（最稳）
    let title = '';
    const titleSelectors = ['h1', '[class*="ItemHead"]', '[class*="bodyWrap"]', '[class*="rightWrap"]'];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 5) {
        title = el.innerText.trim().split(/[¥￥\n]/)[0].trim();  // 只取第一行，去掉价格
        break;
      }
    }
    if (!title || title.length < 10) {
      title = (document.title || '').replace(/\s*[-–|]\s*.*?(?:淘宝|天猫|tmall|taobao).*$/i, '').trim();
    }

    // 价格：必须用"实付价"(highlightPrice)，不是划线原价(subPrice)
    // 淘宝2026：highlightPrice--xxx=平台加补后实付，subPrice--xxx=优惠前划线价
    let price = '';
    let priceType = '';
    const payEl = document.querySelector('[class*="highlightPrice"]');
    if (payEl) {
      const m = (payEl.innerText || '').replace(/\s/g, '').match(/[¥￥]?(\d+(?:\.\d+)?)/);
      if (m) { price = m[1]; priceType = '实付'; }
    }
    if (!price) {
      // 兜底：找其它价格元素，但排除明确的划线价(subPrice/原价)
      const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"]');
      for (const el of priceEls) {
        const cls = (el.className || '').toString();
        if (/sub|origin|del|线/.test(cls)) continue;
        const m = (el.innerText || '').replace(/\s/g, '').match(/[¥￥](\d+(?:\.\d+)?)/);
        if (m && parseFloat(m[1]) > 0) { price = m[1]; priceType = '估'; break; }
      }
    }

    // SKU选项：列出所有规格（如 120片×1瓶 / 200片×1瓶），用于Agent按规格比价
    let skuOptions = [];
    const skuWrap = document.querySelector('[class*="skuWrapper"]');
    let selectedSkuOptions = [];
    if (skuWrap) {
      const items = skuWrap.querySelectorAll('[class*="skuItem"], [class*="valueItem"]');
      const itemList = Array.from(items);
      const labels = itemList.map(it => (it.innerText || '').trim()).filter(x => x && x.length < 40 && x !== '推荐');
      skuOptions = [...new Set(labels)];
      selectedSkuOptions = itemList
        .filter((it) => {
          const cls = (it.className || '').toString();
          const ariaChecked = it.getAttribute?.('aria-checked') === 'true';
          const ariaSelected = it.getAttribute?.('aria-selected') === 'true';
          return ariaChecked || ariaSelected || /selected|active|checked|current|isSelected/i.test(cls) ||
            !!it.querySelector?.('[class*="selected"], [class*="active"], [class*="checked"]');
        })
        .map(it => (it.innerText || '').trim())
        .filter(x => x && x.length < 60 && x !== '推荐');
    }
    const activeSkuOptions = selectedSkuOptions.length > 0 ? selectedSkuOptions : skuOptions.slice(0, 1);
    const skuInfo = activeSkuOptions.join(' / ').substring(0, 300);

    // 48小时发货
    let shipHours = null;
    const shipMatch = text.match(/(\d+)\s*小时.*发货/);
    if (shipMatch) {
      shipHours = parseInt(shipMatch[1]);
    }

    // 发货地：淘宝详情快递行格式是"广东汕头 至 邢台南和"，发货地="至"前面的地名。
    // 注意：参数表里的"产地"是商品产地(可能澳洲)，≠发货地，绝不能用产地判国内。
    let shipFrom = '';
    const PROV = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门';
    const shipPatterns = [
      // "广东汕头 至 邢台" → 取"至"前的省
      new RegExp(`(${PROV})[\\u4e00-\\u9fa5]{0,4}\\s*至\\s*[\\u4e00-\\u9fa5]`),
      // "发货地/快递/配送：广东"
      new RegExp(`(?:发货地|快递|配送|物流|宝贝地址)[：:\\s]{0,4}(?:中国大陆[\\s,，]*)?(${PROV})`),
      // "从广东发货"
      new RegExp(`(?:从|由)\\s*(${PROV})\\s*(?:发货|发出|寄出)`),
    ];
    for (const re of shipPatterns) {
      const m = text.match(re);
      if (m) { shipFrom = m[1]; break; }
    }
    let mainlandFlag = false;
    if (!shipFrom && /(?:发货地|快递|配送)[：:\s]{0,4}中国大陆/.test(text)) {
      mainlandFlag = true;
    }

    // 已售/月销
    let sales = '';
    const salesMatch = text.match(/已售\s*(\d+(?:\.\d+)?[万千]?\+?)|月销\s*(\d+(?:\.\d+)?[万千]?\+?)|(\d+(?:\.\d+)?[万千]?\+?)\s*人付款/);
    if (salesMatch) {
      sales = salesMatch[1] || salesMatch[2] || salesMatch[3];
    }

    // 店铺名：精准匹配 shopName 类，只取第一行（避免把评分/发货信息也包进去）
    let shop = '';
    const shopEl = document.querySelector('[class*="shopName"]');
    if (shopEl && shopEl.innerText) {
      shop = shopEl.innerText.trim().split('\n')[0].trim();  // 只要第一行
    }
    if (!shop || shop.length < 2) {
      const el = document.querySelector('[class*="seller-info"] [class*="name"], [class*="ShopInfo"] [class*="name"]');
      if (el && el.innerText) shop = el.innerText.trim().split('\n')[0].trim();
    }

    return {
      title,
      price,
      priceType,
      sales,
      shipFrom,
      mainlandFlag,
      shipHours,
      skuInfo,
      skuOptions,
      selectedSkuOptions: activeSkuOptions,
      shop,
      url: window.location.href
    };
  });

  console.log(`[AI] 详情提取完成: ${detail.title?.substring(0, 28)}... | ¥${detail.price}(${detail.priceType}) | SKU:${detail.skuOptions?.length || 0}种 | ${detail.shipFrom}`);

  return detail;
}

/**
 * 点击淘宝商品进入详情页
 */
export async function aiClickTaobaoProduct(page, productIndex) {
  console.log(`[AI] 点击淘宝商品 索引 ${productIndex}`);

  const links = await page.locator('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]').all();

  if (productIndex >= links.length) {
    throw new Error(`商品索引 ${productIndex} 超出范围 (共${links.length}个)`);
  }

  const link = links[productIndex];
  await link.click();
  await randomPause(2000, 3000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  console.log(`[AI] ✅ 已进入详情页`);
  return page.url();
}

/**
 * 淘宝选品总成：搜索 → 列表筛(国内+48h+已售≥N) → 符合的才进详情拿SKU
 *
 * 对标京东的 aiJdHarvest。淘宝不涉及店铺，列表页就能筛(发货地/48h/已售)，
 * 进详情只为确认不同SKU规格。页面结构已探查：字段都在卡片innerText里。
 *
 * @param page
 * @param keyword 搜索词（通常用京东品的"品牌+品名"）
 * @param opts { maxList=40, maxDetail=10, minSales=10, requireDomestic=true, require48h=true }
 * @returns { candidates: [], stats: {} }
 */
export async function aiTaobaoHarvest(page, keyword, opts = {}) {
  const maxList = opts.maxList || 40;
  const maxDetail = opts.maxDetail || 10;
  const maxPages = opts.maxPages || 3;
  const minSales = opts.minSales ?? 10;
  const requireDomestic = opts.requireDomestic !== false;
  const require48h = opts.require48h !== false;
  const priceRange = opts.priceRange || [80, 999999];
  const [priceMin, priceMax] = priceRange;
  const shotDir = opts.screenshotDir || "";

  console.log(`[AI] === 淘宝选品: "${keyword}" (翻${maxPages}页) ===`);

  // 1) 搜索
  await aiTaobaoSearch(page, keyword);
  const listUrl = page.url();
  const context = page.context();
  const candidates = [];
  const rejected = [];
  const pageStats = [];
  let detailDone = 0;

  // 2) 每页：提取→筛选→当前页进详情→翻下一页
  for (let pg = 1; pg <= maxPages && detailDone < maxDetail; pg++) {
    const all = await aiExtractTaobaoProducts(page, maxList);
    const filtered = filterTaobaoProductsForHarvest(all, {
      requireDomestic,
      require48h,
      minSales,
      priceMin,
      priceMax
    });
    const good = filtered.matches;
    pageStats.push({
      page: pg,
      total: all.length,
      matched: good.length,
      skipped: filtered.skipped
    });
    console.log(`[AI] 第${pg}页: ${all.length}个 → 符合${good.length}个，跳过：${formatTaobaoSkipStats(filtered.skipped)}`);
    if (!good.length && filtered.examples.length) {
      console.log(`[AI] 淘宝跳过示例：${filtered.examples.slice(0, 3).join("；")}`);
    }

    for (const target of good) {
      if (detailDone >= maxDetail) break;
      let detailPage = null;
      try {
        const linkLoc = page.locator(`a[href*="id=${target.productId}"]`).first();
        if (!(await linkLoc.count())) {
          rejected.push({ ...target, skuInfo: "", detailOk: false, rejectReason: "未找到可点击的商品详情链接" });
          continue;
        }

        const before = context.pages().length;
        await linkLoc.scrollIntoViewIfNeeded().catch(() => {});
        await randomPause(500, 1000);
        await linkLoc.click().catch(() => {});
        await randomPause(2000, 3500);

        const after = context.pages();
        detailPage = page;
        if (after.length > before) {
          detailPage = after[after.length - 1];
          await detailPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
        }

        const detail = await aiExtractTaobaoDetail(detailPage);
        detailDone++;

        const finalShipFrom = detail.shipFrom || target.shipFrom || "";
        const isOverseas = /(香港|澳门|台湾|港澳台|海外|境外|保税)/.test(finalShipFrom);
        const finalDomestic = Boolean(finalShipFrom) && !isOverseas;
        const detail48h = detail.shipHours ? detail.shipHours <= 48 : target.ship48h;
        const selectedSkuRejectReason = taobaoSelectedSkuRejectReason(keyword, detail.selectedSkuOptions || detail.skuInfo || "");
        const rejectReason = selectedSkuRejectReason
          || ((requireDomestic && !finalDomestic)
          ? `详情页未确认国内发货(${finalShipFrom || "未知"})`
          : (require48h && !detail48h ? "详情页未确认48h发货" : ""));

        let screenshotPath = "";
        if (shotDir) {
          try { mkdirSync(shotDir, { recursive: true }); screenshotPath = pathJoin(shotDir, `taobao_${target.productId}.png`); await detailPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) {}
        }

        const hydrated = {
          productId: target.productId, title: detail.title || target.title,
          price: detail.price || target.price, priceType: detail.priceType || "",
          sales: target.sales, salesNum: target.salesNum,
          shipFrom: finalShipFrom, isDomestic: finalDomestic,
          ship48h: detail48h, shipHours: detail.shipHours,
          skuInfo: detail.skuInfo || "", skuOptions: detail.skuOptions || [], selectedSkuOptions: detail.selectedSkuOptions || [],
          shop: detail.shop || target.shop,
          imgSrc: target.imgSrc || "", url: target.url,
          screenshotPath, rejectReason, selectedSkuRejectReason, detailOk: true
        };
        if (rejectReason) rejected.push(hydrated);
        else candidates.push(hydrated);
        console.log(`[AI] 淘宝#${detailDone} ${(detail.title||"").slice(0,24)} | ¥${detail.price || target.price || "-"} | 已售${target.salesNum ?? "-"} | 发货${finalShipFrom || "未知"} | ${rejectReason ? `淘汰：${rejectReason}` : "通过"}`);

        if (!page.url().includes("s.taobao.com")) { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); }
      } catch (e) {
        console.log(`[AI] 淘宝失败: ${e.message.slice(0,40)}`);
        if (!page.url().includes("s.taobao.com")) { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); }
      } finally {
        if (detailPage && detailPage !== page && !isPageClosed(detailPage)) {
          await detailPage.close().catch(() => undefined);
        }
        await page.bringToFront().catch(() => undefined);
        if ((context.pages?.() || []).filter((item) => !isPageClosed(item)).length > 2) {
          await compactSessionTabs(context, page, "淘宝详情后");
        }
      }
      await randomPause(3000, 6000);
    }

    if (pg < maxPages && detailDone < maxDetail) {
      const ok = await aiTaobaoNextPage(page);
      if (!ok) break;
    }
  }

  console.log(`[AI] === 淘宝完成: ${candidates.length}个合格, ${rejected.length}个淘汰 ===`);
  await compactSessionTabs(context, page, "淘宝选品结束");
  return { candidates, rejected, stats: { detailDone, passed: candidates.length, rejected: rejected.length, pageStats } };
}

function filterTaobaoProductsForHarvest(products, rules) {
  const skipped = {
    noProductId: 0,
    nonDomestic: 0,
    slowShipping: 0,
    lowSales: 0,
    overseasPlatform: 0,
    priceOutOfRange: 0
  };
  const examples = [];
  const matches = [];

  for (const product of products || []) {
    const title = String(product?.title || "").slice(0, 28);
    if (!product?.productId) {
      skipped.noProductId += 1;
      if (examples.length < 5) examples.push(`缺商品ID:${title || "无标题"}`);
      continue;
    }
    if (rules.requireDomestic && !product.isDomestic) {
      skipped.nonDomestic += 1;
      if (examples.length < 5) examples.push(`非国内发货:${title || product.productId}`);
      continue;
    }
    if (rules.require48h && !product.ship48h) {
      skipped.slowShipping += 1;
      if (examples.length < 5) examples.push(`非48小时:${title || product.productId}`);
      continue;
    }
    if ((product.salesNum || 0) < rules.minSales) {
      skipped.lowSales += 1;
      if (examples.length < 5) examples.push(`销量不足:${title || product.productId}`);
      continue;
    }
    if (product.url && product.url.includes("tmall.hk")) {
      skipped.overseasPlatform += 1;
      if (examples.length < 5) examples.push(`海外平台:${title || product.productId}`);
      continue;
    }
    const priceNum = parseFloat(product.price) || 0;
    if (priceNum < rules.priceMin || priceNum > rules.priceMax) {
      skipped.priceOutOfRange += 1;
      if (examples.length < 5) examples.push(`价格不在区间:${title || product.productId}`);
      continue;
    }
    matches.push(product);
  }

  return { matches, skipped, examples };
}

function formatTaobaoSkipStats(skipped) {
  return [
    `非国内${skipped.nonDomestic || 0}`,
    `非48小时${skipped.slowShipping || 0}`,
    `销量不足${skipped.lowSales || 0}`,
    `海外平台${skipped.overseasPlatform || 0}`,
    `价格不符${skipped.priceOutOfRange || 0}`,
    `缺ID${skipped.noProductId || 0}`
  ].join("、");
}


function randomPause(minMs, maxMs) {
  const delay = randomInt(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
}
