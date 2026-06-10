#!/usr/bin/env node

/**
 * 验证淘宝列表筛选（国内+48h+已售≥10），先不进详情
 *
 * 用法: node tests/verify-taobao-filter.mjs [关键词] [最低已售]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiTaobaoHarvest } from "../lib/ai-controller.js";

const KEYWORD = process.argv[2] || "swisse 护肝片";
const MIN_SALES = Number(process.argv[3] || 10);
const TB = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/taobao/85196a47-9964-4811-bedd-5fc8f5a57f96"
);

async function main() {
  console.log(`验证淘宝列表筛选: "${KEYWORD}", 已售≥${MIN_SALES}\n`);

  const session = await openAiSession(TB);
  const result = await aiTaobaoHarvest(session.page, KEYWORD, {
    maxList: 40,
    maxDetail: 2,
    minSales: MIN_SALES,
    requireDomestic: true,
    require48h: true
  });

  console.log(`\n========== 筛选结果 ==========`);
  console.log(`统计:`, result.stats);
  console.log(`符合(国内+48h+已售≥${MIN_SALES}): ${result.candidates.length} 个\n`);
  result.candidates.slice(0, 10).forEach((c, i) => {
    console.log(`[${i + 1}] ${c.title?.slice(0, 32)}`);
    console.log(`    ¥${c.price} | ${c.shipFrom}(${c.isDomestic ? '国内' : '海外'}) | ${c.sales} | ${c.ship48h ? '48h发✓' : '非48h'}${c.detailOk ? ' | 详情✓' : ''}`);
    if (c.skuInfo) console.log(`    SKU: ${c.skuInfo.replace(/\n/g, ' ').slice(0, 60)}`);
  });

  console.log("\n[tb-filter] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[tb-filter] 异常:", e);
  process.exit(1);
});
