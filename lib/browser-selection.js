import { openChromeSession } from "./chrome.js";
import {
  assessSameProductMatch,
  assessProfit,
  buildTaobaoSearchKeywords,
  dedupeByProductId,
  evaluateJdCandidates,
  evaluateTaobaoCandidates,
  extractBrand,
  jdProductIdFromUrl,
  jdRejectReason,
  normalizeImageUrl,
  normalizeProductUrl,
  parseCommentCount,
  parsePrice,
  parseSalesCount,
  parseShippingHours,
  parseSkuProfile,
  coreProductMatched,
  relevanceScore,
  summarizeRejectReasons,
  taobaoProductId,
  taobaoRejectReason,
  unitPrice
} from "./logic.js";
import { resolveStrategyProfile } from "./strategy.js";
import { captureClipScreenshot, captureLocatorScreenshot, capturePageScreenshot, saveProductImage } from "./artifacts.js";

const DEFAULT_SELECTION_CHROME_SESSION_OPTIONS = {
  keepAlive: true,
  closeOtherPages: false,
  newPage: true
};

export class SelectionFlowError extends Error {
  constructor(message, failure = "technical", eventType = "element_missing") {
    super(message);
    this.failure = failure;
    this.eventType = eventType;
  }
}

export async function runSelectionFlow(ctx, db, input) {
  const { profile: strategyProfile, strategy } = resolveStrategyProfile(db, input, readConfigStrategy(ctx));
  const normalizedInput = {
    keyword: String(input.keyword || "").trim(),
    jdUrl: String(input.jdUrl || "").trim()
  };
  if (!normalizedInput.keyword && !normalizedInput.jdUrl) {
    throw new Error("请提供 keyword 或 jdUrl。");
  }

  const runId = db.startRun({
    ...normalizedInput,
    strategyProfileId: strategyProfile.id,
    strategy
  });
  const browserSessionOptions = buildSelectionBrowserSessionOptions(input);
  db.addLog(runId, "info", `采用策略：${strategyProfile.name}（${strategyProfile.id}），京东 ${strategy.jdPages} 页，京东候选 ${strategy.maxJdCandidates} 个，淘宝逐品 ${strategy.maxTaobaoSearches} 个，关键词尝试 ${strategy.maxTaobaoKeywordAttempts} 组。`);
  db.addLog(runId, "info", browserSessionOptions.keepAlive
    ? "浏览器会话：任务使用新标签页执行，结束后保留 Chrome 窗口，便于用户查看过程。"
    : "浏览器会话：任务使用新标签页执行，结束后关闭本次受控 Chrome。");
  try {
    const jdRaw = await collectWithAccounts(db, runId, "jd", "京东观察", (jdAccount) =>
      normalizedInput.jdUrl
        ? collectJdDetail(ctx, db, runId, jdAccount, normalizedInput.jdUrl, browserSessionOptions)
        : collectJdCandidates(ctx, db, runId, jdAccount, normalizedInput.keyword, strategy, browserSessionOptions)
    );

    const jdEvaluated = normalizedInput.jdUrl
      ? jdRaw
      : evaluateJdCandidates(jdRaw, strategy).slice(0, strategy.maxJdCandidates);
    for (const item of jdRaw) {
      const passed = jdEvaluated.some((candidate) => candidate.productId === item.productId);
      db.saveCandidate(runId, item, passed ? "passed" : "rejected", passed ? "京东候选通过" : jdRejectReason(item, strategy));
      if (passed) await saveProductImage(ctx, db, runId, item, "京东主图");
    }
    db.updateRun(runId, { jdRawCount: jdRaw.length, jdFilteredCount: jdEvaluated.length });
    db.addLog(runId, "info", `京东观察完成：原始 ${jdRaw.length} 个，通过 ${jdEvaluated.length} 个。`);

    if (jdEvaluated.length === 0) {
      const summary = summarizeRejectReasons(jdRaw.map((item) => jdRejectReason(item, strategy)));
      db.updateRun(runId, { status: "paused", completedAt: new Date().toISOString() });
      db.addLog(runId, "warning", `没有找到符合条件的京东候选。${summary ? `主要原因：${summary}` : ""}`);
      return buildResult(db, runId, false, "没有找到符合条件的京东候选商品。");
    }

    let taobaoRawCount = 0;
    let taobaoFilteredCount = 0;
    let eligibleCount = 0;
    const jdToCompare = jdEvaluated.slice(0, strategy.maxTaobaoSearches);

    for (const jdProduct of jdToCompare) {
      const taobaoKeywords = (input.taobaoKeyword?.trim()
        ? [input.taobaoKeyword.trim()]
        : buildTaobaoSearchKeywords({ brand: extractBrand(jdProduct.title), title: jdProduct.title })
      ).slice(0, strategy.maxTaobaoKeywordAttempts);
      let taobaoEvaluated = [];
      for (const taobaoKeyword of taobaoKeywords) {
        db.appendRunTaobaoKeyword(runId, {
          jdProductId: jdProduct.productId,
          jdTitle: jdProduct.title,
          keyword: taobaoKeyword
        });
        db.addLog(runId, "info", `淘宝逐品搜索：${taobaoKeyword}`);
        const taobaoRaw = await collectWithAccounts(db, runId, "taobao", "淘宝供货观察", (taobaoAccount) =>
          collectTaobaoCandidates(ctx, db, runId, taobaoAccount, taobaoKeyword, {
            imagePath: jdProduct.visualSearchImagePath || "",
            browserSessionOptions
          })
        );
        const platformPassedTaobao = evaluateTaobaoCandidates(taobaoRaw, strategy);
        const sameProductReviews = new Map();
        taobaoEvaluated = platformPassedTaobao
          .map((item) => {
            const review = assessSameProductMatch(jdProduct, item, taobaoKeyword);
            sameProductReviews.set(item.productId, review);
            return { ...item, sameProductReview: review };
          })
          .filter((item) => item.sameProductReview.matched)
          .sort((a, b) => a.unitPrice - b.unitPrice);
        taobaoRawCount += taobaoRaw.length;
        taobaoFilteredCount += taobaoEvaluated.length;
        const sameProductRejected = platformPassedTaobao.length - taobaoEvaluated.length;
        if (sameProductRejected > 0) {
          db.addLog(runId, "warning", `同款复核淘汰 ${sameProductRejected} 个淘宝候选，避免错品进入利润计算。`);
        }
        for (const item of taobaoRaw) {
          const review = sameProductReviews.get(item.productId);
          const passed = Boolean(review?.matched);
          const reason = review
            ? (passed ? `淘宝供货同款通过：${review.reason}` : `同款复核失败：${review.reason}`)
            : taobaoRejectReason(item, strategy);
          const productForSave = review ? { ...item, sameProductReview: review } : item;
          db.saveCandidate(runId, productForSave, passed ? "passed" : "rejected", reason);
          if (passed) await saveProductImage(ctx, db, runId, productForSave, "淘宝供货主图");
        }
        if (taobaoEvaluated.length > 0) break;
        db.addLog(runId, "warning", `淘宝关键词没有找到合格供货：${taobaoKeyword}`);
      }

      const taobaoProduct = taobaoEvaluated[0];
      if (!taobaoProduct) {
        db.addLog(runId, "warning", `淘宝没有找到满足同款相关性、国内发货、销量和时效要求的供货：${jdProduct.title}`);
        continue;
      }
      const profit = assessProfit({
        jdTotalPrice: jdProduct.price,
        jdUnitPrice: jdProduct.unitPrice,
        taobaoUnitPrice: taobaoProduct.unitPrice
      });
      const qualified = Boolean(taobaoEvaluated[0]) && profit.qualified;
      if (qualified) eligibleCount += 1;
      db.saveMatch(runId, {
        jdProductId: jdProduct.productId,
        taobaoProductId: taobaoProduct.productId,
        status: qualified ? "qualified" : "eliminated",
        profitRate: profit.profitRate,
        profitAmount: profit.profitAmount,
        listingPrice: jdProduct.price,
        taobaoCost: taobaoProduct.unitPrice,
        reason: taobaoEvaluated[0]
          ? `${profit.reason}；${taobaoProduct.sameProductReview?.reason || "同款复核通过"}`
          : "没有找到满足同款相关性、国内发货、销量和时效要求的淘宝供货商品"
      });
      db.addLog(
        runId,
        qualified ? "info" : "warning",
        `${qualified ? "利润达标" : "商品淘汰"}：${jdProduct.title.slice(0, 28)}，利润 ${profit.profitAmount.toFixed(2)} 元，利润率 ${(profit.profitRate * 100).toFixed(1)}%。`
      );
    }

    db.updateRun(runId, {
      status: "completed",
      taobaoRawCount,
      taobaoFilteredCount,
      eligibleCount,
      completedAt: new Date().toISOString()
    });
    db.addLog(runId, "info", `选品完成：逐个比价 ${jdToCompare.length} 个京东候选，利润达标 ${eligibleCount} 个。`);
    return buildResult(db, runId, true, `选品完成，利润达标 ${eligibleCount} 个。`);
  } catch (error) {
    const flowError = normalizeFlowError(error);
    if (input?.jdUrl || input?.keyword) {
      db.addLog(runId, flowError.failure === "platform_risk" ? "critical" : "warning", `任务暂停：${flowError.message}`);
      db.updateRun(runId, { status: "paused", completedAt: new Date().toISOString() });
      pauseRiskyAccounts(db, flowError);
    }
    return buildResult(db, runId, false, flowError.message);
  }
}

async function collectWithAccounts(db, runId, platform, label, collect) {
  const accounts = db.listAccounts(platform).filter((account) => account.status === "available");
  if (accounts.length === 0) {
    throw new SelectionFlowError(`${platform === "jd" ? "京东" : "淘宝"}没有可用账号，请先检查账号池登录状态。`, "login", "login_expired");
  }

  let lastError = null;
  for (const account of accounts) {
    db.updateAccount(account.id, "in_use", `正在执行${label}`);
    try {
      const products = await collect(account);
      db.updateAccount(account.id, "available", `${label}完成`);
      return products;
    } catch (error) {
      const flowError = normalizeFlowError(error);
      lastError = flowError;
      if (flowError.failure === "platform_risk") {
        db.updateAccount(account.id, "paused", flowError.message);
        db.addLog(runId, "critical", `${account.displayName} 触发平台风险：${flowError.message}`);
        throw flowError;
      }
      if (flowError.failure === "login") {
        db.updateAccount(account.id, "login_required", flowError.message);
        db.addLog(runId, "warning", `${account.displayName} 登录态不可用，尝试下一个账号。`);
        continue;
      }
      db.updateAccount(account.id, "available", flowError.message);
      throw flowError;
    }
  }
  throw lastError || new SelectionFlowError(`${platform === "jd" ? "京东" : "淘宝"}账号池没有完成${label}`, "login", "login_expired");
}

export function buildSelectionBrowserSessionOptions(input = {}) {
  return {
    ...DEFAULT_SELECTION_CHROME_SESSION_OPTIONS,
    keepAlive: input.keepBrowserOpen !== false,
    newPage: input.openTaskTab !== false
  };
}

async function collectJdCandidates(ctx, db, runId, account, keyword, strategy, browserSessionOptions = DEFAULT_SELECTION_CHROME_SESSION_OPTIONS) {
  const session = await openChromeSession(account.profileDir, "about:blank", browserSessionOptions);
  try {
    db.addLog(runId, "info", `京东浏览器：打开首页，点击搜索框，输入关键词“${keyword}”。`);
    const products = [];
    const searchState = await searchWithBrowserAgent(session.page, "jd", keyword);
    logSearchState(db, runId, "京东", searchState, keyword);
    for (let pageNumber = 1; pageNumber <= strategy.jdPages; pageNumber += 1) {
      await sleepHuman(session.page, 1600, 2600);
      await assertPageCanContinue(session.page, "jd");
      await browseLightly(session.page);
      await assertPageCanContinue(session.page, "jd");
      const pageProducts = await extractJdCards(session.page, account.id);
      if (pageProducts.length === 0) {
        throw new SelectionFlowError(await pageExtractionMessage(session.page, "京东搜索页没有识别到商品卡片"), "technical", "element_missing");
      }
      await capturePageScreenshot(ctx, db, runId, session.page, { platform: "jd", label: `京东搜索页-${pageNumber}` });
      products.push(...pageProducts);
      if (pageNumber < strategy.jdPages) {
        const moved = await goToNextResultPage(session.page, "jd");
        if (!moved) break;
      }
    }
    const deduped = dedupeByProductId(products).sort((a, b) => a.price - b.price);
    const detailTargets = selectJdCardsForDetailProbe(deduped, strategy);
    if (detailTargets.length === 0) return deduped;

    db.addLog(runId, "info", `京东搜索页先找到 ${deduped.length} 个候选，进入 ${detailTargets.length} 个详情页复核评论、SKU 和主图。`);
    const detailed = await hydrateJdSearchCandidates(ctx, db, runId, session.page, account.id, detailTargets);
    return detailed.length > 0 ? dedupeByProductId(detailed).sort((a, b) => a.price - b.price) : deduped;
  } finally {
    await session.close();
  }
}

async function hydrateJdSearchCandidates(ctx, db, runId, page, sourceAccountId, products) {
  const detailed = [];
  for (const searchProduct of products) {
    if (!searchProduct?.url) continue;
    try {
      db.addLog(runId, "info", `进入京东详情页复核：${searchProduct.title.slice(0, 36)}`);
      await page.goto(searchProduct.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleepHuman(page, 1800, 3200);
      await assertPageCanContinue(page, "jd");
      await browseLightly(page);
      await assertPageCanContinue(page, "jd");
      const detailProduct = await extractJdDetailCandidate(page, sourceAccountId, page.url());
      if (!detailProduct) {
        db.addLog(runId, "warning", `京东详情页未识别到完整商品信息：${searchProduct.title.slice(0, 36)}`);
        detailed.push(searchProduct);
        continue;
      }
      const merged = mergeJdSearchCardWithDetail(searchProduct, detailProduct);
      const visuals = await captureJdDetailVisuals(ctx, db, runId, page, merged);
      const enriched = { ...merged, ...visuals };
      await capturePageScreenshot(ctx, db, runId, page, { platform: "jd", productId: enriched.productId, label: `京东详情页-${enriched.productId}` });
      detailed.push(enriched);
    } catch (error) {
      const flowError = normalizeFlowError(error);
      if (flowError.failure === "platform_risk" || flowError.failure === "login") throw flowError;
      db.addLog(runId, "warning", `京东详情复核失败，保留搜索页候选：${flowError.message}`);
      detailed.push(searchProduct);
    }
  }
  return detailed;
}

async function collectJdDetail(ctx, db, runId, account, jdUrl, browserSessionOptions = DEFAULT_SELECTION_CHROME_SESSION_OPTIONS) {
  const session = await openChromeSession(account.profileDir, jdUrl, browserSessionOptions);
  try {
    db.addLog(runId, "info", "京东浏览器：打开用户提供的京东商品链接，观察标题、价格、主图和规格。");
    await session.page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => undefined);
    await sleepHuman(session.page, 1800, 3200);
    await assertPageCanContinue(session.page, "jd");
    await browseLightly(session.page);
    const product = await extractJdDetailCandidate(session.page, account.id, jdUrl);
    if (!product) throw new SelectionFlowError(await pageExtractionMessage(session.page, "京东详情页没有识别到商品信息"), "technical", "element_missing");
    const visuals = await captureJdDetailVisuals(ctx, db, runId, session.page, product);
    const enriched = { ...product, ...visuals };
    await capturePageScreenshot(ctx, db, runId, session.page, { platform: "jd", productId: enriched.productId, label: "京东详情页" });
    return [enriched];
  } finally {
    await session.close();
  }
}

export function selectJdCardsForDetailProbe(products, strategy = {}) {
  const maxJdCandidates = Math.max(1, Number(strategy?.maxJdCandidates || 1));
  const detailLimit = Math.min(12, Math.max(2, maxJdCandidates * 2));
  const unique = dedupeByProductId(Array.isArray(products) ? products : [])
    .filter((item) => item?.productId && Number(item.price) > 0);
  const buyerStore = unique.filter((item) => item.isBuyerStore);
  const pool = buyerStore.length > 0 ? buyerStore : unique;
  return pool
    .sort((a, b) => {
      if (Boolean(a.isBuyerStore) !== Boolean(b.isBuyerStore)) return a.isBuyerStore ? -1 : 1;
      return Number(a.price || 0) - Number(b.price || 0);
    })
    .slice(0, detailLimit);
}

export function mergeJdSearchCardWithDetail(searchProduct = {}, detailProduct = {}) {
  const title = isUsefulJdTitle(detailProduct.title) ? detailProduct.title : searchProduct.title || detailProduct.title || "";
  const price = Number(detailProduct.price || searchProduct.price || 0);
  const sku = parseSkuProfile(detailProduct.skuText || title || searchProduct.skuText || "");
  const productId = detailProduct.productId || searchProduct.productId || jdProductIdFromUrl(detailProduct.url || searchProduct.url) || title;
  return {
    ...searchProduct,
    ...detailProduct,
    platform: "jd",
    productId,
    title,
    url: normalizeProductUrl(detailProduct.url || searchProduct.url || productId, "jd"),
    price,
    unitPrice: unitPrice(price, sku),
    skuText: detailProduct.skuText || title || searchProduct.skuText || "",
    shopName: detailProduct.shopName || searchProduct.shopName || "",
    mainImageUrl: detailProduct.mainImageUrl || searchProduct.mainImageUrl || "",
    sourceAccountId: detailProduct.sourceAccountId || searchProduct.sourceAccountId || "",
    isBuyerStore: Boolean(searchProduct.isBuyerStore || detailProduct.isBuyerStore),
    commentCount: Number.isFinite(Number(detailProduct.commentCount)) && Number(detailProduct.commentCount) > 0
      ? Number(detailProduct.commentCount)
      : Number(searchProduct.commentCount || 0)
  };
}

function isUsefulJdTitle(title = "") {
  const value = String(title || "").replace(/\s+/g, " ").trim();
  if (value.length < 8) return false;
  if (/计算器|京东首页|购物车|商品详情|加入购物车|立即购买|不分期|白条|优惠券|联系客服|请选择|规格参数/.test(value)) return false;
  return /(?:Swisse|斯维诗|辅酶|Q10|胶囊|软胶囊|保健品|维生素|NAD|鱼油|益生菌|护肝|奶蓟|水飞蓟|叶黄素|葡萄籽|卵磷脂|草本)/i.test(value);
}

async function captureJdDetailVisuals(ctx, db, runId, page, product) {
  const result = {
    visualSearchImagePath: "",
    visualContextImagePath: ""
  };
  const productId = product?.productId || "";

  const mainImage = await firstVisibleLocatorOrNull(page, [
    "#spec-img",
    "#preview img",
    ".jqzoom img",
    "#preview [class*='jqzoom'] img",
    "[class*='preview'] img[src*='360buyimg']"
  ]);
  if (mainImage) {
    result.visualSearchImagePath = await captureLocatorScreenshot(ctx, db, runId, mainImage, {
      platform: "jd",
      productId,
      artifactType: "jd_main_image_crop",
      label: `京东主图裁剪-${productId}`,
      sourceUrl: page.url()
    });
  }

  const leftBox = await firstVisibleBox(page, ["#preview", ".preview-wrap", ".jqzoom", "#spec-img", "#preview img"]);
  const rightBox = await firstVisibleBox(page, [".itemInfo-wrap", ".product-intro", ".sku-name", ".summary", "[class*='sku-name']"]);
  const contextClip = unionBoxes([leftBox, rightBox], 18);
  if (contextClip) {
    result.visualContextImagePath = await captureClipScreenshot(ctx, db, runId, page, contextClip, {
      platform: "jd",
      productId,
      artifactType: "jd_detail_context_crop",
      label: `京东详情识别裁剪-${productId}`
    });
  }

  return result;
}

async function firstVisibleLocatorOrNull(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) return locator;
  }
  return null;
}

async function firstVisibleBox(page, selectors) {
  const locator = await firstVisibleLocatorOrNull(page, selectors);
  if (!locator) return null;
  return locator.boundingBox().catch(() => null);
}

function unionBoxes(boxes, padding = 0) {
  const valid = boxes.filter((box) => box && box.width > 5 && box.height > 5);
  if (valid.length === 0) return null;
  const x1 = Math.min(...valid.map((box) => box.x)) - padding;
  const y1 = Math.min(...valid.map((box) => box.y)) - padding;
  const x2 = Math.max(...valid.map((box) => box.x + box.width)) + padding;
  const y2 = Math.max(...valid.map((box) => box.y + box.height)) + padding;
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  };
}

async function collectTaobaoCandidates(ctx, db, runId, account, keyword, options = {}) {
  const session = await openChromeSession(account.profileDir, "about:blank", options.browserSessionOptions || DEFAULT_SELECTION_CHROME_SESSION_OPTIONS);
  try {
    const imagePath = String(options.imagePath || "").trim();
    db.addLog(runId, "info", imagePath
      ? `淘宝浏览器：优先使用京东主图以图搜图，失败后再文字搜索“${keyword}”。`
      : `淘宝浏览器：打开首页，点击搜索框，输入“${keyword}”。`);
    const searchState = await searchTaobaoByImageOrKeyword(session.page, keyword, imagePath);
    logSearchState(db, runId, "淘宝", searchState, keyword);
    await sleepHuman(session.page, 2200, 4200);
    await assertPageCanContinue(session.page, "taobao");
    await browseLightly(session.page);
    await assertPageCanContinue(session.page, "taobao");
    const products = await extractTaobaoCards(session.page, account.id, keyword);
    if (products.length === 0) {
      throw new SelectionFlowError(await pageExtractionMessage(session.page, "淘宝搜索页没有识别到商品卡片"), "technical", "element_missing");
    }
    await capturePageScreenshot(ctx, db, runId, session.page, { platform: "taobao", label: searchState.mode === "image" ? `淘宝以图搜图-${keyword}` : `淘宝搜索页-${keyword}` });
    return dedupeByProductId(products).sort((a, b) => a.unitPrice - b.unitPrice);
  } finally {
    await session.close();
  }
}

async function searchTaobaoByImageOrKeyword(page, keyword, imagePath) {
  if (imagePath) {
    try {
      const imageState = await searchTaobaoByImage(page, imagePath);
      if (imageState.ok) return imageState;
    } catch (error) {
      // Fall back to keyword search. The caller logs the final search state.
    }
  }
  return {
    ...(await searchWithBrowserAgent(page, "taobao", keyword)),
    mode: "text"
  };
}

async function searchTaobaoByImage(page, imagePath) {
  await page.goto("https://www.taobao.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleepHuman(page, 2200, 3600);
  await dismissKnownPassiveDialogs(page);
  await assertPageCanContinue(page, "taobao");

  const directUpload = await firstVisibleLocatorOrNull(page, [
    "input[type='file'][accept*='image']",
    "input[type='file']"
  ]);
  if (directUpload) {
    await directUpload.setInputFiles(imagePath);
  } else {
    const uploadTriggers = [
      "button:has-text('搜同款')",
      "a:has-text('搜同款')",
      "button:has-text('图片')",
      "a:has-text('图片')",
      "[aria-label*='图片']",
      "[aria-label*='相机']",
      "[class*='camera']",
      "[class*='image-search']",
      "[class*='imgsearch']"
    ];
    const trigger = await firstVisibleLocatorOrNull(page, uploadTriggers);
    if (!trigger) throw new SelectionFlowError("淘宝以图搜图入口未找到", "technical", "element_missing");
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 7000 }).catch(() => null);
    await clickLikeUser(page, trigger);
    const chooser = await chooserPromise;
    if (!chooser) throw new SelectionFlowError("淘宝以图搜图没有弹出图片选择器", "technical", "element_missing");
    await chooser.setFiles(imagePath);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
  await sleepHuman(page, 3500, 5600);
  await dismissKnownPassiveDialogs(page);
  await assertPageCanContinue(page, "taobao");
  await waitForSearchOutcome(page, "taobao");
  return {
    ok: true,
    fallbackUsed: false,
    mode: "image",
    finalUrl: page.url(),
    visibleInputValue: ""
  };
}

export async function searchWithBrowserAgent(page, platform, keyword) {
  const targetUrl = platform === "jd" ? "https://www.jd.com/" : "https://www.taobao.com/";
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleepHuman(page, platform === "jd" ? 1400 : 2200, platform === "jd" ? 2400 : 3600);
  await dismissKnownPassiveDialogs(page);

  const searchInput = await firstVisibleLocator(
    page,
    platform === "jd"
      ? ["#key", "input[name='keyword']", ".search input[type='text']", "input[placeholder*='搜索']", "input[type='text']"]
      : ["#q", "input[name='q']", "input[placeholder*='搜索']", "input[type='search']", "input[type='text']"],
    platform === "jd" ? "京东搜索框" : "淘宝搜索框"
  );
  await setSearchInputLikeUser(page, searchInput, keyword);
  await sleepHuman(page, 400, 900);
  await dismissKnownPassiveDialogs(page);

  const beforeUrl = page.url();
  const clickedSearch = await clickFirstVisible(
    page,
    platform === "jd"
      ? [
          "button:has-text('搜索')",
          "#search button[class*='search_btn']",
          "button[class*='search_btn']",
          "#J_searchBtn",
          ".search button:has-text('搜索')",
          "input[type='submit'][value*='搜索']",
          "input[type='button'][value*='搜索']"
        ]
      : ["button:has-text('搜索')", ".btn-search", "button[type='submit']", "input[type='submit'][value*='搜索']"],
    2500
  );
  if (!clickedSearch) await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
  await sleepHuman(page, platform === "jd" ? 2600 : 3400, platform === "jd" ? 4200 : 5200);
  await dismissKnownPassiveDialogs(page);
  if ((await productCardCount(page, platform)) === 0 && page.url() === beforeUrl) {
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await sleepHuman(page, platform === "jd" ? 2200 : 3000, platform === "jd" ? 3600 : 4600);
    await dismissKnownPassiveDialogs(page);
  }
  if ((await productCardCount(page, platform)) === 0 && page.url() === beforeUrl) {
    await submitSearchForm(page, platform).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await sleepHuman(page, platform === "jd" ? 2200 : 3000, platform === "jd" ? 3600 : 4600);
    await dismissKnownPassiveDialogs(page);
  }
  const searchState = await ensureSearchSubmittedForKeyword(page, platform, keyword, searchInput);
  await waitForSearchOutcome(page, platform, keyword);
  return searchState;
}

function logSearchState(db, runId, platformLabel, searchState, keyword) {
  if (searchState?.fallbackUsed) {
    db.addLog(runId, "warning", `${platformLabel}搜索框没有稳定停留在目标词，已打开搜索结果页继续：${keyword}`);
    return;
  }
  db.addLog(runId, "info", `${platformLabel}搜索确认：${keyword}`);
}

async function ensureSearchSubmittedForKeyword(page, platform, keyword, inputLocator) {
  const visibleInputValue = await readCurrentSearchValue(page, platform, inputLocator);
  if (searchPageReflectsKeyword(platform, page.url(), visibleInputValue, keyword) && (isSearchResultUrl(page.url(), platform) || (await productCardCount(page, platform)) > 0)) {
    return { fallbackUsed: false, finalUrl: page.url(), visibleInputValue };
  }

  const fallbackUrl = buildSearchResultUrl(platform, keyword);
  await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleepHuman(page, platform === "jd" ? 2200 : 3000, platform === "jd" ? 3600 : 4800);
  await dismissKnownPassiveDialogs(page);
  await assertPageCanContinue(page, platform);
  const fallbackInputValue = await readCurrentSearchValue(page, platform, inputLocator);
  if (!searchPageReflectsKeyword(platform, page.url(), fallbackInputValue, keyword)) {
    throw new SelectionFlowError("搜索页没有确认到目标关键词，任务暂停，避免拿旧页面商品参与比价。", "technical", "element_missing");
  }
  return { fallbackUsed: true, finalUrl: page.url(), visibleInputValue: fallbackInputValue };
}

async function setSearchInputLikeUser(page, locator, keyword) {
  await clickLikeUser(page, locator);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.waitForTimeout(180).catch(() => undefined);
  await page.keyboard.insertText(String(keyword)).catch(() => undefined);
  await page.waitForTimeout(220).catch(() => undefined);
  if (await inputContainsKeyword(locator, keyword)) return;

  await clickLikeUser(page, locator);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await typeLikeUser(page, keyword);
  await page.waitForTimeout(220).catch(() => undefined);
  if (await inputContainsKeyword(locator, keyword)) return;

  await locator.fill(String(keyword), { timeout: 3000 });
  await locator.evaluate((input) => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => undefined);
  if (!(await inputContainsKeyword(locator, keyword))) {
    throw new SelectionFlowError("搜索框输入校准失败，请检查页面是否被弹窗或旧搜索状态占用。", "technical", "element_missing");
  }
}

async function inputContainsKeyword(locator, keyword) {
  const actual = await locator.inputValue({ timeout: 1500 }).catch(() => "");
  return normalizeSearchValue(actual) === normalizeSearchValue(keyword);
}

async function assertPageCanContinue(page, platform) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  const productLinks = await productCardCount(page, platform);
  const risk = detectRisk(text, productLinks, url, title, platform);
  if (risk) throw risk;
}

function detectRisk(text, productLinks, url, title, platform) {
  if (/验证码|滑块|安全验证|baxia|captcha|punish/i.test(text)) {
    return new SelectionFlowError("页面要求验证码或安全验证，任务暂停，等待用户处理。", "platform_risk", "captcha");
  }
  if (/访问频繁|操作频繁|请求过于频繁|稍后再试/.test(text)) {
    return new SelectionFlowError("页面提示访问频繁，任务暂停。", "platform_risk", "access_frequent");
  }
  if (/账号异常|账户异常|风险提示|环境异常/.test(text)) {
    return new SelectionFlowError("页面提示账号或环境风险，任务暂停。", "platform_risk", "account_abnormal");
  }
  if (isKnownLoginPage(platform, url, title, text, productLinks)) {
    return new SelectionFlowError("账号登录态不可用，请先登录该账号。", "login", "login_expired");
  }
  return null;
}

function isKnownLoginPage(platform, url, title, text, productLinks) {
  if (/passport\.jd\.com|login\.taobao\.com|login\.tmall\.com|login\.jd\.com/i.test(url)) return true;
  if (productLinks > 0) return false;
  const pageText = `${title}\n${text}`;
  if (!/请登录|账号登录|密码登录|扫码登录|欢迎登录|亲，请登录|您需要登录/i.test(pageText)) return false;
  return platform === "jd" ? /京东|JD/i.test(pageText) : /淘宝|天猫|Taobao|Tmall/i.test(pageText);
}

async function waitForSearchOutcome(page, platform, keyword = "") {
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    await assertPageCanContinue(page, platform);
    const currentInputValue = keyword ? await readCurrentSearchValue(page, platform).catch(() => "") : "";
    const keywordConfirmed = keyword ? searchPageReflectsKeyword(platform, page.url(), currentInputValue, keyword) : true;
    if (keywordConfirmed && ((await productCardCount(page, platform)) > 0 || isSearchResultUrl(page.url(), platform))) return;
    await page.waitForTimeout(750).catch(() => undefined);
  }
}

function isSearchResultUrl(url, platform) {
  return platform === "jd" ? /search\.jd\.com\/Search/i.test(url) : /s\.taobao\.com\/search|list\.tmall\.com/i.test(url);
}

export function buildSearchResultUrl(platform, keyword) {
  const encodedKeyword = encodeURIComponent(String(keyword || "").trim());
  return platform === "jd"
    ? `https://search.jd.com/Search?keyword=${encodedKeyword}&enc=utf-8`
    : `https://s.taobao.com/search?q=${encodedKeyword}`;
}

export function searchPageReflectsKeyword(platform, url, inputValue, keyword) {
  const target = normalizeSearchValue(keyword);
  if (!target) return false;
  if (normalizeSearchValue(inputValue) === target) return true;
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const paramNames = platform === "jd" ? ["keyword", "key", "wd"] : ["q", "keyword", "key"];
  return paramNames.some((name) => normalizeSearchValue(parsed.searchParams.get(name)) === target);
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

async function readCurrentSearchValue(page, platform, preferredLocator = null) {
  if (preferredLocator && await preferredLocator.isVisible({ timeout: 500 }).catch(() => false)) {
    const value = await preferredLocator.inputValue({ timeout: 900 }).catch(() => "");
    if (value) return value;
  }
  const selectors = platform === "jd"
    ? ["#key", "input[name='keyword']", ".search input[type='text']", "input[placeholder*='搜索']", "input[type='text']"]
    : ["#q", "input[name='q']", "input[placeholder*='搜索']", "input[type='search']", "input[type='text']"];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible({ timeout: 250 }).catch(() => false))) continue;
      const value = await candidate.inputValue({ timeout: 600 }).catch(() => "");
      if (value) return value;
    }
  }
  return "";
}

async function dismissKnownPassiveDialogs(page) {
  await closePassiveOverlays(page);
  const dialog = page.locator("#login2025-dialog-wrap, [class*='login'][class*='dialog'], [class*='login'][class*='modal']").first();
  const visible = await dialog.isVisible({ timeout: 800 }).catch(() => false);
  if (!visible) return;
  const closeButton = page.locator([
    "#login2025-dialog-wrap [class*='close']",
    "#login2025-dialog-wrap [aria-label*='关闭']",
    "#login2025-dialog-wrap button:has-text('关闭')",
    "#login2025-dialog-wrap button:has-text('×')",
    "[class*='login'][class*='dialog'] [class*='close']",
    "[class*='login'][class*='modal'] [class*='close']",
    "[aria-label*='关闭']"
  ].join(", ")).first();
  const canClose = await closeButton.isVisible({ timeout: 1200 }).catch(() => false);
  if (canClose) {
    await clickLikeUser(page, closeButton);
    await page.waitForTimeout(900);
    if (!(await dialog.isVisible({ timeout: 600 }).catch(() => false))) return;
  }
  throw new SelectionFlowError("页面弹出登录窗口并遮挡搜索，请重新确认账号登录态。", "login", "login_expired");
}

async function closePassiveOverlays(page) {
  const closeSelectors = [
    "#J_TBPC_POP_home [class*='close']",
    "#J_TBPC_POP_home [aria-label*='关闭']",
    "#J_TBPC_POP_home button:has-text('关闭')",
    "[class*='pop'] [class*='close']",
    "[class*='modal'] [class*='close']",
    "[aria-label*='关闭']"
  ];
  for (const selector of closeSelectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible({ timeout: 400 }).catch(() => false))) continue;
    await locator.click({ timeout: 1200 }).catch(() => locator.click({ timeout: 1200, force: true }).catch(() => undefined));
    await page.waitForTimeout(500).catch(() => undefined);
    return;
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(350).catch(() => undefined);

  const blockingPopup = page.locator("#J_TBPC_POP_home").first();
  const visible = await blockingPopup.isVisible({ timeout: 400 }).catch(() => false);
  if (!visible) return;
  const popupText = await blockingPopup.innerText({ timeout: 600 }).catch(() => "");
  if (/验证码|滑块|安全验证|登录|扫码|账号/.test(popupText)) return;
  await page.evaluate(() => {
    document.querySelector("#J_TBPC_POP_home")?.remove();
  }).catch(() => undefined);
}

async function submitSearchForm(page, platform) {
  if (platform === "jd") {
    await page.evaluate(() => {
      const form = document.querySelector("#search form, form[action*='search.jd.com'], form");
      const input = document.querySelector("#key, input[name='keyword'], input[type='text']");
      if (form && input?.value) {
        form.submit();
      }
    });
    return;
  }
  await page.evaluate(() => {
    const form = document.querySelector("form[action*='s.taobao.com'], form");
    const input = document.querySelector("#q, input[name='q'], input[type='text']");
    if (form && input?.value) {
      form.submit();
    }
  });
}

async function firstVisibleLocator(page, selectors, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 2500 }).catch(() => false)) return locator;
  }
  throw new SelectionFlowError(`${label}未找到`, "technical", "element_missing");
}

async function clickFirstVisible(page, selectors, timeout = 1800) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible({ timeout }).catch(() => false))) continue;
    await clickLikeUser(page, locator);
    return true;
  }
  return false;
}

async function clickLikeUser(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x - 18, y - 8, { steps: 6 }).catch(() => undefined);
    await page.waitForTimeout(160);
    await page.mouse.move(x, y, { steps: 4 }).catch(() => undefined);
    await page.waitForTimeout(140);
  }
  try {
    await locator.click({ timeout: 5000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/intercepts pointer events|J_TBPC_POP_home|popMask/i.test(message)) {
      await closePassiveOverlays(page);
      await locator.click({ timeout: 5000 });
      return;
    }
    throw error;
  }
}

async function typeLikeUser(page, text) {
  for (const char of String(text)) {
    await page.keyboard.type(char, { delay: /[a-zA-Z0-9]/.test(char) ? 58 : 92 });
    if (char === " ") await page.waitForTimeout(120);
  }
}

async function browseLightly(page) {
  const viewport = await browserViewport(page);
  const plan = buildBrowseLightlyPlan({ viewport });
  for (const step of plan) {
    if (step.type === "move") {
      await page.mouse.move(step.x, step.y, { steps: step.steps }).catch(() => undefined);
    }
    if (step.type === "wheel") {
      await page.mouse.wheel(0, step.deltaY).catch(() => undefined);
    }
    await page.waitForTimeout(step.waitMs).catch(() => undefined);
  }
}

export function buildBrowseLightlyPlan(options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  const viewport = normalizeViewport(options.viewport);
  const plan = [];
  const rounds = randomInt(random, 2, 4);
  let currentX = randomRange(random, viewport.width * 0.18, viewport.width * 0.74);
  let currentY = randomRange(random, viewport.height * 0.18, viewport.height * 0.58);

  plan.push({
    type: "move",
    x: roundPosition(currentX, viewport.width),
    y: roundPosition(currentY, viewport.height),
    steps: randomInt(random, 6, 13),
    waitMs: randomInt(random, 480, 1150)
  });

  for (let index = 0; index < rounds; index += 1) {
    currentX = clamp(currentX + randomRange(random, -180, 220), 80, viewport.width - 80);
    currentY = clamp(currentY + randomRange(random, -120, 180), 80, viewport.height - 80);
    plan.push({
      type: "move",
      x: roundPosition(currentX, viewport.width),
      y: roundPosition(currentY, viewport.height),
      steps: randomInt(random, 5, 14),
      waitMs: randomInt(random, 360, 1000)
    });

    const direction = index === 0 || random() > 0.18 ? 1 : -1;
    plan.push({
      type: "wheel",
      deltaY: Math.round(direction * randomRange(random, 180, 560)),
      waitMs: randomInt(random, 760, 1900)
    });
  }

  if (random() > 0.35) {
    plan.push({
      type: "wheel",
      deltaY: -Math.round(randomRange(random, 60, 180)),
      waitMs: randomInt(random, 520, 1200)
    });
  }

  return plan;
}

async function browserViewport(page) {
  const playwrightViewport = page.viewportSize?.();
  if (playwrightViewport?.width && playwrightViewport?.height) return playwrightViewport;
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1365, height: 768 }));
}

function normalizeViewport(viewport = {}) {
  return {
    width: Math.max(640, Number(viewport.width || 1365)),
    height: Math.max(480, Number(viewport.height || 768))
  };
}

function roundPosition(value, max) {
  return Math.round(clamp(value, 20, max - 20));
}

function randomRange(random, min, max) {
  return min + random() * (max - min);
}

function randomInt(random, min, max) {
  return Math.round(randomRange(random, min, max));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function productCardCount(page, platform) {
  return page.locator(platform === "jd"
    ? ".gl-item, li[class*='gl-item'], .plugin_goodsCardWrapper, [data-sku][class*='wrapper'], a[href*='item.jd.com']"
    : "a[href*='item.taobao.com'], a[href*='detail.tmall.com']")
    .count()
    .catch(() => 0);
}

async function pageExtractionMessage(page, baseMessage) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const suffix = [title ? `标题：${title}` : "", url ? `地址：${url}` : ""].filter(Boolean).join("，");
  return suffix ? `${baseMessage}（${suffix}）` : baseMessage;
}

async function goToNextResultPage(page, platform) {
  const clicked = await clickFirstVisible(
    page,
    platform === "jd"
      ? ["a.pn-next:not(.disabled)", ".pn-next:not(.disabled)", "a:has-text('下一页')", "button:has-text('下一页')"]
      : ["a:has-text('下一页')", "button:has-text('下一页')", ".next:not(.disabled)"],
    1200
  );
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
  await sleepHuman(page, 1800, 3000);
  return true;
}

async function extractJdCards(page, sourceAccountId) {
  const raw = await page.locator(".gl-item, li[class*='gl-item'], .plugin_goodsCardWrapper, [data-sku][class*='wrapper']").evaluateAll((nodes) => {
    const parseSku = (href) => href.match(/item\.jd\.com\/(\d+)\.html/)?.[1] || "";
    const imageFrom = (root) => {
      const img = root.querySelector("img");
      return img?.getAttribute("data-lazy-img") || img?.getAttribute("data-img") || img?.getAttribute("data-original") || img?.currentSrc || img?.src || "";
    };
    const textTitle = (text) =>
      text.split("\n").map((line) => line.trim())
        .filter((line) => line.length > 5 && !/^(?:¥|￥|评价|评论|自营|广告|券|满减|销量|店铺)/.test(line))
        .sort((a, b) => b.length - a.length)[0] || "";
    const shopFromText = (text) =>
      text.split("\n").map((line) => line.trim()).filter((line) => /(?:旗舰店|专营店|买手店|自营店|店)$/.test(line)).at(-1) || "";
    return nodes.slice(0, 30).map((node) => {
      const root = node;
      const text = root.innerText || "";
      const link = root.querySelector(".p-name a[href*='item.jd.com']") || root.querySelector("a[href*='item.jd.com']") || root.querySelector("a[href*='chat.jd.com'][href*='pid=']");
      const href = link?.href || "";
      const title = root.querySelector("[title]")?.getAttribute("title")?.trim() || link?.getAttribute("title")?.trim() || link?.innerText?.trim() || root.querySelector(".p-name em")?.textContent?.trim() || textTitle(text);
      const priceText = root.querySelector(".p-price i")?.textContent?.trim() || root.querySelector(".p-price")?.textContent?.trim() || text;
      const commentText = root.querySelector(".p-commit a")?.textContent?.trim() || root.querySelector(".p-commit")?.textContent?.trim() || text;
      const shopName = root.querySelector(".p-shop a")?.textContent?.trim() || root.querySelector("[class*='shop'] a")?.textContent?.trim() || shopFromText(text);
      return { text, title, href, sku: root.getAttribute("data-sku") || parseSku(href) || href || title, priceText, commentText, shopName, image: imageFrom(root) };
    });
  });
  return raw.map((item) => toJdProduct(item, sourceAccountId)).filter((item) => item.productId && item.title && item.price > 0 && item.url);
}

async function extractJdDetailCandidate(page, sourceAccountId, jdUrl) {
  const raw = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
    const cleanDocTitle = () =>
      document.title
        .replace(/【行情 报价 价格 评测】-京东.*/, "")
        .replace(/-京东$/, "")
        .replace(/\s+/g, " ")
        .trim();
    const textOf = (selectors) => {
      for (const selector of selectors) {
        const value = document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
        if (value) return value;
      }
      return "";
    };
    const firstProductTitleFromBody = () => {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.find((line) => (
        line.length >= 18 &&
        /(?:辅酶|Q10|胶囊|软胶囊|保健品|维生素|NAD|鱼油|益生菌)/i.test(line) &&
        !/计算器|京东首页|购物车|联系客服|商品详情|全部评价/.test(line)
      )) || "";
    };
    const shopFromBody = () => {
      const matched = text.match(/([A-Za-z0-9\u4e00-\u9fa5]{2,30}(?:海外)?(?:旗舰店|专营店|买手店|自营店|店))/);
      return matched?.[1] || "";
    };
    const imageOf = (selectors) => {
      for (const selector of selectors) {
        const img = document.querySelector(selector);
        const value = img?.getAttribute("data-origin") || img?.getAttribute("data-lazy-img") || img?.getAttribute("data-img") || img?.currentSrc || img?.src || "";
        if (value) return value;
      }
      return "";
    };
    return {
      text,
      title: textOf([".sku-name", ".itemInfo-wrap .sku-name", "[class*='sku-name']", "[class*='product-title']", "[class*='item-title']"]) || meta("og:title"),
      docTitle: cleanDocTitle(),
      bodyTitle: firstProductTitleFromBody(),
      priceText: textOf([".product-price--main", ".page-right-price", ".product-price-panel", ".p-price .price", ".summary-price .price"]) || text,
      shopName: textOf([".name.shop-name", ".seller-infor a", "#popbox .mt h3", "[class*='shop-name']"]) || shopFromBody(),
      commentText: textOf(["#comment-count", ".count", ".percent-info"]) || text,
      image: imageOf(["#spec-img", "#preview img", ".jqzoom img", "img[src*='360buyimg']"])
    };
  });
  const titleCandidates = [raw.title, raw.docTitle, raw.bodyTitle]
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(isUsefulJdTitle);
  const title = titleCandidates[0] || String(raw.docTitle || raw.bodyTitle || raw.title || "").replace(/\s+/g, " ").trim();
  const price = parsePrice(raw.priceText);
  const sku = parseSkuProfile(title);
  const productId = jdProductIdFromUrl(jdUrl) || title;
  if (!title || !productId || price <= 0) return null;
  return {
    platform: "jd",
    productId,
    title,
    url: normalizeProductUrl(jdUrl, "jd"),
    price,
    unitPrice: unitPrice(price, sku),
    skuText: title,
    shopName: raw.shopName,
    mainImageUrl: normalizeImageUrl(raw.image),
    sourceAccountId,
    isBuyerStore: /买手|买手店/.test(`${raw.shopName}\n${raw.text}`),
    commentCount: parseCommentCount(raw.commentText)
  };
}

function toJdProduct(item, sourceAccountId) {
  const sku = parseSkuProfile(item.title);
  const price = parsePrice(item.priceText);
  return {
    platform: "jd",
    productId: item.sku,
    title: item.title,
    url: normalizeProductUrl(item.href || item.sku, "jd"),
    price,
    unitPrice: unitPrice(price, sku),
    skuText: item.title,
    shopName: item.shopName,
    mainImageUrl: normalizeImageUrl(item.image),
    sourceAccountId,
    isBuyerStore: /买手|买手店/.test(`${item.shopName}\n${item.text}`),
    commentCount: parseCommentCount(item.commentText)
  };
}

async function extractTaobaoCards(page, sourceAccountId, keyword) {
  const raw = await page.locator("a[href*='item.taobao.com'], a[href*='detail.tmall.com']").evaluateAll((links) => {
    const firstProductLine = (text) =>
      text.split("\n").map((line) => line.trim()).find((line) => line.length > 4 && !/^(?:¥|￥|PC|官方|直降|淘金币|回头客|满|可领)/.test(line)) || "";
    return links.slice(0, 40).map((link) => {
      const anchor = link;
      const anchorText = anchor.innerText || "";
      let root = anchor.closest("div");
      let cursor = root?.parentElement || null;
      for (let depth = 0; cursor && depth < 6; depth += 1) {
        const text = cursor.innerText || "";
        if (/(?:¥|￥)\s*\d|月销|已售|人付款/.test(text)) {
          root = cursor;
          break;
        }
        cursor = cursor.parentElement;
      }
      const text = /(?:¥|￥)|人付款|月销|已售/.test(anchorText) ? anchorText : root?.innerText || anchorText;
      const img = root?.querySelector("img");
      const image = img?.getAttribute("data-src") || img?.getAttribute("data-ks-lazyload") || img?.getAttribute("data-lazy-src") || img?.currentSrc || img?.src || "";
      return { href: anchor.href, title: firstProductLine(anchor.getAttribute("title") || anchorText || text), text, image };
    });
  });
  return raw.map((item, index) => {
    const title = item.title || item.text.split("\n")[0] || `淘宝候选${index + 1}`;
    const price = parsePrice(item.text);
    const sku = parseSkuProfile(title);
    return {
      platform: "taobao",
      productId: taobaoProductId(item.href) || `taobao-${index}`,
      title,
      url: normalizeProductUrl(item.href, "taobao"),
      price,
      unitPrice: unitPrice(price, sku),
      skuText: title,
      shopName: "",
      mainImageUrl: normalizeImageUrl(item.image),
      sourceAccountId,
      salesCount: parseSalesCount(item.text),
      domesticShipping: !/(?:海外|境外|跨境|保税|香港|澳门|台湾|港澳台)/.test(item.text),
      shipsWithin48Hours: parseShippingHours(item.text) <= 48,
      shippingHours: parseShippingHours(item.text),
      coreProductMatched: coreProductMatched(title, keyword),
      relevanceScore: relevanceScore(title, keyword)
    };
  }).filter((item) => item.productId && item.title && item.price > 0 && item.url);
}

function normalizeFlowError(error) {
  if (error instanceof SelectionFlowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout|timed out|超时/i.test(message)) return new SelectionFlowError(`页面超时：${message}`, "technical", "page_timeout");
  return new SelectionFlowError(message, "technical", "element_missing");
}

function pauseRiskyAccounts(db, flowError) {
  if (flowError.failure !== "platform_risk") return;
  for (const account of db.listAccounts().filter((item) => item.status === "in_use")) {
    db.updateAccount(account.id, "paused", flowError.message);
  }
}

function readConfigStrategy(ctx) {
  return {
    jdPages: ctx?.config?.get?.("jdPages"),
    minJdComments: ctx?.config?.get?.("minJdComments"),
    minTaobaoSales: ctx?.config?.get?.("minTaobaoSales"),
    requireDomesticShipping: ctx?.config?.get?.("requireDomesticShipping"),
    requireFastShippingHours: ctx?.config?.get?.("requireFastShippingHours")
  };
}

function buildResult(db, runId, ok, message) {
  return {
    ok,
    message,
    run: db.getRun(runId),
    matches: db.listMatches(runId, 20),
    logs: db.listLogs(20, runId),
    dbPath: db.dbPath
  };
}

async function sleepHuman(page, minMs, maxMs) {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
  await page.waitForTimeout(ms);
}

function normalizeSearchValue(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}
