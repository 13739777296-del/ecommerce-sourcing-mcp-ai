#!/usr/bin/env node

/**
 * 调试：看看京东到底有哪些店铺类型
 */

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function debugShopTypes() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  console.log("=== 调试：京东店铺类型分析 ===\n");

  const keywords = [
    "辅酶Q10",
    "鱼油",
    "维生素D",
    "蛋白粉",
    "钙片"
  ];

  for (const keyword of keywords) {
    console.log(`\n【${keyword}】`);

    try {
      const session = await openAiSessionWithAccount(ctx, db, "jd");
      await aiJdSearch(session.page, keyword);
      const products = await aiExtractJdProducts(session.page, 30);

      // 统计店铺类型
      const shopTypes = {};
      products.forEach(p => {
        const type = p.shopType || 'unknown';
        shopTypes[type] = (shopTypes[type] || 0) + 1;
      });

      console.log(`  总数: ${products.length}`);
      console.log(`  店铺类型分布:`);
      for (const [type, count] of Object.entries(shopTypes).sort((a, b) => b[1] - a[1])) {
        const typeName = {
          'buyer': '买手店',
          'flagship': '旗舰店',
          'overseas': '海外店',
          'jd_self': '京东自营',
          'official': '官方店',
          'franchise': '专营店',
          'dealer': '专卖店',
          'unknown': '未知'
        }[type] || type;
        console.log(`    ${typeName}: ${count}`);
      }

      // 显示买手店示例
      const buyerShops = products.filter(p => p.shopType === 'buyer');
      if (buyerShops.length > 0) {
        console.log(`\n  ✅ 找到 ${buyerShops.length} 个买手店，示例:`);
        buyerShops.slice(0, 3).forEach(p => {
          console.log(`    - ${p.shop}: ${p.title.substring(0, 40)}...`);
        });
      } else {
        console.log(`\n  ⚠️  没有买手店`);
      }

    } catch (error) {
      console.log(`  ❌ 失败: ${error.message}`);
    }
  }

  process.exit(0);
}

debugShopTypes();
