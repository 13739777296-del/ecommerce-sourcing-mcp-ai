import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profileSummary } from "./accounts.js";
import { openChromeSession, closeManagedChromeSessions, normalizeChromeSessionOptions } from "./chrome.js";
import { buildSearchResultUrl, SelectionFlowError } from "./browser-selection.js";
import { parsePrice, parseCommentCount, parseSalesCount, parseShippingHours, parseSkuProfile, unitPrice } from "./logic.js";

const HUMAN_DELAY_MIN = 2200;
const HUMAN_DELAY_MAX = 4800;

let lastActionTime = 0;

function humanDelay(min = HUMAN_DELAY_MIN, max = HUMAN_DELAY_MAX) {
  const now = Date.now();
  const elapsed = now - lastActionTime;
  const needed = min + Math.round(Math.random() * (max - min));
  if (elapsed < needed) {
    return new Promise((resolve) => setTimeout(resolve, needed - elapsed));
  }
}

function stamp() { lastActionTime = Date.now(); }

function normalizePlatform(platform) {
  const value = String(platform || "").toLowerCase();
  if (value === "taobao" || value === "tb" || value === "淘宝") return "taobao";
  return "jd";
}

async function getSession(account, runId, db) {
  const profileDir = account.profileDir;
  // 检查是否有已存在的会话可以复用，防止冲突
  const opts = normalizeChromeSessionOptions({ keepAlive: true, closeOtherPages: false, newPage: true, forceFresh: false });
  const session = await openChromeSession(profileDir, "about:blank", opts);
  // 检查登录态：如果页面被重定向到登录页，说明登录失效
  if (session?.page && db) {
    const url = session.page.url();
    if (/passport\.jd\.com|login\.taobao\.com|login\.tmall\.com|login\.jd\.com/i.test(url)) {
      if (runId) db.addLog(runId, "warning", `${account.displayName} 登录态失效，URL: ${url}`);
      db.updateAccount(account.id, "login_required", "登录态失效");
      throw new SelectionFlowError(`${account.displayName} 登录态失效，请重新登录。`, "login", "login_expired");
    }
  }
  return session;
}

async function observe(page, platform) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const viewport = page.viewportSize?.() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1365, height: 768 }));
  const text = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  const elements = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none";
    };
    return Array.from(document.querySelectorAll("input, button, a, [role='button'], [role='link']"))
      .filter(vis).slice(0, 80).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 80),
          href: el.href || "",
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height)
        };
      });
  }).catch(() => []);
  return { platform, title, url, viewport, textSample: text.replace(/\s+/g, " ").trim().slice(0, 1500), elements };
}

async function snapshot(ctx, page, platform, label) {
  const obs = await observe(page, platform);
  const dir = join(ctx?.dataDir || process.cwd(), "ai-browser-screenshots");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${label.replace(/[^a-zA-Z0-9一-龥_-]+/g, "-").slice(0, 60)}.png`);
  await page.screenshot({ path: filePath, fullPage: false, timeout: 12000 }).catch(() => undefined);
  let image = null;
  try { image = { type: "image", data: readFileSync(filePath).toString("base64"), mimeType: "image/png" }; } catch { /* ignore */ }
  return { obs, image, screenshotPath: filePath };
}

async function dismissDialogs(page) {
  const closeSelectors = [
    "#J_TBPC_POP_home [class*='close']",
    "[class*='pop'] [class*='close']",
    "[class*='modal'] [class*='close']",
    "[aria-label*='关闭']"
  ];
  for (const sel of closeSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
      await loc.click({ timeout: 1200 }).catch(() => loc.click({ timeout: 1200, force: true }).catch(() => undefined));
      await page.waitForTimeout(500).catch(() => undefined);
      return;
    }
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(350).catch(() => undefined);
}

async function clickLikeUser(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x - 18 + Math.random() * 36, y - 8 + Math.random() * 16, { steps: 6 }).catch(() => undefined);
    await page.waitForTimeout(140 + Math.random() * 200);
    await page.mouse.move(x, y, { steps: 4 }).catch(() => undefined);
    await page.waitForTimeout(120 + Math.random() * 180);
  }
  await locator.click({ timeout: 6000 }).catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (/intercepts pointer/.test(msg)) { await dismissDialogs(page); await locator.click({ timeout: 6000 }); return; }
    throw error;
  });
}

async function typeCharByChar(page, text) {
  for (const char of String(text)) {
    await page.keyboard.type(char, { delay: /[a-zA-Z0-9]/.test(char) ? 55 : 90 });
    if (char === " ") await page.waitForTimeout(100 + Math.random() * 80);
    if (Math.random() < 0.08) await page.waitForTimeout(200 + Math.random() * 400);
  }
}

function humanScroll(page, delta) {
  const steps = 6 + Math.floor(Math.random() * 6);
  const chunk = Math.round(delta / steps);
  return (async () => {
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, chunk + Math.round((Math.random() - 0.5) * 20));
      await page.waitForTimeout(80 + Math.random() * 160);
    }
  })();
}

function extractJdProducts(pageText) {
  const products = [];
  const links = pageText.match(/https?:\/\/item\.jd\.com\/\d+\.html/g) || [];
  const blocks = pageText.split(/\n/);
  for (const link of links) {
    const sku = link.match(/item\.jd\.com\/(\d+)\.html/)?.[1] || "";
    if (!sku) continue;
    if (products.some((p) => p.productId === sku)) continue;
    const context = blocks.filter((l) => l.includes(sku) || l.includes("¥") || l.includes("评价") || l.includes("自营")).slice(0, 8).join("\n");
    products.push({ platform: "jd", productId: sku, url: `https://item.jd.com/${sku}.html`, context });
  }
  return products;
}

function extractJdDetail(pageText, docTitle) {
  const title = docTitle.replace(/【.*?】/g, "").replace(/-京东$/, "").replace(/\s+/g, " ").trim();
  const price = parsePrice(pageText);
  const commentCount = parseCommentCount(pageText);
  const shopMatch = pageText.match(/([A-Za-z0-9一-龥]{2,30}(?:海外)?(?:旗舰店|专营店|买手店|自营店|店))/);
  const shopName = shopMatch?.[1] || "";
  const isBuyerStore = /买手/.test(pageText) || /买手/.test(shopName);
  const sku = parseSkuProfile(title);
  const imgMatch = pageText.match(/(https?:\/\/img\d*\.360buyimg\.com\/[^\s]+)/);
  const imageUrl = imgMatch?.[1] || "";
  return { title, price, commentCount, shopName, isBuyerStore, unitPrice: unitPrice(price, sku), skuText: title, imageUrl, sku };
}

function extractTaobaoProducts(pageText, keyword) {
  const products = [];
  const links = pageText.match(/https?:\/\/item\.taobao\.com\/item\.htm\?id=\d+/g) || [];
  const tmallLinks = pageText.match(/https?:\/\/detail\.tmall\.com\/item\.htm\?id=\d+/g) || [];
  const allLinks = [...new Set([...links, ...tmallLinks])];
  const blocks = pageText.split(/\n/);
  for (const link of allLinks) {
    const idMatch = link.match(/[?&]id=(\d+)/);
    const id = idMatch?.[1] || "";
    if (!id || products.some((p) => p.productId === id)) continue;
    const context = blocks.filter((l) => l.includes(id) || l.includes("¥") || l.includes("付款") || l.includes("已售") || l.includes("月销")).slice(0, 8).join("\n");
    products.push({
      platform: "taobao", productId: id, url: link,
      price: parsePrice(context), salesCount: parseSalesCount(context),
      domesticShipping: !/(?:海外|境外|跨境|保税|香港|澳门|台湾)/.test(context),
      shippingHours: parseShippingHours(context),
      context
    });
  }
  return products.filter((p) => p.price > 0).sort((a, b) => a.price - b.price);
}

function extractTaobaoDetail(pageText, keyword) {
  const price = parsePrice(pageText);
  const salesCount = parseSalesCount(pageText);
  const domesticShipping = !/(?:海外|境外|跨境|保税|香港|澳门|台湾)/.test(pageText);
  const shippingHours = parseShippingHours(pageText);
  const title = (pageText.split("\n").find((l) => l.length > 10 && l.length < 200 && /[一-龥]/.test(l))) || "";
  return { price, salesCount, domesticShipping, shippingHours, title };
}

function result(ctx, status, page, snapshotData, extra = {}) {
  return {
    ok: status === "ok",
    status,
    ...extra,
    snapshot: snapshotData ? { observation: snapshotData.obs, screenshotPath: snapshotData.screenshotPath } : null,
    image: snapshotData?.image || null
  };
}

export async function startJdSearch(ctx, db, input) {
  await humanDelay();
  stamp();
  const account = pickAccount(db, "jd", input.accountId);
  const keyword = String(input.keyword || "").trim();
  if (!keyword) throw new Error("需要 keyword。");
  const session = await getSession(account, input.runId, db);
  try {
    const page = session.page;
    db.addLog(input.runId || null, "info", `打开京东首页搜索"${keyword}"。`);
    await page.goto("https://www.jd.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);
    await dismissDialogs(page);
    await assertNotBlocked(page, "jd");

    // 输入关键词
    const searchInput = page.locator("input[aria-label='搜索']").first();
    await clickLikeUser(page, searchInput);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200 + Math.random() * 300);
    await typeCharByChar(page, keyword);
    await page.waitForTimeout(300 + Math.random() * 600);

    // 点击搜索按钮 - 用最简单的选择器
    await page.keyboard.press("Escape"); // 关闭下拉建议
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter"); // 回车搜索

    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(3000 + Math.random() * 3000);
    await assertNotBlocked(page, "jd");

    await humanScroll(page, 200 + Math.random() * 300);
    await page.waitForTimeout(800 + Math.random() * 1200);
    await humanScroll(page, 300 + Math.random() * 400);
    await page.waitForTimeout(800 + Math.random() * 1200);

    await assertNotBlocked(page, "jd");
    const snap = await snapshot(ctx, page, "jd", `jd-search-${keyword}`);
    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const products = extractJdProducts(bodyText);

    db.addLog(input.runId || null, "info", `京东搜索完成：找到 ${products.length} 个商品。`);

    return result(ctx, "ok", page, snap, {
      step: "jd_search_results",
      keyword,
      accountId: account.id,
      pageTitle: snap.obs.title,
      pageUrl: snap.obs.url,
      products,
      productCount: products.length,
      instruction: "这是京东搜索结果页。请用多模态模型查看截图，结合 products 列表判断下一步。可选操作：jd_click_detail（点进详情页）、jd_scroll（继续翻页浏览）、jd_back（返回）、jd_next_page（下一页）。"
    });
  } catch (error) {
    return handleError(ctx, db, error, input.runId, account);
  }
}

export async function clickJdDetail(ctx, db, input) {
  await humanDelay(1800, 3500);
  stamp();
  const account = pickAccount(db, "jd", input.accountId);
  const session = await getSession(account, input.runId, db);
  const page = session.page;
  const sku = String(input.productId || "").trim();
  if (!sku) throw new Error("需要 productId（商品 SKU）。");
  const url = String(input.url || `https://item.jd.com/${sku}.html`);
  try {
    db.addLog(input.runId || null, "info", `进入京东详情页：${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500 + Math.random() * 2500);
    await dismissDialogs(page);
    await assertNotBlocked(page, "jd");

    await humanScroll(page, 180 + Math.random() * 260);
    await page.waitForTimeout(600 + Math.random() * 900);
    await assertNotBlocked(page, "jd");

    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const detail = extractJdDetail(bodyText, title);
    const snap = await snapshot(ctx, page, "jd", `jd-detail-${sku}`);

    const buyerTag = detail.isBuyerStore ? "买手店" : "非买手店";
    db.addLog(input.runId || null, "info", `京东详情页已加载：${detail.title.slice(0, 30)}... | ¥${detail.price} | ${buyerTag} | ${detail.commentCount}条评价`);

    return result(ctx, "ok", page, snap, {
      step: "jd_detail",
      productId: sku,
      detail: { ...detail, url },
      pageTitle: snap.obs.title,
      pageUrl: snap.obs.url,
      instruction: "这是京东商品详情页。请用多模态模型查看截图，确认：1. 是否买手店（jd_detail.isBuyerStore）2. 价格是否正确（jd_detail.price）3. 评论数是否 >= 2（jd_detail.commentCount）。如果确认通过，下一步调用 start_taobao_search 去淘宝找供货。"
    });
  } catch (error) {
    return handleError(ctx, db, error, input.runId, account);
  }
}

export async function startTaobaoSearch(ctx, db, input) {
  await humanDelay(2500, 5000);
  stamp();
  const account = pickAccount(db, "taobao", input.accountId);
  const keyword = String(input.keyword || "").trim();
  if (!keyword) throw new Error("需要 keyword。");
  const session = await getSession(account, input.runId, db);
  try {
    const page = session.page;
    db.addLog(input.runId || null, "info", `打开淘宝搜索"${keyword}"。`);
    await page.goto("https://www.taobao.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500 + Math.random() * 2500);
    await dismissDialogs(page);
    await assertNotBlocked(page, "taobao");

    // 直接导航到淘宝搜索结果页
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    db.addLog(input.runId || null, "info", `导航到淘宝搜索结果页：${keyword}`);

    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(3500 + Math.random() * 3500);
    await assertNotBlocked(page, "taobao");

    await humanScroll(page, 200 + Math.random() * 300);
    await page.waitForTimeout(800 + Math.random() * 1200);
    await humanScroll(page, 300 + Math.random() * 400);
    await page.waitForTimeout(800 + Math.random() * 1200);

    await assertNotBlocked(page, "taobao");
    const snap = await snapshot(ctx, page, "taobao", `tb-search-${keyword}`);
    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const products = extractTaobaoProducts(bodyText, keyword);

    return result(ctx, "ok", page, snap, {
      step: "taobao_search_results",
      keyword,
      accountId: account.id,
      pageTitle: snap.obs.title,
      pageUrl: snap.obs.url,
      products,
      productCount: products.length,
      instruction: "这是淘宝搜索结果页。请用多模态模型查看截图，结合 products 列表选择一个淘宝供货。筛选标准：国内发货、销量 >= 10、价格最低。选择后调用 taobao_click_detail 进入详情页确认。"
    });
  } catch (error) {
    return handleError(ctx, db, error, input.runId, account);
  }
}

export async function clickTaobaoDetail(ctx, db, input) {
  await humanDelay(2000, 4000);
  stamp();
  const account = pickAccount(db, "taobao", input.accountId);
  const session = await getSession(account, input.runId, db);
  const page = session.page;
  const productId = String(input.productId || "").trim();
  const url = String(input.url || "").trim() || (productId ? `https://item.taobao.com/item.htm?id=${productId}` : "");
  if (!url) throw new Error("需要 url 或 productId。");
  try {
    db.addLog(input.runId || null, "info", `进入淘宝详情页：${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500 + Math.random() * 2500);
    await dismissDialogs(page);
    await assertNotBlocked(page, "taobao");

    await humanScroll(page, 180 + Math.random() * 260);
    await page.waitForTimeout(600 + Math.random() * 900);

    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const detail = extractTaobaoDetail(bodyText, input.keyword || "");
    const snap = await snapshot(ctx, page, "taobao", `tb-detail-${productId}`);

    return result(ctx, "ok", page, snap, {
      step: "taobao_detail",
      productId,
      detail: { ...detail, url },
      pageTitle: snap.obs.title,
      pageUrl: snap.obs.url,
      instruction: "这是淘宝商品详情页。请用多模态模型查看截图，确认：1. 销量是否 >= 10（detail.salesCount）2. 是否国内发货（detail.domesticShipping）3. 是否 48 小时内发货（detail.shippingHours <= 48）4. 价格是否正确。如果确认通过，这个商品就匹配成功了，可以调用 save_match 保存。"
    });
  } catch (error) {
    return handleError(ctx, db, error, input.runId, account);
  }
}

export async function goBack(ctx, db, input) {
  await humanDelay(1500, 2800);
  stamp();
  const account = pickAccount(db, input.platform || "jd", input.accountId);
  const session = await getSession(account, input.runId, db);
  const page = session.page;
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(2000 + Math.random() * 2000);
    await dismissDialogs(page);
    const snap = await snapshot(ctx, page, normalizePlatform(input.platform || "jd"), "go-back");
    return result(ctx, "ok", page, snap, {
      step: "navigated_back",
      pageUrl: snap.obs.url,
      pageTitle: snap.obs.title
    });
  } catch (error) {
    return handleError(ctx, db, error, input.runId, account);
  }
}

export async function scrollPage(ctx, db, input) {
  await humanDelay(1200, 2500);
  stamp();
  const account = pickAccount(db, input.platform || "jd", input.accountId);
  const session = await getSession(account, input.runId, db);
  const page = session.page;
  const delta = Number(input.delta) || (200 + Math.random() * 400);
  await humanScroll(page, delta);
  await page.waitForTimeout(600 + Math.random() * 1000);
  const snap = await snapshot(ctx, page, normalizePlatform(input.platform || "jd"), "scroll");
  return result(ctx, "ok", page, snap, { step: "scrolled", delta, pageUrl: snap.obs.url });
}

export async function takeSnapshot(ctx, db, input) {
  await humanDelay(800, 1600);
  stamp();
  const account = pickAccount(db, input.platform || "jd", input.accountId);
  const session = await getSession(account, input.runId, db);
  const page = session.page;
  const snap = await snapshot(ctx, page, normalizePlatform(input.platform || "jd"), "manual-snapshot");
  return result(ctx, "ok", page, snap, {
    step: "snapshot",
    pageUrl: snap.obs.url,
    pageTitle: snap.obs.title
  });
}

export async function saveMatch(ctx, db, input) {
  const runId = input.runId;
  if (!runId) throw new Error("需要 runId。");
  const match = {
    jdProductId: String(input.jdProductId || ""),
    taobaoProductId: String(input.taobaoProductId || ""),
    status: "qualified",
    profitRate: Number(input.profitRate || 0),
    profitAmount: Number(input.profitAmount || 0),
    listingPrice: Number(input.jdPrice || 0),
    taobaoCost: Number(input.taobaoPrice || 0),
    reason: String(input.reason || "AI Agent 确认匹配")
  };
  db.saveMatch(runId, match);
  if (input.jdProduct) db.saveCandidate(runId, input.jdProduct, "passed", "AI Agent 确认通过");
  if (input.taobaoProduct) db.saveCandidate(runId, input.taobaoProduct, "passed", "AI Agent 确认通过");
  db.addLog(runId, "info", `AI Agent 保存匹配：${match.jdProductId} → ${match.taobaoProductId}，利润 ${match.profitAmount.toFixed(2)} 元`);
  return { ok: true, match, saved: true };
}

export async function endSession(ctx, db, input) {
  const platform = normalizePlatform(input?.platform || "");
  let closed = 0;
  if (platform) {
    const account = pickAccount(db, platform, input.accountId);
    // 先关闭托管会话
    closed += await closeManagedChromeSessions(account.profileDir);
    // 再彻底杀掉该 profile 的 Chrome 进程，确保任务栏也没有
    const { execFileSync } = await import("node:child_process");
    try {
      const output = execFileSync("/bin/ps", ["axo", "pid=,command="], { encoding: "utf8" });
      const pids = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("/Applications/Google Chrome.app/") && line.includes(`--user-data-dir=${account.profileDir}`))
        .map((line) => Number(line.match(/^(\d+)/)?.[1]))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (pids.length > 0) {
        const uniquePids = [...new Set(pids)];
        execFileSync("/bin/kill", ["-9", ...uniquePids.map((pid) => String(pid))], { stdio: "ignore" });
        closed += uniquePids.length;
      }
    } catch { /* best effort */ }
  } else {
    closed += await closeManagedChromeSessions();
  }
  return { ok: true, closed, message: `关闭了 ${closed} 个浏览器会话和进程。` };
}

function pickAccount(db, platform, accountId) {
  profileSummary(null, db);
  const accounts = db.listAccounts(platform).filter((a) => a.status === "available");
  if (accountId) {
    const found = accounts.find((a) => a.id === accountId);
    if (found) return found;
  }
  if (accounts.length === 0) {
    throw new SelectionFlowError(`${platform === "jd" ? "京东" : "淘宝"}没有可用账号。`, "login", "login_expired");
  }
  return accounts[0];
}

async function assertNotBlocked(page, platform) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  if (/验证码|滑块|安全验证|baxia|captcha|punish/i.test(text)) {
    throw new SelectionFlowError("页面要求验证码或安全验证，请人工处理。", "platform_risk", "captcha");
  }
  if (/访问频繁|操作频繁|请求过于频繁|稍后再试/.test(text)) {
    throw new SelectionFlowError("页面提示访问频繁。", "platform_risk", "access_frequent");
  }
  if (/账号异常|账户异常|风险提示|环境异常/.test(text)) {
    throw new SelectionFlowError("页面提示账号风险。", "platform_risk", "account_abnormal");
  }
  if (/passport\.jd\.com|login\.taobao\.com|login\.tmall\.com|login\.jd\.com/i.test(url)) {
    throw new SelectionFlowError("登录态失效，请重新登录。", "login", "login_expired");
  }
  if (!/验证码|请登录/.test(text)) return;
  if (platform === "jd" && !/京东|JD/i.test(title + text)) return;
  if (platform === "taobao" && !/淘宝|天猫|Taobao|Tmall/i.test(title + text)) return;
  if ((title + text).match(/请登录|扫码登录|账号登录|密码登录/)) {
    throw new SelectionFlowError("登录态失效。", "login", "login_expired");
  }
}

async function handleError(ctx, db, error, runId, account) {
  const msg = error instanceof Error ? error.message : String(error);
  const isRisk = /platform_risk|captcha|access_frequent|account_abnormal/.test(error?.eventType || msg);
  const isLogin = /login|登录/.test(error?.eventType || msg);
  if (isRisk) {
    db.updateAccount(account.id, "paused", msg);
    if (runId) db.addLog(runId, "critical", `${account.displayName} 触发风控：${msg}`);
  } else if (isLogin) {
    db.updateAccount(account.id, "login_required", msg);
    if (runId) db.addLog(runId, "warning", `${account.displayName} 登录失效：${msg}`);
  }
  return { ok: false, status: isRisk ? "platform_risk" : isLogin ? "login_required" : "error", message: msg };
}
