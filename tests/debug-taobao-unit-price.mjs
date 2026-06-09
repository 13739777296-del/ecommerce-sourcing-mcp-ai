#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { calculateUnitPrice } from "../lib/unit-price.js";

async function debugTaobao() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");
  await aiTaobaoSearch(session.page, "MYPROTEIN 乳清蛋白粉 1000g");
  const products = await aiExtractTaobaoProducts(session.page, 10);

  console.log("=== 淘宝商品详情 ===\n");
  products.slice(0, 5).forEach((p, i) => {
    console.log(`【${i + 1}】${p.title.substring(0, 50)}...`);
    console.log(`   价格: ¥${p.price} | 销量: ${p.sales} | 发货: ${p.shipFrom}`);

    // 计算单价
    const unitPrice = calculateUnitPrice(p.price, p.title);
    console.log(`   单价: ¥${unitPrice.unitPrice?.toFixed(4) || '?'}/${unitPrice.unit || '?'}`);
    console.log(`   规格识别: ${unitPrice.spec ? JSON.stringify(unitPrice.spec) : '无'}`);
    console.log();
  });

  process.exit(0);
}

debugTaobao();
