#!/usr/bin/env node

/**
 * 探查：京东店铺页的商品DOM结构（动作D卡在这）
 *
 * 直达已知店铺URL，dump 出商品卡片用什么选择器、有没有翻页。
 *
 * 用法: node tests/probe-shop-dom.mjs [店铺URL]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiScrollPage } from "../lib/ai-controller.js";

const SHOP_URL = process.argv[2] || "https://mall.jd.com/index-152213856.html";
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log("========================================");
  console.log(`  探查店铺页DOM: ${SHOP_URL}`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  await page.goto(SHOP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  await aiScrollPage(page, 4);
  await page.waitForTimeout(2000);

  console.log(`页面标题: ${await page.title()}`);
  console.log(`当前URL: ${page.url()}\n`);

  // 探查各种可能的商品容器
  const probe = await page.evaluate(() => {
    const candidates = [
      "div[data-sku]",
      "li[data-sku]",
      "[data-sku]",
      ".jShop-item",
      ".goods-item",
      "[class*='goods']",
      "[class*='product']",
      "[class*='Item']",
      "li.item",
      ".gl-item"
    ];
    const counts = {};
    for (const sel of candidates) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) counts[sel] = n;
    }

    // 找所有指向 item.jd.com 的商品链接（最可靠的兜底）
    const itemLinks = document.querySelectorAll('a[href*="item.jd.com"]');
    const skuFromLinks = new Set();
    itemLinks.forEach((a) => {
      const m = (a.href || "").match(/item\.jd\.com\/(\d+)\.html/);
      if (m) skuFromLinks.add(m[1]);
    });

    // 翻页控件
    const pagers = [];
    ["[class*='pagination']", "[class*='next']", ".pn-next"].forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.innerText || "").trim().slice(0, 8);
        if (t) pagers.push({ sel, txt: t, cls: (el.className || "").toString().slice(0, 40) });
      });
    });

    // 取一个商品链接的父结构看看
    let sampleHtml = "";
    if (itemLinks[0]) {
      const card = itemLinks[0].closest("li, div[class]");
      if (card) sampleHtml = (card.outerHTML || "").slice(0, 300);
    }

    return {
      counts,
      itemLinkCount: itemLinks.length,
      uniqueSkuFromLinks: skuFromLinks.size,
      pagers: pagers.slice(0, 8),
      sampleHtml
    };
  });

  console.log("商品容器候选(有命中的):");
  if (Object.keys(probe.counts).length === 0) {
    console.log("  ⚠️ 常见容器都没命中");
  } else {
    for (const [sel, n] of Object.entries(probe.counts)) console.log(`  ${sel}: ${n}个`);
  }

  console.log(`\nitem.jd.com 商品链接: ${probe.itemLinkCount} 个，去重SKU: ${probe.uniqueSkuFromLinks} 个`);
  console.log(`  >> 这是最可靠的兜底：直接抓商品链接里的SKU`);

  console.log(`\n翻页控件:`);
  if (probe.pagers.length === 0) console.log("  ⚠️ 没找到翻页控件");
  else probe.pagers.forEach((p, i) => console.log(`  [${i + 1}] ${p.sel} "${p.txt}" cls="${p.cls}"`));

  if (probe.sampleHtml) {
    console.log(`\n商品卡片样例HTML(前300字):\n  ${probe.sampleHtml}`);
  }

  console.log("\n========================================");
  console.log("\n[probe] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[probe] 异常:", e);
  process.exit(1);
});
