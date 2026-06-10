#!/usr/bin/env node

/**
 * 测试：用全新Profile搜索
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { aiJdSearch } from "../lib/ai-controller.js";
import { chromium } from 'playwright';

async function testFreshProfile() {
  console.log("=== 使用全新临时Profile测试 ===\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const result = await aiJdSearch(page, "蛋白粉");
    console.log(`\n✅ 成功！`);
    console.log(`   URL: ${result.url}`);
    console.log(`   商品数: ${result.productsCount}`);
  } catch (error) {
    console.error(`\n❌ 失败: ${error.message}`);
  }

  await page.waitForTimeout(30000);
  await browser.close();
  process.exit(0);
}

testFreshProfile();
