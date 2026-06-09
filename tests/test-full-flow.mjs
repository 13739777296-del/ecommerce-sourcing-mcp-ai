#!/usr/bin/env node

/**
 * 完整流程测试：模仿人类操作
 * 搜索 → 提取列表 → 点击商品 → 提取详情（含已售）
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import {
  openAiSessionWithAccount,
  aiJdSearch,
  aiExtractJdProducts,
  aiClickProduct,
  aiExtractJdDetail
} from "../lib/ai-controller.js";

async function fullTest() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  try {
    console.log("=== 完整选品流程测试 ===\n");

    // 1. 打开浏览器（用户Cookie）
    console.log("【1】打开正式Chrome（用京东账号一）...");
    const session = await openAiSessionWithAccount(ctx, db, "jd");
    const page = session.page;

    // 2. 真实搜索（不构造URL，用搜索框）
    console.log("\n【2】真实搜索（操作搜索框+回车）...");
    await aiJdSearch(page, "辅酶Q10");
    console.log(`   ✅ ${page.url().substring(0, 80)}...`);

    // 3. 提取商品列表
    console.log("\n【3】提取商品列表...");
    const products = await aiExtractJdProducts(page, 3);
    console.log(`   ✅ 提取到 ${products.length} 个商品`);
    products.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.title.substring(0, 40)}... ¥${p.price}`);
    });

    // 4. 点击第一个商品（模仿人类：滚动→hover→停顿→点击）
    console.log("\n【4】模仿人类点击第一个商品...");
    const detail = await aiClickProduct(page, 0);
    console.log(`   ✅ 进入详情页: ${detail.url.substring(0, 80)}`);

    // 5. 提取详情（关键：已售数据）
    console.log("\n【5】提取详情数据...");
    const info = await aiExtractJdDetail(detail.page);
    console.log(`   标题: ${info.title}`);
    console.log(`   价格: ¥${info.price}`);
    console.log(`   已售: ${info.sales}`);
    console.log(`   评论数: ${info.comments}`);
    console.log(`   品牌: ${info.brand}`);
    console.log(`   店铺: ${info.shop}`);
    console.log(`   SKU规格: ${info.skuInfo.substring(0, 100)}`);
    if (Object.keys(info.params).length > 0) {
      console.log(`   规格参数:`);
      for (const [k, v] of Object.entries(info.params).slice(0, 5)) {
        console.log(`     ${k}: ${v}`);
      }
    }

    console.log("\n=== 🎉 完整流程通过！ ===");

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

fullTest();
