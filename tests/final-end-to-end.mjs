#!/usr/bin/env node

/**
 * 完整端到端测试 - 找到第1个真正可用的品！
 *
 * 完整流程：
 * 1. 京东搜"蛋白粉"→找到买手店（大麦保健品买手店）
 * 2. 取第1个商品：MYPROTEIN乳清蛋白粉 ¥161
 * 3. 去淘宝搜"MYPROTEIN 乳清蛋白粉 1000g"
 * 4. 筛选：国内发货 + 已售>=10
 * 5. 比价：找最低价
 * 6. 计算利润：35%-60%
 * 7. 保存数据库
 * 8. 输出结果
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts, aiTaobaoSearch, aiTaobaoSearchByImage, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, evaluateTaobaoProductByStrategy, evaluateProfitByStrategy, DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";
import { calculateUnitPrice, compareUnitPrice } from "../lib/unit-price.js";
import { initSourcingTables, saveSourcingResult } from "../lib/sourcing-db.js";

async function endToEndTest() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  // 初始化数据库
  initSourcingTables(db.db);

  const strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];

  console.log("========================================");
  console.log("  完整端到端测试");
  console.log("  目标：找到第1个真正可用的品！");
  console.log("========================================\n");

  try {
    // ===== 步骤1: 京东找买手店商品 =====
    console.log("【步骤1】京东搜索蛋白粉，找买手店...");
    const jdSession = await openAiSessionWithAccount(ctx, db, "jd");
    await aiJdSearch(jdSession.page, "蛋白粉");
    const jdProducts = await aiExtractJdProducts(jdSession.page, 50);

    const jdEvaluated = jdProducts.map(p => {
      const result = evaluateJdProductByStrategy(p, strategy);
      return { ...p, passed: result.passed };
    });

    const jdBuyer = jdEvaluated.find(p => p.passed);
    if (!jdBuyer) {
      console.log("❌ 没找到买手店商品");
      process.exit(1);
    }

    console.log(`✅ 找到买手店商品：`);
    console.log(`   ${jdBuyer.title.substring(0, 50)}...`);
    console.log(`   价格: ¥${jdBuyer.price}`);
    console.log(`   店铺: ${jdBuyer.shop} (${jdBuyer.shopType})`);
    console.log(`   销量: ${jdBuyer.sales}`);

    // 计算京东单价
    const jdUnitPrice = calculateUnitPrice(jdBuyer.price, jdBuyer.title);
    Object.assign(jdBuyer, {
      unitPrice: jdUnitPrice.unitPrice,
      unit: jdUnitPrice.unit
    });
    console.log(`   单价: ¥${jdUnitPrice.unitPrice?.toFixed(4) || '?'}/${jdUnitPrice.unit || '?'}`);

    // ===== 步骤2: 淘宝关键词搜索（提取品牌+规格） =====
    console.log(`\n【步骤2】淘宝搜索...`);

    // 从京东标题提取关键词（品牌+核心词+规格）
    const title = jdBuyer.title;
    let keyword = title.substring(0, 30);  // 默认前30字符

    // 尝试提取品牌和规格
    const brandMatch = title.match(/^([A-Z][A-Za-z0-9]+)/);  // 首字母大写的品牌
    const specMatch = title.match(/(\d+g|\d+ml|\d+粒|\d+片|\d+kg)/);

    if (brandMatch && specMatch) {
      keyword = `${brandMatch[1]} ${specMatch[1]}`;
      console.log(`   提取关键词: ${keyword}`);
    } else {
      console.log(`   使用标题前30字: ${keyword}`);
    }

    const taobaoSession = await openAiSessionWithAccount(ctx, db, "taobao");
    await aiTaobaoSearch(taobaoSession.page, keyword);
    const taobaoProducts = await aiExtractTaobaoProducts(taobaoSession.page, 20);

    console.log(`✅ 找到 ${taobaoProducts.length} 个淘宝商品`);

    // 筛选：国内发货 + 已售>=10
    const taobaoQualified = taobaoProducts.filter(p => {
      // 解析销量
      const salesMatch = p.sales?.match(/(\d+(?:\.\d+)?)[万千]?/);
      const salesNum = salesMatch ? parseFloat(salesMatch[1]) : 0;
      const actualSales = p.sales?.includes('万') ? salesNum * 10000 : (p.sales?.includes('千') ? salesNum * 1000 : salesNum);

      return p.isDomestic && actualSales >= 10;
    });

    console.log(`   筛选（国内发货+已售>=10）: ${taobaoQualified.length} 个`);

    if (taobaoQualified.length === 0) {
      console.log("❌ 没有符合条件的淘宝商品");
      process.exit(1);
    }

    // ===== 步骤3: 比价找最低价 =====
    console.log(`\n【步骤3】比价并计算利润...`);

    const matches = [];
    for (const taobaoProduct of taobaoQualified) {
      // 计算淘宝单价
      const taobaoUnitPrice = calculateUnitPrice(taobaoProduct.price, taobaoProduct.title);
      Object.assign(taobaoProduct, {
        unitPrice: taobaoUnitPrice.unitPrice,
        unit: taobaoUnitPrice.unit
      });

      // 比较
      const comparison = compareUnitPrice(jdBuyer, taobaoProduct);
      if (!comparison.canCompare || !comparison.jd.unitPrice || !comparison.taobao.unitPrice) {
        continue;
      }

      // 评估利润
      const profitResult = evaluateProfitByStrategy(
        comparison.jd.unitPrice,
        comparison.taobao.unitPrice,
        strategy
      );

      if (profitResult.passed) {
        matches.push({
          jd: jdBuyer,
          taobao: taobaoProduct,
          comparison,
          profit: profitResult
        });
      }
    }

    console.log(`   找到 ${matches.length} 个符合利润要求的匹配`);

    if (matches.length === 0) {
      console.log("❌ 没有符合利润要求的匹配");
      process.exit(1);
    }

    // 找最佳匹配（利润率最高）
    const bestMatch = matches.sort((a, b) => b.profit.profitRate - a.profit.profitRate)[0];

    // ===== 步骤4: 保存数据库 =====
    console.log(`\n【步骤4】保存到数据库...`);
    saveSourcingResult(db.db, bestMatch.jd, matches, bestMatch, strategy);
    console.log(`✅ 已保存`);

    // ===== 步骤5: 输出结果 =====
    console.log("\n========================================");
    console.log("  🎉🎉🎉 找到可用品！ 🎉🎉🎉");
    console.log("========================================\n");

    console.log("【京东端】");
    console.log(`  标题: ${bestMatch.jd.title}`);
    console.log(`  价格: ¥${bestMatch.jd.price}`);
    console.log(`  单价: ¥${bestMatch.jd.unitPrice?.toFixed(4)}/${bestMatch.jd.unit}`);
    console.log(`  店铺: ${bestMatch.jd.shop} (${bestMatch.jd.shopType})`);
    console.log(`  销量: ${bestMatch.jd.sales}`);
    console.log(`  链接: ${bestMatch.jd.url}`);

    console.log("\n【淘宝端】");
    console.log(`  标题: ${bestMatch.taobao.title}`);
    console.log(`  价格: ¥${bestMatch.taobao.price}`);
    console.log(`  单价: ¥${bestMatch.taobao.unitPrice?.toFixed(4)}/${bestMatch.taobao.unit}`);
    console.log(`  店铺: ${bestMatch.taobao.shop}`);
    console.log(`  销量: ${bestMatch.taobao.sales}`);
    console.log(`  发货: ${bestMatch.taobao.shipFrom}`);
    console.log(`  链接: ${bestMatch.taobao.url}`);

    console.log("\n【利润分析】");
    console.log(`  利润率: ${(bestMatch.profit.profitRate * 100).toFixed(1)}%`);
    console.log(`  利润额: ¥${bestMatch.profit.profitAmount?.toFixed(2)}`);

    console.log("\n========================================");
    console.log("  🎉 端到端测试完成！");
    console.log("  已保存到数据库");
    console.log("========================================\n");

  } catch (error) {
    console.error("\n❌ 失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

endToEndTest();
