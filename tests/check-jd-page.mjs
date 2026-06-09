#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function checkJd() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "jd");
  await aiJdSearch(session.page, "蛋白粉");

  await session.page.waitForTimeout(5000);  // 多等一会
  await session.page.screenshot({ path: '/tmp/jd-check.png', fullPage: false });

  console.log(`URL: ${session.page.url()}`);
  console.log("截图: /tmp/jd-check.png");

  // 检查页面内容
  const content = await session.page.evaluate(() => {
    return {
      title: document.title,
      hasProducts: document.querySelectorAll('div[data-sku]').length,
      bodyText: document.body.innerText.substring(0, 500)
    };
  });

  console.log("页面信息:", JSON.stringify(content, null, 2));

  await session.page.waitForTimeout(30000);
  process.exit(0);
}

checkJd();
