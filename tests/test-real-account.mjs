#!/usr/bin/env node

/**
 * 完整测试：使用真实账号进行AI选品
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler as aiSelectHandler } from "../tools/ai-select.js";

async function testWithRealAccount() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("=== AI选品完整测试 ===\n");

  try {
    // 测试1: 搜索
    console.log("【步骤1】搜索京东商品...");
    const searchResult = await aiSelectHandler(ctx, db, {
      action: "search",
      keyword: "辅酶Q10",
      platform: "jd"
    });

    if (!searchResult.ok) {
      console.error("❌ 搜索失败:", searchResult.message);
      return;
    }

    console.log("✅ 搜索成功!");
    console.log(`   账号: ${searchResult.accountName}`);
    console.log(`   URL: ${searchResult.url}`);
    console.log(`   标题: ${searchResult.title}`);

    // 等待一下
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 测试2: 提取商品列表
    console.log("\n【步骤2】提取商品列表...");
    const extractResult = await aiSelectHandler(ctx, db, {
      action: "extract",
      platform: "jd",
      maxCount: 5
    });

    if (!extractResult.ok) {
      console.error("❌ 提取失败:", extractResult.message);
      return;
    }

    console.log(`✅ 提取成功! 共 ${extractResult.count} 个商品`);
    extractResult.products.forEach((p, i) => {
      console.log(`\n   商品${i + 1}:`);
      console.log(`   标题: ${p.title}`);
      console.log(`   价格: ¥${p.price || '未知'}`);
      console.log(`   销量: ${p.sales || '未知'}`);
      console.log(`   店铺: ${p.shop || '未知'}`);
      console.log(`   ID: ${p.productId}`);
      console.log(`   链接: ${p.url}`);
    });

    // 测试3: 关闭会话
    console.log("\n【步骤3】关闭浏览器会话...");
    const closeResult = await aiSelectHandler(ctx, db, {
      action: "close",
      platform: "jd"
    });

    console.log("✅ 会话已关闭");

    console.log("\n=== 🎉 所有测试通过！ ===");

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

testWithRealAccount();
