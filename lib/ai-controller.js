import { openChromeSession } from "./chrome.js";
import { pickAccount } from "./accounts.js";

/**
 * AI 驱动的浏览器控制器 - 改进版
 * 使用智能元素识别，不依赖固定选择器
 * 使用正式Chrome浏览器和已登录的账号Cookie
 */

const sessions = new Map();

/**
 * 打开AI浏览器会话（使用已登录账号）
 */
export async function openAiSessionWithAccount(ctx, db, platform, initialUrl = "about:blank") {
  const account = pickAccount(ctx, db, platform);
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
 * 京东搜索（AI驱动）
 */
export async function aiJdSearch(page, keyword) {
  console.log(`[AI] 京东搜索: ${keyword}`);

  // 1. 跳转京东首页
  await page.goto("https://www.jd.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomPause(1000, 2000);

  // 2. AI找搜索框
  const searchBox = await aiFindSearchBox(page);
  if (!searchBox) {
    throw new Error("AI未找到搜索框");
  }

  // 3. 点击并输入
  await searchBox.click();
  await randomPause(300, 600);
  await aiTypeText(page, keyword);
  await randomPause(500, 1000);

  // 4. 按回车搜索
  await page.keyboard.press("Enter");
  console.log(`[AI] 已触发搜索`);

  // 5. 等待加载
  await page.waitForLoadState("domcontentloaded");
  await randomPause(2000, 3000);

  // 6. 模拟人类浏览
  await aiScrollPage(page, 3);

  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * AI查找搜索框
 */
async function aiFindSearchBox(page) {
  // 多种可能的搜索框选择器
  const selectors = [
    'input#key',
    'input[name="keyword"]',
    'input[placeholder*="搜索"]',
    'input[type="text"]',
    'input[type="search"]'
  ];

  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      const isVisible = await element.isVisible({ timeout: 1000 }).catch(() => false);
      if (isVisible) {
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
async function aiScrollPage(page, times = 3) {
  for (let i = 0; i < times; i++) {
    const distance = randomInt(200, 500);
    await page.mouse.wheel(0, distance);
    await randomPause(800, 1500);
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
 * 点击商品进入详情（深度模仿人类操作）
 * 京东新版用JS跳转，需要点击图片或标题区域
 */
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
  await card.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await randomPause(800, 1500);

  // 2. 找图片（点击图片是最自然的人类操作）
  const img = card.locator('img').first();
  const imgVisible = await img.isVisible({ timeout: 3000 }).catch(() => false);

  // 3. hover一下图片
  if (imgVisible) {
    await img.hover({ timeout: 5000 }).catch(() => {});
  } else {
    await card.hover({ timeout: 5000 }).catch(() => {});
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
    await clickTarget.click({ timeout: 10000, force: false });
  } catch (e) {
    console.log(`[AI] 直接点击失败，尝试点击卡片: ${e.message}`);
    await card.click({ timeout: 10000, force: true });
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
  await randomPause(2000, 3500);

  // 7. 模拟查看
  await aiScrollPage(detailPage, 2);

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
  await aiScrollPage(page, 2);
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

    // 店铺
    let shop = '';
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
      skuInfo,
      params
    };
  });

  console.log(`[AI] 详情提取完成: ${detail.title.substring(0, 30)}... | ¥${detail.price} | 已售${detail.sales}`);

  return detail;
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

// ============ 淘宝部分 ============

/**
 * 淘宝搜索（AI驱动）
 */
export async function aiTaobaoSearch(page, keyword) {
  console.log(`[AI] 淘宝搜索: ${keyword}`);

  // 1. 跳转淘宝首页
  await page.goto("https://www.taobao.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomPause(1500, 2500);

  // 2. AI找搜索框
  const searchBox = page.locator('input#q, input[name="q"], input[placeholder*="搜索"]').first();
  const isVisible = await searchBox.isVisible({ timeout: 5000 }).catch(() => false);
  if (!isVisible) {
    throw new Error("淘宝搜索框未找到");
  }

  // 3. 点击并输入
  await searchBox.click();
  await randomPause(300, 600);
  await aiTypeText(page, keyword);
  await randomPause(500, 1000);

  // 4. 按回车
  await page.keyboard.press("Enter");
  console.log(`[AI] 已触发淘宝搜索`);

  await page.waitForLoadState("domcontentloaded");
  await randomPause(2000, 3000);
  await aiScrollPage(page, 3);

  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * 提取淘宝商品列表
 */
export async function aiExtractTaobaoProducts(page, maxCount = 10) {
  console.log(`[AI] 提取淘宝商品列表，最多${maxCount}个`);

  const products = await page.evaluate((max) => {
    // 淘宝的商品卡片选择器（多个候选）
    const selectors = [
      'div[class*="Card"][class*="content"]',
      'div[class*="item"][class*="J_MouserOnverReq"]',
      '.items .item',
      'a[href*="item.taobao.com"]',
      'a[href*="detail.tmall.com"]'
    ];

    let cards = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length >= 3) {
        cards = Array.from(found);
        break;
      }
    }

    // 如果上面都没找到，用通用方法：找所有指向商品详情的链接
    if (cards.length === 0) {
      const links = document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
      const seen = new Set();
      cards = Array.from(links).filter(a => {
        const href = a.href;
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return false;
        if (seen.has(idMatch[1])) return false;
        seen.add(idMatch[1]);
        // 找到包含这个链接的卡片父元素
        return true;
      }).map(a => a.closest('div[class*="item"]') || a.closest('div[class*="card"]') || a.parentElement);
    }

    const results = [];
    const seenIds = new Set();

    for (let i = 0; i < cards.length && results.length < max; i++) {
      const card = cards[i];
      if (!card) continue;

      const text = card.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // 找商品ID
      const link = card.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]') ||
                   (card.tagName === 'A' ? card : null);
      if (!link) continue;

      const idMatch = link.href.match(/id=(\d+)/);
      if (!idMatch) continue;
      const productId = idMatch[1];
      if (seenIds.has(productId)) continue;
      seenIds.add(productId);

      // 标题
      let title = '';
      for (const line of lines) {
        if (line.length > 8 && !/^¥|^\d+\.\d+$/.test(line) && !/付款|月销|人付款/.test(line)) {
          title = line;
          break;
        }
      }

      // 价格
      let price = '';
      const priceLine = lines.find(l => /^¥|￥/.test(l) || /^\d+\.\d{2}$/.test(l));
      if (priceLine) {
        price = priceLine.replace(/[¥￥]/g, '').trim();
      }

      // 销量
      const salesLine = lines.find(l => /付款|月销|已售/.test(l));
      const sales = salesLine || '';

      // 店铺
      const shopEl = card.querySelector('[class*="shop"], [class*="Shop"]');
      const shop = shopEl ? shopEl.innerText.trim() : '';

      // 图片
      const img = card.querySelector('img');
      const imgSrc = img ? (img.src || img.getAttribute('data-src') || '') : '';

      if (title) {
        results.push({
          productId,
          title,
          price,
          sales,
          shop,
          imgSrc: imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc,
          url: link.href
        });
      }
    }

    return results;
  }, maxCount);

  console.log(`[AI] 成功提取 ${products.length} 个淘宝商品`);
  if (products.length > 0) {
    console.log(`[AI] 示例: ${products[0].title.substring(0, 30)}... ¥${products[0].price}`);
  }

  return products;
}

function randomPause(minMs, maxMs) {
  const delay = randomInt(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
