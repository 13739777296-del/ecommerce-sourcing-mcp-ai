#!/usr/bin/env node

/**
 * 测试All-in-One工具的完整选品流程
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler } from "../tools/sourcing.js";

async function test() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("=== All-in-One工具测试 ===\n");

  try {
    // 1. 查看策略模板
    console.log("【1】查看策略模板...");
    const templates = await handler(ctx, db, { action: "strategy_templates" });
    console.log(`✅ ${templates.templates.length} 个策略:`);
    templates.templates.forEach(t => {
      console.log(`   - ${t.id}: ${t.name}`);
    });

    // 2. 京东搜索+按策略筛选
    console.log("\n【2】京东搜索并按策略筛选...");
    const jdResult = await handler(ctx, db, {
      action: "jd_search_filter",
      keyword: "辅酶Q10",
      strategyId: "no-source-arbitrage",
      maxCount: 20
    });

    if (!jdResult.ok) {
      console.error("❌ 失败:", jdResult.message);
      return;
    }

    console.log(`✅ 策略[${jdResult.strategy.name}]筛选:`);
    console.log(`   总数: ${jdResult.total}`);
    console.log(`   通过: ${jdResult.passed}`);
    console.log(`\n   通过的商品（买手店）:`);
    jdResult.passedProducts.slice(0, 3).forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.title.substring(0, 40)}... ¥${p.price} (${p.shop})`);
    });

    // 3. 完整选品流程（小规模测试）
    console.log("\n\n【3】完整选品流程（京东→淘宝→比价）...");
    console.log("   注意：这会打开详情页、切换淘宝搜图，需要较长时间\n");

    const fullResult = await handler(ctx, db, {
      action: "full_selection",
      keyword: "辅酶Q10",
      strategyId: "no-source-arbitrage",
      maxJdCandidates: 2,  // 只处理2个京东品（测试用）
      maxTaobaoCandidatesPerJd: 5  // 每个京东品搜5个淘宝
    });

    if (!fullResult.ok) {
      console.error("❌ 失败:", fullResult.message);
      return;
    }

    console.log(`\n✅ 完整选品完成！找到 ${fullResult.matchedCount} 个可用品`);

    if (fullResult.matchedCount > 0) {
      console.log("\n=== 可用品详情 ===");
      fullResult.matched.forEach((m, i) => {
        console.log(`\n  【${i + 1}】`);
        console.log(`  京东: ${m.jd.title.substring(0, 50)}`);
        console.log(`    价格: ¥${m.jd.price} | 单价: ¥${m.jd.unitPrice?.toFixed(4)}/${m.jd.unit}`);
        console.log(`    店铺: ${m.jd.shop} (${m.jd.shopType})`);
        console.log(`    链接: ${m.jd.url}`);
        console.log(`\n  淘宝: ${m.taobao.title.substring(0, 50)}`);
        console.log(`    价格: ¥${m.taobao.price} | 单价: ¥${m.taobao.unitPrice?.toFixed(4)}/${m.taobao.unit}`);
        console.log(`    发货: ${m.taobao.shipFrom || '?'}`);
        console.log(`    链接: ${m.taobao.url}`);
        console.log(`\n  利润: 利润率 ${(m.profit.rate * 100).toFixed(1)}% | 利润额 ¥${m.profit.amount?.toFixed(2)}`);
      });
    }

    console.log("\n=== 🎉 All-in-One工具测试通过！ ===");

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

test();
