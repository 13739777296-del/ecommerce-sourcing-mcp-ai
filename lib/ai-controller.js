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
 * 京东搜索（完全模拟人类操作，慢但稳）
 */
export async function aiJdSearch(page, keyword) {
  console.log(`[AI] 京东搜索: ${keyword}`);

  // 1. 先去首页（像人一样）
  await page.goto("https://www.jd.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log(`[AI] 已打开京东首页`);
  await page.waitForTimeout(2000);

  // 2. 找到搜索框
  const searchBox = await aiFindSearchBox(page);
  if (!searchBox) {
    throw new Error("未找到搜索框");
  }

  // 3. 模拟人类：鼠标移动到搜索框
  const searchBoxBound = await searchBox.boundingBox();
  if (searchBoxBound) {
    console.log(`[AI] 鼠标移动到搜索框...`);
    await page.mouse.move(
      searchBoxBound.x + searchBoxBound.width / 2,
      searchBoxBound.y + searchBoxBound.height / 2,
      { steps: 10 }  // 分10步移动，模拟人类
    );
    await page.waitForTimeout(500);
  }

  // 4. 点击搜索框
  console.log(`[AI] 点击搜索框`);
  await searchBox.click();
  await page.waitForTimeout(800);

  // 5. 清空并输入（模拟人类打字）
  await searchBox.fill('');
  await page.waitForTimeout(300);
  console.log(`[AI] 输入关键词: ${keyword}`);
  await aiTypeText(page, keyword);
  await page.waitForTimeout(1000);

  // 6. 找搜索按钮
  const searchBtn = page.locator('button.jd_pc_search_bar_react_search_btn').first();
  const btnVisible = await searchBtn.isVisible({ timeout: 5000 }).catch(() => false);

  if (!btnVisible) {
    console.log(`[AI] 未找到搜索按钮，尝试回车`);
    await page.keyboard.press('Enter');
  } else {
    // 7. 模拟人类：鼠标移动到按钮
    const btnBound = await searchBtn.boundingBox();
    if (btnBound) {
      console.log(`[AI] 鼠标移动到搜索按钮...`);
      await page.mouse.move(
        btnBound.x + btnBound.width / 2,
        btnBound.y + btnBound.height / 2,
        { steps: 10 }
      );
      await page.waitForTimeout(500);
    }

    // 8. 点击搜索
    console.log(`[AI] 点击搜索按钮`);
    await searchBtn.click();
  }

  // 9. 等待页面跳转
  console.log(`[AI] 等待跳转到搜索结果页...`);
  await page.waitForTimeout(3000);

  // 10. 等待商品卡片出现
  try {
    await page.waitForSelector('div[data-sku]', { timeout: 20000 });
    console.log(`[AI] ✅ 商品卡片已加载`);
  } catch (e) {
    console.log(`[AI] ⚠️  等待商品超时`);
  }

  // 11. 再等一会，确保完全加载
  await page.waitForTimeout(2000);

  // 12. 模拟人类浏览（慢慢滚动）
  await aiScrollPage(page, 3);

  // 13. 检查结果
  const currentUrl = page.url();
  const productsCount = await page.locator('div[data-sku]').count();

  console.log(`[AI] 当前URL: ${currentUrl}`);
  console.log(`[AI] 找到商品: ${productsCount} 个`);

  if (!currentUrl.includes('search.jd.com') && productsCount === 0) {
    throw new Error(`搜索失败，可能被反爬拦截。当前URL: ${currentUrl}`);
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
 * 进入京东店铺首页
 * @param shopName 店铺名称（从商品卡片提取）
 */
export async function aiJdEnterShop(page, shopName) {
  console.log(`[AI] 进入店铺: ${shopName}`);

  // 在当前搜索结果页找店铺链接并点击
  const shopLink = page.locator(`a:has-text("${shopName}")`).first();
  const linkVisible = await shopLink.isVisible({ timeout: 5000 }).catch(() => false);

  if (!linkVisible) {
    // 如果找不到，直接构造店铺搜索URL
    console.log(`[AI] 未找到店铺链接，构造URL搜索店铺商品`);
    const shopUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(shopName)}&enc=utf-8`;
    await page.goto(shopUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomPause(2000, 3000);
    await aiScrollPage(page, 3);
    return { url: page.url(), title: await page.title() };
  }

  // 点击店铺链接
  await shopLink.click();
  await randomPause(2000, 3000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await aiScrollPage(page, 3);

  console.log(`[AI] ✅ 已进入店铺页面`);
  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * 提取店铺所有商品（翻页）
 * @param maxPages 最多翻几页（默认5页）
 */
export async function aiExtractShopAllProducts(page, maxPages = 5) {
  console.log(`[AI] 提取店铺所有商品，最多${maxPages}页`);

  const allProducts = [];
  const seenIds = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    console.log(`[AI] 提取第 ${pageNum} 页...`);

    // 提取当前页商品
    const products = await aiExtractJdProducts(page, 60);

    // 去重
    const newProducts = products.filter(p => {
      if (seenIds.has(p.productId)) return false;
      seenIds.add(p.productId);
      return true;
    });

    allProducts.push(...newProducts);
    console.log(`[AI] 第${pageNum}页: ${products.length}个商品, 新增${newProducts.length}个`);

    // 如果这一页没有新商品，说明到底了
    if (newProducts.length === 0) {
      console.log(`[AI] 没有新商品，停止翻页`);
      break;
    }

    // 翻页（如果还有下一页）
    if (pageNum < maxPages) {
      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector('.pn-next, a[class*="next"]:not([class*="disabled"])');
        if (nextBtn && !nextBtn.className.includes('disabled')) {
          nextBtn.click();
          return true;
        }
        return false;
      });

      if (!hasNext) {
        console.log(`[AI] 没有下一页，停止翻页`);
        break;
      }

      // 等待新页面加载
      await randomPause(2000, 3000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await aiScrollPage(page, 2);
    }
  }

  console.log(`[AI] ✅ 店铺商品提取完成，共 ${allProducts.length} 个`);
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
 * 淘宝搜索（关键词，直接构造URL）
 */
export async function aiTaobaoSearch(page, keyword) {
  console.log(`[AI] 淘宝搜索: ${keyword}`);

  // 直接构造URL（最可靠）
  const encodedKeyword = encodeURIComponent(keyword);
  const searchUrl = `https://s.taobao.com/search?q=${encodedKeyword}`;

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomPause(2000, 3000);
  await aiScrollPage(page, 3);

  console.log(`[AI] ✅ 淘宝搜索成功`);
  return {
    url: page.url(),
    title: await page.title()
  };
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
    await aiScrollPage(page, 3);

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
    // 淘宝2026：直接找所有商品链接
    const links = document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
    const results = [];
    const seenIds = new Set();

    for (let i = 0; i < links.length && results.length < max; i++) {
      const link = links[i];
      const href = link.href;

      // 提取商品ID
      const idMatch = href.match(/id=(\d+)/);
      if (!idMatch) continue;
      const productId = idMatch[1];
      if (seenIds.has(productId)) continue;
      seenIds.add(productId);

      // 获取文本内容
      const text = link.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // 标题（第一个长文本行）
      let title = '';
      for (const line of lines) {
        if (line.length > 8 && !/^¥|^\d+(\.\d+)?$/.test(line) && !/人付款|发货|包邮|优惠/.test(line)) {
          title = line;
          break;
        }
      }

      if (!title) continue;

      // 价格（找"¥"或纯数字）
      let price = '';
      for (const line of lines) {
        if (/^¥/.test(line) || /^\d+(\.\d+)?$/.test(line)) {
          price = line.replace(/[¥￥]/g, '').trim();
          if (parseFloat(price) > 0) break;
        }
      }

      // 销量（"XX人付款"）
      let sales = '';
      const salesMatch = text.match(/(\d+(?:\.\d+)?[万千]?\+?)\s*人付款/);
      if (salesMatch) {
        sales = salesMatch[1];
      }

      // 发货地（省份名）
      let shipFrom = '';
      const shipMatch = text.match(/(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/);
      if (shipMatch) {
        shipFrom = shipMatch[1];
      }
      const isDomestic = shipFrom && !/(香港|澳门|台湾)/.test(shipFrom);

      // 店铺（最后一行通常是店铺名）
      const shop = lines[lines.length - 1] || '';

      // 图片
      const img = link.querySelector('img');
      const imgSrc = img ? (img.src || img.getAttribute('data-src') || '') : '';

      results.push({
        productId,
        title,
        price,
        sales,
        shipFrom,
        isDomestic,
        shipHours: null,
        shop,
        imgSrc: imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc,
        url: href
      });
    }

    return results;
  }, maxCount);

  console.log(`[AI] 成功提取 ${products.length} 个淘宝商品`);
  if (products.length > 0) {
    console.log(`[AI] 示例: ${products[0].title.substring(0, 30)}... ¥${products[0].price} | ${products[0].shipFrom || '?'}发货`);
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
  await aiScrollPage(page, 2);

  const detail = await page.evaluate(() => {
    const text = document.body.innerText;

    // 标题
    const titleEl = document.querySelector('h1, [class*="title"], [class*="Title"]');
    const title = titleEl ? titleEl.innerText.trim() : '';

    // 价格（多种可能的位置）
    let price = '';
    const priceSelectors = [
      '[class*="price"] [class*="number"]',
      '[class*="Price"]',
      'span[class*="price"]',
      '.tb-rmb-num'
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText) {
        const priceText = el.innerText.trim().replace(/[¥￥,]/g, '');
        if (parseFloat(priceText) > 0) {
          price = priceText;
          break;
        }
      }
    }

    // SKU规格（通常在"选择"区域）
    let skuInfo = '';
    const skuEl = document.querySelector('[class*="sku"], [class*="Sku"]');
    if (skuEl) {
      skuInfo = skuEl.innerText.substring(0, 500);
    }

    // 48小时发货
    let shipHours = null;
    const shipMatch = text.match(/(\d+)\s*小时.*发货/);
    if (shipMatch) {
      shipHours = parseInt(shipMatch[1]);
    }

    // 发货地
    let shipFrom = '';
    const shipFromMatch = text.match(/(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/);
    if (shipFromMatch) {
      shipFrom = shipFromMatch[1];
    }

    // 已售/月销
    let sales = '';
    const salesMatch = text.match(/已售\s*(\d+(?:\.\d+)?[万千]?\+?)|月销\s*(\d+(?:\.\d+)?[万千]?\+?)|(\d+(?:\.\d+)?[万千]?\+?)\s*人付款/);
    if (salesMatch) {
      sales = salesMatch[1] || salesMatch[2] || salesMatch[3];
    }

    // 店铺
    let shop = '';
    const shopEl = document.querySelector('[class*="shop"], [class*="Shop"], [class*="seller"]');
    if (shopEl) {
      shop = shopEl.innerText.trim();
    }

    return {
      title,
      price,
      sales,
      shipFrom,
      shipHours,
      skuInfo,
      shop,
      url: window.location.href
    };
  });

  console.log(`[AI] 详情提取完成: ${detail.title?.substring(0, 30)}... | ¥${detail.price} | ${detail.shipFrom}发货${detail.shipHours ? `(${detail.shipHours}h)` : ''}`);

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

function randomPause(minMs, maxMs) {
  const delay = randomInt(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
