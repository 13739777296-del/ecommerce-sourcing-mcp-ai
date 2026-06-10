#!/usr/bin/env node

/**
 * 探查：京东店铺页"全部商品"入口
 *
 * 店铺首页是营销页，要找进"全部商品列表"的导航Tab/链接。
 * dump 店铺页所有导航链接，找"全部商品/所有宝贝/全部"等。
 *
 * 用法: node tests/probe-shop-nav.mjs [店铺URL]
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
  console.log(`探查店铺导航: ${SHOP_URL}\n`);

  const session = await openAiSession(JD2);
  const page = session.page;

  await page.goto(SHOP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // dump 所有导航链接
  const navs = await page.evaluate(() => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll("a"));
    for (const a of anchors) {
      const txt = (a.innerText || "").trim();
      const href = a.href || "";
      // 导航相关：含"商品/宝贝/全部/分类"，或href含 search/list/category
      if (
        /全部商品|所有宝贝|全部宝贝|全部|所有商品|商品分类|店内|宝贝/.test(txt) ||
        /view_search|search-|\/list|category|getProductList/.test(href)
      ) {
        if (txt && txt.length < 15) out.push({ txt, href: href.slice(0, 90) });
      }
    }
    const seen = new Set();
    return out.filter((o) => {
      if (seen.has(o.href)) return false;
      seen.add(o.href);
      return true;
    }).slice(0, 20);
  });

  console.log(`找到 ${navs.length} 个导航候选:`);
  navs.forEach((n, i) => console.log(`  [${i + 1}] "${n.txt}" -> ${n.href}`));

  // 也试着看页面有没有店内搜索框
  const hasSearch = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    return inputs
      .filter((i) => /搜索|店内|宝贝/.test(i.placeholder || ""))
      .map((i) => ({ ph: i.placeholder, cls: (i.className || "").toString().slice(0, 40) }))
      .slice(0, 5);
  });
  console.log(`\n店内搜索框: ${hasSearch.length} 个`);
  hasSearch.forEach((s, i) => console.log(`  [${i + 1}] placeholder="${s.ph}" cls="${s.cls}"`));

  console.log("\n[nav] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[nav] 异常:", e);
  process.exit(1);
});
