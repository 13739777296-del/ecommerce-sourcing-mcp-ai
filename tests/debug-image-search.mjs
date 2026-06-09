#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearchByImage } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function debugImageSearch() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");

  // 用一个京东商品图搜索
  const imageUrl = "https://img14.360buyimg.com/n2/s480x480_jfs/t1/431205/31/22033/63593/6a0934d9F580d009a/00833203204bed3c.jpg.avif";

  await aiTaobaoSearchByImage(session.page, imageUrl);

  console.log(`当前URL: ${session.page.url()}`);

  // 分析页面
  await session.page.waitForTimeout(3000);

  const analysis = await session.page.evaluate(() => {
    const selectors = [
      'a[href*="item.taobao.com"]',
      'a[href*="detail.tmall.com"]',
      'div[data-category="auctions"]',
      '.item'
    ];

    const result = {};
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      result[sel] = found.length;
      if (found.length > 0 && found.length < 20) {
        result[`${sel}_sample`] = found[0].innerText?.substring(0, 200);
      }
    }

    return result;
  });

  console.log("\n=== 以图搜图页面分析 ===");
  console.log(JSON.stringify(analysis, null, 2));

  await session.page.screenshot({ path: '/tmp/taobao-image-search.png' });
  console.log("\n截图: /tmp/taobao-image-search.png");

  await session.page.waitForTimeout(30000);
  process.exit(0);
}

debugImageSearch();
