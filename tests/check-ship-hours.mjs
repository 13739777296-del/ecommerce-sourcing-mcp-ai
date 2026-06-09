#!/usr/bin/env node

/**
 * 快速验证：淘宝商品能否提取到"48小时内发货"
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function checkShipHours() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");

  // 直接跳到一个淘宝商品详情页
  await session.page.goto("https://item.taobao.com/item.htm?id=823410547375");
  await session.page.waitForTimeout(3000);

  // 检查页面有没有"48小时内发货"这样的文字
  const shipInfo = await session.page.evaluate(() => {
    const text = document.body.innerText;

    // 找发货时效相关文字
    const patterns = [
      /(\d+)\s*小时.*发货/,
      /(\d+)\s*天.*发货/,
      /48\s*小时/,
      /当天发货/,
      /次日发货/
    ];

    const matches = [];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) matches.push(m[0]);
    }

    return {
      found: matches,
      sample: text.substring(0, 500)
    };
  });

  console.log("=== 淘宝详情页发货时效检查 ===\n");
  console.log("找到的发货时效信息：", shipInfo.found);
  console.log("\n页面文本示例：", shipInfo.sample);

  process.exit(0);
}

checkShipHours();
