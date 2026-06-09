#!/usr/bin/env node

/**
 * 第2步：进入买手店商品详情页
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler } from "../tools/sourcing.js";

async function getDetail() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("========================================");
  console.log("  第2步：进入买手店商品详情页");
  console.log("========================================\n");

  try {
    // 1. 先搜索找到买手店商品
    console.log("【1】搜索蛋白粉，找买手店商品...");
    const searchResult = await handler(ctx, db, {
      action: "jd_search_filter",
      keyword: "蛋白粉",
      strategyId: "no-source-arbitrage",
      maxCount: 50
    });

    if (searchResult.passed === 0) {
      console.log("❌ 没找到买手店商品");
      process.exit(1);
    }

    const buyerProduct = searchResult.passedProducts[0];
    console.log(`✅ 找到：${buyerProduct.title.substring(0, 40)}...`);
    console.log(`   店铺：${buyerProduct.shop}`);

    // 2. 点击进入详情页（模拟人类点击第一个通过筛选的商品）
    // 注意：需要找到这个商品在原始列表中的索引
    console.log("\n【2】模拟人类点击进入详情页...");

    // 由于我们已经筛选过了，需要重新提取找到索引
    // 简单起见，直接用jd_extract拿到列表，然后找这个productId的索引
    const extractResult = await handler(ctx, db, {
      action: "jd_extract",
      maxCount: 50
    });

    const productIndex = extractResult.products.findIndex(p => p.productId === buyerProduct.productId);
    console.log(`   商品在列表中的索引：${productIndex}`);

    if (productIndex === -1) {
      console.log("❌ 未找到商品索引");
      process.exit(1);
    }

    // 3. 进入详情页
    const detailResult = await handler(ctx, db, {
      action: "jd_detail",
      productIndex: productIndex
    });

    if (!detailResult.ok) {
      console.error("❌ 详情页提取失败:", detailResult.message);
      process.exit(1);
    }

    console.log("\n✅ 详情页提取成功！");
    console.log("\n=== 完整商品信息 ===");
    console.log(`标题：${detailResult.detail.title}`);
    console.log(`价格：¥${detailResult.detail.price}`);
    console.log(`已售：${detailResult.detail.sales || '未知'}`);
    console.log(`评论：${detailResult.detail.comments || '未知'}`);
    console.log(`品牌：${detailResult.detail.brand || '未知'}`);
    console.log(`店铺：${detailResult.detail.shop || '未知'}`);
    console.log(`SKU规格：${detailResult.detail.skuInfo?.substring(0, 100) || '未知'}`);
    console.log(`详情URL：${detailResult.detail.url}`);

    console.log("\n========================================");
    console.log("  🎉 第2步完成！已获取完整商品信息");
    console.log("========================================\n");

  } catch (error) {
    console.error("\n❌ 失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

getDetail();
