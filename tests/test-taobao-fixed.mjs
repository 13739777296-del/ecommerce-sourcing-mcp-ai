#!/usr/bin/env node

/**
 * 测试淘宝搜索（修复后）
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function testTaobao() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  console.log("=== 测试淘宝搜索（修复后）===\n");

  try {
    const session = await openAiSessionWithAccount(ctx, db, "taobao");

    // 测试关键词搜索
    console.log("【1】测试关键词搜索: MYPROTEIN 乳清蛋白粉");
    await aiTaobaoSearch(session.page, "MYPROTEIN 乳清蛋白粉 1000g");

    console.log(`\n✅ 搜索成功！URL: ${session.page.url()}`);

    // 提取商品
    console.log("\n【2】提取商品列表...");
    const products = await aiExtractTaobaoProducts(session.page, 10);

    console.log(`\n✅ 提取成功！共 ${products.length} 个商品\n`);

    products.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.title.substring(0, 50)}...`);
      console.log(`   价格: ¥${p.price} | 销量: ${p.sales}`);
      console.log(`   发货: ${p.shipFrom || '未知'}${p.isDomestic ? '(国内)' : ''}`);
      console.log(`   链接: ${p.url}`);
      console.log();
    });

    console.log("=== 🎉 淘宝搜索测试通过！ ===\n");

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

testTaobao();
