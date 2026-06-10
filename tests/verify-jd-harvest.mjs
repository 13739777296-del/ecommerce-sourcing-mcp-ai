#!/usr/bin/env node

/**
 * 验证京东选品总成 aiJdHarvest（小规模：翻1页，取3个详情）
 *
 * 用法: node tests/verify-jd-harvest.mjs [品牌] [翻页] [取详情数]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiJdHarvest, closeAiSession } from "../lib/ai-controller.js";

const BRAND = process.argv[2] || "SWISSE";
const MAX_PAGES = Number(process.argv[3] || 1);
const MAX_DETAIL = Number(process.argv[4] || 3);
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log(`验证 aiJdHarvest: ${BRAND}, 翻${MAX_PAGES}页, 取详情${MAX_DETAIL}个\n`);

  const session = await openAiSession(JD2);
  const result = await aiJdHarvest(session.page, BRAND, {
    maxPages: MAX_PAGES,
    maxDetail: MAX_DETAIL,
    minComments: 2
  });

  console.log(`\n========== 结果 ==========`);
  console.log(`统计:`, result.stats);
  console.log(`合格候选品(评价>2): ${result.candidates.length} 个\n`);
  result.candidates.forEach((c, i) => {
    console.log(`[${i + 1}] ${c.title?.slice(0, 36)}`);
    console.log(`    ¥${c.price} | 评价${c.comments} | 店铺:${c.shop}`);
    console.log(`    SKU:${(c.skuInfo || "").slice(0, 40)}`);
    console.log(`    链接:${c.url?.slice(0, 50)}`);
  });

  console.log("\n[harvest] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[harvest] 异常:", e);
  process.exit(1);
});
