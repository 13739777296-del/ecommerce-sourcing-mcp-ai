#!/usr/bin/env node

/**
 * 京东-动作A：列表页识别买手店商品
 *
 * 搜索 → 提取列表 → 统计店铺类型分布 → 列出买手店商品。
 * 重点：买手店在列表页就能判断，先筛掉非买手店，减少后续进详情次数。
 *
 * 用法: node tests/verify-jd-buyer.mjs [关键词]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiJdSearch, aiExtractJdProducts } from "../lib/ai-controller.js";

const KEYWORD = process.argv[2] || "蛋白粉";
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log("========================================");
  console.log(`  京东-动作A：列表页识别买手店`);
  console.log(`  关键词: ${KEYWORD}`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  await aiJdSearch(page, KEYWORD);
  const products = await aiExtractJdProducts(page, 60);

  console.log(`\n[结果] 共提取 ${products.length} 个商品\n`);

  // 统计店铺类型分布
  const byType = {};
  for (const p of products) {
    byType[p.shopType] = (byType[p.shopType] || 0) + 1;
  }
  console.log("店铺类型分布:");
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}个`);
  }

  // 列出买手店商品
  const buyers = products.filter((p) => p.shopType === "buyer");
  console.log(`\n买手店商品: ${buyers.length} 个`);
  buyers.slice(0, 10).forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title.slice(0, 34)}`);
    console.log(`      ¥${p.price} | 店铺:${p.shop} | ${p.sales || "无销量"}`);
  });

  // 也列出几个"未识别"的，看是不是漏判的买手店
  const unknowns = products.filter((p) => p.shopType === "unknown");
  if (unknowns.length > 0) {
    console.log(`\n⚠️ 未识别店铺类型: ${unknowns.length} 个（可能是漏判，需看店铺名）`);
    unknowns.slice(0, 5).forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.title.slice(0, 30)} | 店铺字段:"${p.shop || "(空)"}"`);
    });
  }

  console.log("\n========================================");
  if (buyers.length > 0) {
    console.log(`  >> 找到 ${buyers.length} 个买手店商品，可进下一步 ✅`);
  } else {
    console.log(`  >> 没找到买手店，可能识别逻辑要调，或这个词买手店少 ⚠️`);
  }
  console.log("========================================");
  console.log("\n[A] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[A] 异常:", e);
  process.exit(1);
});
