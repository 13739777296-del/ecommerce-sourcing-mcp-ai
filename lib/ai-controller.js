import { openChromeSession, closeManagedChromeSessions } from "./chrome.js";
import { pickAccount } from "./accounts.js";
import { detectRiskControl, waitForManualResolve, captureRiskShot } from "./risk-guard.js";
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
    closeOtherPages: false
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

/**
 * 打开AI浏览器会话（直接指定profileDir，用于测试）
 */
export async function openAiSession(profileDir, initialUrl = "about:blank") {
  const sessionId = `ai-test-${Date.now()}`;

  const session = await openChromeSession(profileDir, initialUrl, {
    keepAlive: true,
    newPage: true,
    closeOtherPages: false
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
 * 京东搜索（真人节奏 + 风控守卫）
 *
 * 设计：
 * - 全程拟人：鼠标移动、拟人打字、随机停顿（5-15秒级别的真人节奏由调用方批量控制，
 *   单次内部各步之间也有随机停顿）
 * - 提交用回车（比满世界找按钮稳，真人也常按回车）
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
    if (!r.resolved) throw new Error("首页风控未解除，搜索中止");
  }

  // 2. 找到搜索框
  const searchBox = await aiFindSearchBox(page);
  if (!searchBox) {
    const shot = await captureRiskShot(page, "jd-nobox");
    throw new Error(`未找到搜索框（可能风控或改版），截图: ${shot}`);
  }

  // 3. 用JS原生事件设置输入并提交（绕过Playwright事件模拟，京东React组件需要原生事件）
  console.log(`[AI] 输入关键词并提交: ${keyword}`);
  await page.evaluate((kw) => {
    const el = document.querySelector('input.jd_pc_search_bar_react_search_input');
    if (!el) return;
    // React需要原生setter + input事件才能更新state
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, kw);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // 提交：派发Enter键事件
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }, keyword);
  await randomPause(2000, 3500);

  // 7. 等待结果页商品卡片
  await page.waitForSelector('div[data-sku]', { timeout: 20000 }).catch(() => {});
  await randomPause(800, 1500);

  // 8. 提交后检测风控（搜索这一步最容易触发）
  const searchRisk = await detectRiskControl(page);
  if (searchRisk.blocked) {
    const shot = await captureRiskShot(page, "jd-search");
    onNotify(`[AI] ⚠️ 搜索后检测到风控（${searchRisk.signal}），截图: ${shot}`);
    const r = await waitForManualResolve(page, {
      onNotify,
      expectReady: (p) => p.locator('div[data-sku]').count().then((c) => c > 0).catch(() => false)
    });
    if (!r.resolved) throw new Error("搜索风控未解除");
  }

  // 9. 浏览到底部（加载全部商品）；搜店名时可跳过
  if (!opts.skipScroll) {
    console.log("[滚动] scrollTo(底部)"); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomPause(800, 1500);
  }

  // 10. 检查结果
  const currentUrl = page.url();
  const productsCount = await page.locator('div[data-sku]').count();
  console.log(`[AI] 当前URL: ${currentUrl}`);
  console.log(`[AI] 找到商品: ${productsCount} 个`);

  if (!currentUrl.includes('search.jd.com') && productsCount === 0) {
    // 重试一次：在当前页面重新派发搜索（不跳回首页）
    console.log(`[AI] 首次搜索被重定向，重试一次...`);
    await randomPause(1000, 2000);
    await page.evaluate((kw) => {
      const el = document.querySelector('input.jd_pc_search_bar_react_search_input');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, kw);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }, keyword);
    await randomPause(2000, 3500);
    await page.waitForSelector('div[data-sku]', { timeout: 20000 }).catch(() => {});
    await randomPause(800, 1500);
    if (!opts.skipScroll) {
      console.log("[滚动] scrollTo(底部)"); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomPause(800, 1500);
    }
    const retryUrl = page.url();
    const retryCount = await page.locator('div[data-sku]').count();
    if (!retryUrl.includes('search.jd.com') && retryCount === 0) {
      const shot = await captureRiskShot(page, "jd-fail");
      throw new Error(`搜索失败(重试仍失败)，未跳结果页。URL: ${retryUrl}，截图: ${shot}`);
    }
    console.log(`[AI] ✅ 重试成功，${retryCount}个商品`);
    return { url: retryUrl, title: await page.title(), productsCount: retryCount };
  }

  console.log(`[AI] ✅ 搜索完成`);
  return {
    url: currentUrl,
    title: await page.title(),
    productsCount
  };
}

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
export async function aiJdNextPage(page) {
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
  console.log("[滚动] scrollTo(底部)"); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await randomPause(800, 1500);
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
  await aiJdSearch(page, shopName);

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

  // 模拟人类滚动浏览详情页
  await aiScrollPage(page, 1, "详情");
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

  // 3) 滚回顶部，方便截图
  console.log("[滚动] scrollTo(顶部)"); await page.evaluate(() => window.scrollTo(0, 0));
  await randomPause(300, 600);

  console.log(`[AI] 详情提取完成: ${detail.title.substring(0, 30)}... | ¥${detail.price} | 评价${detail.comments || '?'} | 店铺:${detail.shop || '?'}`);

  return detail;
}

/**
 * 京东选品总成：搜"品牌+买手店" → 翻页拉买手店品 → 逐个进详情拿评价 → 筛评价>2
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
 * 3. 拿评价/SKU/截图 → 筛评价>2 → 去重
 * 4. 直到去重商品数达到 targetCount
 *
 * @param page
 * @param brand 品牌词
 * @param opts { targetCount=10, maxPagesPerShop=3, minComments=2 }
 */
export async function aiJdHarvest(page, brand, opts = {}) {
  const targetCount = opts.targetCount || 999;
  const maxPagesPerShop = opts.maxPagesPerShop || 5;
  const minComments = opts.minComments ?? 2;
  const priceRange = opts.priceRange || [80, 999999];
  const shotDir = opts.screenshotDir || "";
  const searchSuffix = opts.searchSuffix || "";
  const searchKeyword = searchSuffix ? `${brand} ${searchSuffix}` : brand;

  console.log(`[日志] STEP1 开始京东选品: "${searchKeyword}" (目标${targetCount}品) ===`);

  // 1) 搜"品牌+买手店" → 从结果页收集买手店名字
  await aiJdSearch(page, searchKeyword);
  const allSeenSku = new Set();
  const allCandidates = [];

  const shopNames = new Set();
  // 从第1页收集店铺名（必要时翻几页）
  for (let sPage = 1; sPage <= 2; sPage++) {
    const prods = await aiExtractJdProducts(page, 60);
    for (const p of prods) {
      if (p.shopType === "buyer" && p.shop && !shopNames.has(p.shop)) {
        shopNames.add(p.shop);
      }
    }
    if (sPage < 2) { const ok = await aiJdNextPage(page); if (!ok) break; }
  }
  console.log(`[日志] STEP2 收集到 ${shopNames.size} 个买手店: ${[...shopNames].slice(0,5).join(', ')}...`);

  // 2) 逐个搜买手店名 → 进详情
  for (const shopName of shopNames) {
    if (allCandidates.length >= targetCount) break;
    console.log(`[日志] STEP3 搜店: "${shopName}" ---`);

    // 在搜索框搜这个店名
    await aiJdSearch(page, shopName, { skipScroll: true });
    const listUrl = page.url();

    for (let pageNum = 1; pageNum <= maxPagesPerShop; pageNum++) {
      const products = await aiExtractJdProducts(page, 60);
      // 只取该店的品+去重
      const shopProds = products.filter((p) =>
        p.shop && p.shop.includes(shopName) && !allSeenSku.has(p.productId)
      );
      console.log(`[日志] 页${pageNum} 该店${shopProds.length}个`);

      for (const target of shopProds) {
        if (allCandidates.length >= targetCount) break;
        allSeenSku.add(target.productId);

        const idx = await page.evaluate((sku) => {
          const cards = document.querySelectorAll('div[data-sku]');
          for (let i = 0; i < cards.length; i++) {
            if (cards[i].getAttribute('data-sku') === sku) return i;
          }
          return -1;
        }, target.productId);
        if (idx < 0) continue;

        try {
          const clicked = await aiClickProduct(page, idx);
          const detailPage = clicked.page;
          const detail = await aiExtractJdDetail(detailPage);
          const commentsNum = parseInt(detail.comments) || 0;
          const passComments = commentsNum > minComments;
          const priceNum = parseFloat(detail.price || target.price) || 0;
          const inPriceRange = priceNum >= priceRange[0] && priceNum <= priceRange[1];
          const pass = passComments && inPriceRange;

          let screenshotPath = "";
          if (shotDir) {
            try {
              mkdirSync(shotDir, { recursive: true });
              screenshotPath = pathJoin(shotDir, `jd_${target.productId}.png`);
              await detailPage.screenshot({ path: screenshotPath, fullPage: false });
            } catch (e) { /* ignore */ }
          }

          allCandidates.push({
            productId: target.productId, title: detail.title || target.title,
            price: detail.price || target.price, shop: detail.shop || target.shop,
            shopType: "buyer", sales: target.sales || "", shopUrl: detail.shopUrl || "",
            comments: detail.comments || "0", commentsNum,
            skuInfo: detail.skuInfo || "", brand: detail.brand || "",
            imgSrc: target.imgSrc || "", url: detail.url || target.url,
            screenshotPath, passComments: pass
          });
          console.log(`[日志] 进详情 #${allCandidates.length} ${(detail.title||'').slice(0,20)} 评${commentsNum} ${pass?'✓':'✗'}`);

          // 恢复列表页
          if (detailPage !== page) { await detailPage.close().catch(() => {}); await page.bringToFront().catch(() => {}); }
          if (!page.url().includes("search.jd.com")) {
            await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1500);
          }
        } catch (e) {
          console.log(`[AI] 进详情失败: ${e instanceof Error ? e.message.slice(0,40) : e}`);
          if (!page.url().includes("search.jd.com")) {
            await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
        await randomPause(4000, 8000);
      }

      if (pageNum < maxPagesPerShop && allCandidates.length < targetCount) {
        const ok = await aiJdNextPage(page);
        if (!ok) break;
      }
    }
  }

  const qualified = allCandidates.filter((c) => c.passComments);
  console.log(`[日志] 完成 京东选品:: 共拉${allCandidates.length}个, 评价>2的${qualified.length}个 ===`);
  return {
    candidates: qualified,
    stats: { totalHarvested: allCandidates.length, passedComments: qualified.length }
  };
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

// 按平台关闭该平台所有会话（sessionId 形如 ai-jd-<accountId>）
// keepAlive 会话的 handle.close() 故意不退进程，这里直接按 profileDir 强制关并杀进程
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
    if (skuWrap) {
      const items = skuWrap.querySelectorAll('[class*="skuItem"], [class*="valueItem"]');
      const labels = Array.from(items).map(it => (it.innerText || '').trim()).filter(x => x && x.length < 40 && x !== '推荐');
      skuOptions = [...new Set(labels)];
    }
    const skuInfo = skuOptions.join(' / ').substring(0, 300);

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
  let detailDone = 0;

  // 2) 每页：提取→筛选→当前页进详情→翻下一页
  for (let pg = 1; pg <= maxPages && detailDone < maxDetail; pg++) {
    const all = await aiExtractTaobaoProducts(page, maxList);
    const good = all.filter((p) => {
      if (requireDomestic && !p.isDomestic) return false;
      if (require48h && !p.ship48h) return false;
      if (p.salesNum < minSales) return false;
      if (p.url && p.url.includes('tmall.hk')) return false;
      const priceNum = parseFloat(p.price) || 0;
      if (priceNum < priceMin || priceNum > priceMax) return false;
      return true;
    });
    console.log(`[AI] 第${pg}页: ${all.length}个 → 符合${good.length}个`);

    for (const target of good) {
      if (detailDone >= maxDetail) break;
      try {
        const linkLoc = page.locator(`a[href*="id=${target.productId}"]`).first();
        if (!(await linkLoc.count())) { candidates.push({ ...target, skuInfo: "", detailOk: false }); continue; }

        const before = context.pages().length;
        await linkLoc.scrollIntoViewIfNeeded().catch(() => {});
        await randomPause(500, 1000);
        await linkLoc.click().catch(() => {});
        await randomPause(2000, 3500);

        const after = context.pages();
        let detailPage = page;
        if (after.length > before) {
          detailPage = after[after.length - 1];
          await detailPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
        }

        const detail = await aiExtractTaobaoDetail(detailPage);
        detailDone++;

        const finalShipFrom = detail.shipFrom || "";
        const isOverseas = /(香港|澳门|台湾)/.test(finalShipFrom);
        const detail48h = detail.shipHours ? detail.shipHours <= 48 : target.ship48h;
        const rejectReason = (requireDomestic && isOverseas)
          ? `发货地确认港澳台(${finalShipFrom})`
          : (require48h && !detail48h ? "详情页未确认48h发货" : "");

        let screenshotPath = "";
        if (shotDir) {
          try { mkdirSync(shotDir, { recursive: true }); screenshotPath = pathJoin(shotDir, `taobao_${target.productId}.png`); await detailPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) {}
        }

        candidates.push({
          productId: target.productId, title: detail.title || target.title,
          price: detail.price || target.price, priceType: detail.priceType || "",
          sales: target.sales, salesNum: target.salesNum,
          shipFrom: finalShipFrom, isDomestic: !isOverseas,
          ship48h: detail48h, shipHours: detail.shipHours,
          skuInfo: detail.skuInfo || "", skuOptions: detail.skuOptions || [],
          shop: detail.shop || target.shop,
          imgSrc: target.imgSrc || "", url: target.url,
          screenshotPath, rejectReason, detailOk: true
        });
        console.log(`[AI] 淘宝#${detailDone} ${(detail.title||"").slice(0,20)} ¥${detail.price} ${finalShipFrom}`);

        if (detailPage !== page) { await detailPage.close().catch(() => {}); await page.bringToFront().catch(() => {}); }
        if (!page.url().includes("s.taobao.com")) { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); }
      } catch (e) {
        console.log(`[AI] 淘宝失败: ${e.message.slice(0,40)}`);
        if (!page.url().includes("s.taobao.com")) { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); }
      }
      await randomPause(3000, 6000);
    }

    if (pg < maxPages && detailDone < maxDetail) {
      const ok = await aiTaobaoNextPage(page);
      if (!ok) break;
    }
  }

  console.log(`[AI] === 淘宝完成: ${candidates.length}个 ===`);
  return { candidates, stats: { detailDone } };
}


function randomPause(minMs, maxMs) {
  const delay = randomInt(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
