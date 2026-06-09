#!/usr/bin/env node

/**
 * 调试：看看"辅酶Q10"的真实DOM结构
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function debugDom() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "jd");
  await aiJdSearch(session.page, "辅酶Q10");

  console.log("=== 分析页面DOM ===\n");

  // 滚动加载
  for (let i = 0; i < 3; i++) {
    await session.page.mouse.wheel(0, 500);
    await session.page.waitForTimeout(1000);
  }

  const analysis = await session.page.evaluate(() => {
    // 找所有可能的商品容器
    const selectors = [
      'div[data-sku]',
      '.gl-item',
      'li[data-sku]',
      '[class*="item"]',
      '[class*="goods"]',
      '[class*="product"]'
    ];

    const result = {};
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      result[sel] = elements.length;

      if (elements.length > 0 && elements.length < 100) {
        // 看第一个元素的内容
        const first = elements[0];
        result[`${sel}_sample`] = {
          innerHTML: first.innerHTML.substring(0, 500),
          innerText: first.innerText.substring(0, 300),
          dataAttributes: Array.from(first.attributes)
            .filter(attr => attr.name.startsWith('data-'))
            .map(attr => `${attr.name}="${attr.value}"`)
        };
      }
    }

    return result;
  });

  console.log(JSON.stringify(analysis, null, 2));

  await session.page.screenshot({ path: '/tmp/jd-debug.png' });
  console.log("\n截图已保存: /tmp/jd-debug.png");

  process.exit(0);
}

debugDom();
