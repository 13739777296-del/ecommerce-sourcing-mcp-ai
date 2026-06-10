#!/usr/bin/env node

/**
 * 京东-动作B+C：点买手店商品进详情页 → 探查"进店铺"入口
 *
 * 真人逻辑：列表页点买手店品 → 详情页 → 点店铺名进店。
 * 先探查详情页里到底哪个链接能进店铺（mall.jd.com / "进入店铺" / 店铺名链接），
 * dump 出来据此写稳定的进店逻辑。
 *
 * 用法: node tests/verify-jd-detail-shop.mjs [品牌词]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  openAiSession,
  aiJdSearch,
  aiExtractJdProducts,
  aiClickProduct,
  aiExtractJdDetail
} from "../lib/ai-controller.js";

const KEYWORD = (process.argv[2] || "SWISSE") + " 买手店";
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log("========================================");
  console.log(`  京东-动作B+C：进详情页 + 探查进店入口`);
  console.log(`  关键词: ${KEYWORD}`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  await aiJdSearch(page, KEYWORD);
  const products = await aiExtractJdProducts(page, 60);
  const buyers = products.filter((p) => p.shopType === "buyer");
  console.log(`\n[B] 买手店商品 ${buyers.length} 个，点第1个进详情...`);
  if (buyers.length === 0) {
    console.log("没有买手店商品，换个品牌词");
    return;
  }

  // 找到第1个买手店商品在原始列表里的索引
  const firstBuyerIndex = products.findIndex((p) => p.shopType === "buyer");
  console.log(`[B] 第1个买手店商品原始索引: ${firstBuyerIndex}，标题: ${buyers[0].title.slice(0, 30)}`);

  // 点进详情页
  const result = await aiClickProduct(page, firstBuyerIndex);
  const detailPage = result.page;
  console.log(`[B] ✅ 进入详情页: ${result.url}`);
  console.log(`[B] 标题: ${result.title.slice(0, 50)}`);

  // 提取详情（含评价数）
  const detail = await aiExtractJdDetail(detailPage);
  console.log(`\n[B] 详情提取: 评价数="${detail.comments}" 价格=¥${detail.price} 店铺="${detail.shop}"`);

  // ===== 探查进店入口 =====
  console.log(`\n[C] 探查详情页里所有可能的"进店铺"链接...`);
  const shopLinks = await detailPage.evaluate(() => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll("a"));
    for (const a of anchors) {
      const href = a.href || "";
      const txt = (a.innerText || "").trim().slice(0, 20);
      // 店铺相关：mall.jd.com、含"店铺"/"进店"字样、或文本是店铺名
      if (
        href.includes("mall.jd.com") ||
        href.includes("shop.jd.com") ||
        /进入店铺|进店|店铺首页|查看店铺|关注店铺/.test(txt) ||
        /店$/.test(txt)
      ) {
        out.push({ txt, href: href.slice(0, 80) });
      }
    }
    // 去重
    const seen = new Set();
    return out.filter((o) => {
      const k = o.href;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 15);
  });

  console.log(`[C] 找到 ${shopLinks.length} 个候选进店链接:`);
  shopLinks.forEach((l, i) => {
    console.log(`  [${i + 1}] "${l.txt}" -> ${l.href}`);
  });

  console.log("\n========================================");
  console.log("  >> 看上面哪个链接是真正的店铺入口，据此写进店逻辑");
  console.log("========================================");
  console.log("\n[B+C] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[B+C] 异常:", e);
  process.exit(1);
});
