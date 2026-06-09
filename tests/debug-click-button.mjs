#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function debugButton() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "jd");
  const page = session.page;

  await page.goto("https://www.jd.com");
  await page.waitForTimeout(2000);

  // 填充搜索框
  const searchBox = page.locator('input.jd_pc_search_bar_react_search_input').first();
  await searchBox.fill("辅酶Q10");
  await page.waitForTimeout(1000);

  // 分析所有可能的按钮
  const buttons = await page.evaluate(() => {
    // 找所有button
    const allButtons = document.querySelectorAll('button');
    return Array.from(allButtons).map((btn, i) => ({
      index: i,
      className: btn.className,
      innerText: btn.innerText?.trim() || '',
      visible: btn.offsetWidth > 0 && btn.offsetHeight > 0,
      clstag: btn.getAttribute('clstag'),
      type: btn.type
    })).filter(b => b.visible && (b.innerText || b.className.includes('search')));
  });

  console.log("=== 可见的按钮 ===\n");
  console.log(JSON.stringify(buttons, null, 2));

  // 手动点击第一个包含"搜索"的按钮（非AI）
  for (const btn of buttons) {
    if ((btn.className.includes('search') || btn.innerText.includes('搜索')) &&
        !btn.className.includes('ai') && !btn.innerText.includes('AI')) {
      console.log(`\n尝试点击按钮 index=${btn.index}: ${btn.innerText || btn.className}`);
      await page.evaluate((idx) => {
        document.querySelectorAll('button')[idx].click();
      }, btn.index);

      await page.waitForTimeout(5000);
      console.log(`点击后URL: ${page.url()}`);
      break;
    }
  }

  await page.waitForTimeout(30000);
  process.exit(0);
}

debugButton();
