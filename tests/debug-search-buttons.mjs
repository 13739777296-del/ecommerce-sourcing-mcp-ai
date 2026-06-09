#!/usr/bin/env node

/**
 * 交互式调试：看京东首页搜索区域的所有元素
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function interactiveDebug() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "jd");
  const page = session.page;

  await page.goto("https://www.jd.com");
  await page.waitForTimeout(2000);

  // 找文本搜索框（排除file类型）
  const searchBox = page.locator('input[type="text"]#key, input[type="text"][name="keyword"], .search-m input[type="text"]').first();
  await searchBox.fill("辅酶Q10");
  await page.waitForTimeout(1000);

  // 分析搜索区域的所有按钮
  const searchArea = await page.evaluate(() => {
    // 找搜索框
    const input = document.querySelector('input#key') || document.querySelector('input[name="keyword"]');
    if (!input) return { error: "未找到搜索框" };

    // 找搜索框的父容器
    const container = input.closest('form') || input.closest('div[class*="search"]') || input.parentElement;

    // 找容器内所有按钮
    const buttons = container.querySelectorAll('button, input[type="submit"], a[class*="button"]');

    return {
      containerHTML: container.outerHTML.substring(0, 2000),
      buttons: Array.from(buttons).map((btn, i) => ({
        index: i,
        tag: btn.tagName,
        type: btn.type,
        className: btn.className,
        innerText: btn.innerText?.trim() || '',
        clstag: btn.getAttribute('clstag'),
        onclick: btn.getAttribute('onclick')
      }))
    };
  });

  console.log("=== 搜索区域分析 ===\n");
  console.log(JSON.stringify(searchArea, null, 2));

  // 保持浏览器打开，等待手动操作
  console.log("\n浏览器将保持打开30秒，你可以手动测试...");
  await page.waitForTimeout(30000);

  process.exit(0);
}

interactiveDebug();
