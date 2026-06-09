#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearch } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function analyzeTaobao() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");
  await aiTaobaoSearch(session.page, "蛋白粉");

  // 滚动加载
  for (let i = 0; i < 3; i++) {
    await session.page.mouse.wheel(0, 500);
    await session.page.waitForTimeout(1000);
  }

  const analysis = await session.page.evaluate(() => {
    // 找商品卡片
    const selectors = [
      'div[data-category="auctions"]',
      '.item',
      '.Card--mainPicAndDesc',
      'div[class*="item"]',
      'a[href*="item.taobao.com"]',
      'a[href*="detail.tmall.com"]'
    ];

    const result = {};
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      result[sel] = found.length;

      if (found.length > 0 && found.length < 100) {
        result[`${sel}_sample`] = {
          innerHTML: found[0].innerHTML.substring(0, 300),
          innerText: found[0].innerText?.substring(0, 200)
        };
      }
    }

    return result;
  });

  console.log("=== 淘宝页面分析 ===\n");
  console.log(JSON.stringify(analysis, null, 2));

  await session.page.screenshot({ path: '/tmp/taobao-debug.png' });
  console.log("\n截图: /tmp/taobao-debug.png");

  await session.page.waitForTimeout(30000);
  process.exit(0);
}

analyzeTaobao();
