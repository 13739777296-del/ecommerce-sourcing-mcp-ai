#!/usr/bin/env node

/**
 * 京东 B→C→D 串联：进详情 → 拿店铺URL → 进店 → 扒店铺全部商品
 *
 * 真人逻辑：搜"品牌+买手店" → 点1个买手店品进详情 → 进店 → 整店扒货(翻页)
 *
 * 用法: node tests/verify-jd-shop-harvest.mjs [品牌词] [最多翻页]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  openAiSession,
  aiJdSearch,
  aiExtractJdProducts,
  aiClickProduct,
  aiExtractJdDetail,
  aiJdEnterShop,
  aiExtractShopAllProducts
} from "../lib/ai-controller.js";

const BRAND = process.argv[2] || "SWISSE";
const MAX_PAGES = Number(process.argv[3] || 3);
const KEYWORD = `${BRAND} 买手店`;
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log("========================================");
  console.log(`  京东 B→C→D 串联验证`);
  console.log(`  搜索词: ${KEYWORD} | 最多翻${MAX_PAGES}页`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  // B: 搜索 + 找买手店 + 进详情
  await aiJdSearch(page, KEYWORD);
  const products = await aiExtractJdProducts(page, 60);
  const firstBuyerIndex = products.findIndex((p) => p.shopType === "buyer");
  if (firstBuyerIndex < 0) {
    console.log("没找到买手店商品，换品牌词");
    return;
  }
  console.log(`\n[B] 点第1个买手店品(索引${firstBuyerIndex}): ${products[firstBuyerIndex].title.slice(0, 30)}`);
  const clicked = await aiClickProduct(page, firstBuyerIndex);
  const detailPage = clicked.page;
  const detail = await aiExtractJdDetail(detailPage);
  console.log(`[B] ✅ 详情: 评价=${detail.comments || "?"} 店铺="${detail.shop}" shopUrl=${detail.shopUrl}`);

  if (!detail.shopUrl) {
    console.log("[C] ❌ 没拿到店铺URL，无法进店");
    return;
  }

  // C: 进店
  console.log(`\n[C] 进店铺...`);
  const shopResult = await aiJdEnterShop(detailPage, detail.shopUrl);
  console.log(`[C] ✅ 已进店: ${shopResult.title}`);

  // D: 扒店铺全部商品
  console.log(`\n[D] 扒店铺全部商品(最多${MAX_PAGES}页)...`);
  const shopProducts = await aiExtractShopAllProducts(detailPage, MAX_PAGES);
  console.log(`\n[D] ✅ 店内共扒到 ${shopProducts.length} 个商品`);
  shopProducts.slice(0, 8).forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title.slice(0, 32)} | ¥${p.price} | ${p.sales || "无销量"}`);
  });

  console.log("\n========================================");
  console.log(`  B进详情✅ C进店✅ D扒店${shopProducts.length > 0 ? "✅" : "❌"}`);
  console.log(`  店内商品数: ${shopProducts.length}`);
  console.log("========================================");
  console.log("\n[BCD] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[BCD] 异常:", e);
  process.exit(1);
});
