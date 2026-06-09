#!/usr/bin/env node

/**
 * 测试通用策略引擎
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler as aiSelectHandler } from "../tools/ai-select.js";
import { handler as strategyHandler } from "../tools/strategy.js";

async function test() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("=== 通用策略引擎测试 ===\n");

  try {
    // 1. 查看内置策略模板
    console.log("【1】查看内置策略模板...");
    const templates = await strategyHandler(ctx, db, { action: "templates" });
    console.log(`✅ 找到 ${templates.templates.length} 个模板:`);
    templates.templates.forEach(t => {
      console.log(`   - ${t.id}: ${t.name} - ${t.description}`);
    });

    // 2. 用"无货源套利"策略筛选辅酶Q10
    console.log("\n【2】用'无货源套利'策略筛选辅酶Q10...");
    const result = await aiSelectHandler(ctx, db, {
      action: "search_and_filter",
      keyword: "辅酶Q10",
      strategyId: "no-source-arbitrage",
      maxCount: 30
    });

    if (!result.ok) {
      console.error("❌ 失败:", result.message);
      return;
    }

    console.log(`\n✅ 策略[${result.strategy.name}]执行结果:`);
    console.log(`   总数: ${result.total}`);
    console.log(`   通过: ${result.passedCount}`);
    console.log(`   淘汰: ${result.rejectedCount}`);

    console.log("\n=== 通过的商品（买手店）===");
    result.passed.forEach((p, i) => {
      console.log(`\n  ${i + 1}. ${p.title.substring(0, 50)}`);
      console.log(`     价格: ¥${p.price} | 销量: ${p.sales}`);
      console.log(`     店铺: ${p.shop} (${p.shopType})`);
    });

    console.log("\n=== 淘汰的商品（前5个）===");
    result.rejectedSummary.forEach((p, i) => {
      console.log(`\n  ${i + 1}. ${p.title.substring(0, 50)}`);
      console.log(`     店铺: ${p.shop} (${p.shopType})`);
      console.log(`     原因: ${p.reason}`);
    });

    // 3. 测试自定义策略
    console.log("\n\n【3】测试自定义策略：要旗舰店+海外店");
    const customResult = await aiSelectHandler(ctx, db, {
      action: "search_and_filter",
      keyword: "辅酶Q10",
      strategy: {
        id: "custom-flagship",
        name: "旗舰店海外店",
        platforms: {
          jd: {
            shopTypes: {
              include: ["flagship", "overseas", "official", "jd_self"],
              exclude: []
            },
            minSales: 100
          }
        }
      },
      maxCount: 10
    });

    if (customResult.ok) {
      console.log(`✅ 自定义策略执行: ${customResult.passedCount}/${customResult.total} 通过`);
      customResult.passed.slice(0, 3).forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.shop} (${p.shopType}) - ${p.title.substring(0, 40)}`);
      });
    }

    console.log("\n=== 🎉 策略引擎测试通过！ ===");

  } catch (error) {
    console.error("❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

test();
