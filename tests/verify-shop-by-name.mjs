#!/usr/bin/env node

/**
 * 验证：用店铺名回搜索页搜，结果是否都是这个店的货
 *
 * 用法: node tests/verify-shop-by-name.mjs [店铺名]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiJdSearch, aiExtractJdProducts, aiJdNextPage } from "../lib/ai-controller.js";

const SHOP_NAME = process.argv[2] || "香港直供保健买手店";
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log(`验证：搜店铺名 "${SHOP_NAME}"\n`);

  const session = await openAiSession(JD2);
  const page = session.page;

  await aiJdSearch(page, SHOP_NAME);

  // 第1页
  const p1 = await aiExtractJdProducts(page, 60);
  const sameShop1 = p1.filter((p) => p.shop && p.shop.includes(SHOP_NAME)).length;
  console.log(`[第1页] ${p1.length}个商品，属于"${SHOP_NAME}"的: ${sameShop1}个`);
  console.log(`  店铺名样例: ${[...new Set(p1.map((p) => p.shop).filter(Boolean))].slice(0, 5).join(" | ")}`);

  // 翻第2页
  const ok = await aiJdNextPage(page);
  if (ok) {
    const p2 = await aiExtractJdProducts(page, 60);
    const sameShop2 = p2.filter((p) => p.shop && p.shop.includes(SHOP_NAME)).length;
    const newIds = p2.filter((p) => !p1.map((x) => x.productId).includes(p.productId)).length;
    console.log(`[第2页] ${p2.length}个商品，属于该店:${sameShop2}个，新品:${newIds}个`);
  }

  console.log("\n========================================");
  if (sameShop1 >= p1.length * 0.5) {
    console.log(`  >> ✅ 搜店铺名有效，结果多数是该店的货`);
  } else {
    console.log(`  >> ⚠️ 结果里该店占比不高(${sameShop1}/${p1.length})，可能掺杂其他店`);
    console.log(`     注：搜店铺名京东会优先展示该店，但也可能混入相关品`);
  }
  console.log("========================================");
  console.log("\n[shop-name] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[shop-name] 异常:", e);
  process.exit(1);
});
