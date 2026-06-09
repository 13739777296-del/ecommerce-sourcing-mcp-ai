#!/usr/bin/env node

/**
 * 专注第一步：在京东找到买手店商品
 * 策略：搜索"蛋白粉"（已知有买手店）
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler } from "../tools/sourcing.js";

async function findBuyerShop() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("========================================");
  console.log("  目标：找到京东买手店商品");
  console.log("  关键词：蛋白粉（已知有买手店）");
  console.log("========================================\n");

  try {
    const result = await handler(ctx, db, {
      action: "jd_search_filter",
      keyword: "蛋白粉",
      strategyId: "no-source-arbitrage",
      maxCount: 50  // 多看几个，总能找到买手店
    });

    if (!result.ok) {
      console.error("❌ 失败:", result.message);
      process.exit(1);
    }

    console.log(`\n✅ 搜索成功！`);
    console.log(`   总数: ${result.total}`);
    console.log(`   通过策略: ${result.passed}`);

    if (result.passed > 0) {
      console.log("\n=== 找到的买手店商品 ===");
      result.passedProducts.forEach((p, i) => {
        console.log(`\n【${i + 1}】`);
        console.log(`  标题: ${p.title}`);
        console.log(`  价格: ¥${p.price}`);
        console.log(`  店铺: ${p.shop} (${p.shopType})`);
        console.log(`  销量: ${p.sales}`);
        console.log(`  链接: ${p.url}`);
      });

      console.log("\n========================================");
      console.log(`  🎉 成功找到 ${result.passed} 个买手店商品！`);
      console.log("========================================\n");
    } else {
      console.log("\n⚠️  没有找到买手店商品");
    }

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

findBuyerShop();
