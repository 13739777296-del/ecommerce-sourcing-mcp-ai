#!/usr/bin/env node

/**
 * 第3步：进入买手店，扒所有商品
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts, aiJdEnterShop, aiExtractShopAllProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";

async function extractShopProducts() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];

  console.log("========================================");
  console.log("  第3步：进入买手店，扒所有商品");
  console.log("========================================\n");

  try {
    // 1. 搜索蛋白粉，找到买手店
    console.log("【1】搜索蛋白粉，找买手店...");
    const session = await openAiSessionWithAccount(ctx, db, "jd");
    await aiJdSearch(session.page, "蛋白粉");

    const products = await aiExtractJdProducts(session.page, 50);
    const evaluated = products.map(p => {
      const result = evaluateJdProductByStrategy(p, strategy);
      return { ...p, passed: result.passed };
    });

    const buyerProducts = evaluated.filter(p => p.passed);
    if (buyerProducts.length === 0) {
      console.log("❌ 没找到买手店");
      process.exit(1);
    }

    const firstBuyer = buyerProducts[0];
    console.log(`✅ 找到买手店: ${firstBuyer.shop}`);
    console.log(`   示例商品: ${firstBuyer.title.substring(0, 40)}...`);

    // 2. 进入店铺
    console.log(`\n【2】进入店铺：${firstBuyer.shop}...`);
    await aiJdEnterShop(session.page, firstBuyer.shop);

    // 3. 扒店铺所有商品
    console.log(`\n【3】提取店铺所有商品...`);
    const shopProducts = await aiExtractShopAllProducts(session.page, 3);  // 最多3页

    console.log(`\n✅ 店铺商品提取完成！`);
    console.log(`   总数: ${shopProducts.length}`);

    // 4. 筛选：评论数>2（或有销量）
    const qualified = shopProducts.filter(p => {
      // 解析销量/评论数
      const salesMatch = p.sales?.match(/(\d+)/);
      const salesNum = salesMatch ? parseInt(salesMatch[1]) : 0;
      return salesNum >= 2;  // 至少2个销量/评论
    });

    console.log(`   符合条件（销量>=2）: ${qualified.length}`);

    // 显示前10个
    console.log(`\n=== 前10个符合条件的商品 ===`);
    qualified.slice(0, 10).forEach((p, i) => {
      console.log(`\n${i + 1}. ${p.title.substring(0, 50)}...`);
      console.log(`   价格: ¥${p.price} | 销量: ${p.sales}`);
      console.log(`   店铺: ${p.shop} (${p.shopType})`);
      console.log(`   链接: ${p.url}`);
    });

    console.log("\n========================================");
    console.log(`  🎉 第3步完成！从1个买手店扒出 ${qualified.length} 个可用品`);
    console.log("========================================\n");

  } catch (error) {
    console.error("\n❌ 失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

extractShopProducts();
