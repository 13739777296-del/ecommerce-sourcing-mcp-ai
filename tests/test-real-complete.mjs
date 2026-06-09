#!/usr/bin/env node

/**
 * 真实完整流程测试
 * 目标：找到第一个真正可用的品！
 *
 * 策略：
 * 1. 直接搜"辅酶Q10 买手店"（精准定位）
 * 2. 多翻几页（不只看第一页）
 * 3. 找到买手店后，点进详情
 * 4. 用商品图去淘宝搜
 * 5. 比价 + 计算利润
 * 6. 找到1个可用品就成功！
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { handler } from "../tools/sourcing.js";

async function realTest() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("========================================");
  console.log("  真实完整流程测试");
  console.log("  目标：找到第1个可用品！");
  console.log("========================================\n");

  try {
    // 策略1：直接搜"买手店"关键词
    console.log("【策略1】搜索 '辅酶Q10 买手店'...\n");

    const result = await handler(ctx, db, {
      action: "full_selection",
      keyword: "辅酶Q10 买手店",
      strategyId: "no-source-arbitrage",
      maxJdCandidates: 5,           // 处理5个京东品
      maxTaobaoCandidatesPerJd: 10  // 每个京东品搜10个淘宝
    });

    if (result.matchedCount > 0) {
      console.log("\n🎉🎉🎉 成功找到可用品！🎉🎉🎉\n");
      console.log("=== 可用品详情 ===");
      result.matched.forEach((m, i) => {
        console.log(`\n【第${i + 1}个可用品】`);
        console.log(`\n京东端：`);
        console.log(`  标题: ${m.jd.title}`);
        console.log(`  价格: ¥${m.jd.price} (${m.jd.unitPrice ? `¥${m.jd.unitPrice.toFixed(4)}/${m.jd.unit}` : '无规格'})`);
        console.log(`  店铺: ${m.jd.shop} (${m.jd.shopType})`);
        console.log(`  销量: ${m.jd.sales}`);
        console.log(`  链接: ${m.jd.url}`);

        console.log(`\n淘宝端：`);
        console.log(`  标题: ${m.taobao.title}`);
        console.log(`  价格: ¥${m.taobao.price} (${m.taobao.unitPrice ? `¥${m.taobao.unitPrice.toFixed(4)}/${m.taobao.unit}` : '无规格'})`);
        console.log(`  店铺: ${m.taobao.shop}`);
        console.log(`  销量: ${m.taobao.sales}`);
        console.log(`  发货: ${m.taobao.shipFrom || '未知'}${m.taobao.shipHours ? ` (${m.taobao.shipHours}小时内)` : ''}`);
        console.log(`  链接: ${m.taobao.url}`);

        console.log(`\n利润分析：`);
        console.log(`  利润率: ${(m.profit.rate * 100).toFixed(1)}%`);
        console.log(`  利润额: ¥${m.profit.amount?.toFixed(2) || '?'}`);
      });

      console.log("\n========================================");
      console.log(`  ✅ 完整流程测试通过！`);
      console.log(`  找到 ${result.matchedCount} 个可用品`);
      console.log("========================================\n");

    } else {
      console.log("\n⚠️  策略1没找到，尝试策略2...\n");

      // 策略2：普通搜索，但多处理几个
      console.log("【策略2】普通搜索 '辅酶Q10'，多处理几个候选...\n");

      const result2 = await handler(ctx, db, {
        action: "full_selection",
        keyword: "辅酶Q10",
        strategyId: "no-source-arbitrage",
        maxJdCandidates: 20,  // 多处理，总能找到买手店
        maxTaobaoCandidatesPerJd: 10
      });

      if (result2.matchedCount > 0) {
        console.log(`\n🎉 策略2成功！找到 ${result2.matchedCount} 个可用品`);
      } else {
        console.log("\n❌ 策略2也没找到");
        console.log("\n建议：");
        console.log("1. 换其他关键词试试（鱼油、维生素D等）");
        console.log("2. 调整策略（放宽买手店限制）");
        console.log("3. 检查京东/淘宝账号是否正常");
      }
    }

  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

realTest();
