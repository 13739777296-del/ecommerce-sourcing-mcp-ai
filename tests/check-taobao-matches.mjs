#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { calculateUnitPrice } from "../lib/unit-price.js";

async function checkTaobaoMatches() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");
  await aiTaobaoSearch(session.page, "MYPROTEIN 1000g");
  const products = await aiExtractTaobaoProducts(session.page, 20);

  console.log("=== 淘宝商品单价分析 ===\n");
  console.log(`京东：MYPROTEIN 1000g ¥161`);
  console.log(`京东单价问题：识别为\"包\"，无法和淘宝比较\n`);

  products.forEach((p, i) => {
    const salesMatch = p.sales?.match(/(\d+(?:\.\d+)?)[万千]?/);
    const salesNum = salesMatch ? parseFloat(salesMatch[1]) : 0;
    const actualSales = p.sales?.includes('万') ? salesNum * 10000 : (p.sales?.includes('千') ? salesNum * 1000 : salesNum);

    if (!p.isDomestic || actualSales < 10) return;

    const unitPrice = calculateUnitPrice(p.price, p.title);
    console.log(`${i + 1}. ${p.title.substring(0, 45)}...`);
    console.log(`   价格: ¥${p.price} | 销量: ${p.sales} | 发货: ${p.shipFrom}`);
    console.log(`   单价: ¥${unitPrice.unitPrice?.toFixed(4) || '?'}/${unitPrice.unit || '?'}`);
    console.log(`   规格: ${JSON.stringify(unitPrice.spec)}`);
    console.log();
  });

  process.exit(0);
}

checkTaobaoMatches();
