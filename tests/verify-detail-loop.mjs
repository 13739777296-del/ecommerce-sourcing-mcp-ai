#!/usr/bin/env node

/**
 * 验证：连续进多个详情页拿评价（动作E的高频核心，最易触发风控）
 *
 * 搜"品牌+买手店" → 取前N个买手店品 → 逐个进详情页拿评价数(真人间隔)
 * 看连续进详情页稳不稳、评价数拿得到不。
 *
 * 用法: node tests/verify-detail-loop.mjs [品牌] [个数]
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

const BRAND = process.argv[2] || "SWISSE";
const N = Number(process.argv[3] || 5);
const KEYWORD = `${BRAND} 买手店`;
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

async function main() {
  console.log(`验证连续进详情页拿评价: ${KEYWORD}, 前${N}个买手店品\n`);

  const session = await openAiSession(JD2);
  const page = session.page;

  await aiJdSearch(page, KEYWORD);
  const products = await aiExtractJdProducts(page, 60);
  const buyerIdx = products
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.shopType === "buyer")
    .slice(0, N);

  console.log(`买手店品 ${buyerIdx.length} 个，开始逐个进详情...\n`);

  const results = [];
  let success = 0;
  const listUrl = page.url(); // 记下搜索结果页URL，用于必要时恢复

  for (let k = 0; k < buyerIdx.length; k++) {
    const { i } = buyerIdx[k];
    const t0 = Date.now();
    try {
      const clicked = await aiClickProduct(page, i);
      const detailPage = clicked.page;
      const detail = await aiExtractJdDetail(detailPage);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const pass = detail.comments && parseInt(detail.comments) > 2;
      results.push({ title: detail.title?.slice(0, 24), comments: detail.comments, price: detail.price, pass });
      success++;
      console.log(`[${k + 1}/${buyerIdx.length}] ✅ ${dt}s | 评价:${detail.comments || "?"} ¥${detail.price} | ${detail.title?.slice(0, 24)}`);

      // 恢复到列表页：新标签页→关掉回列表；原页跳转→重新goto列表URL
      if (detailPage !== page) {
        await detailPage.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      }
      // 确保 page 在搜索结果页（若被带走了就回去）
      if (!page.url().includes("search.jd.com")) {
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${k + 1}/${buyerIdx.length}] ❌ ${dt}s | ${e instanceof Error ? e.message.slice(0, 50) : e}`);
      // 失败也尝试恢复列表页
      if (!page.url().includes("search.jd.com")) {
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    if (k < buyerIdx.length - 1) {
      const gap = randInt(4000, 9000);
      console.log(`  ...真人间隔 ${(gap / 1000).toFixed(0)}s...`);
      await page.waitForTimeout(gap);
    }
  }

  console.log(`\n========================================`);
  console.log(`  连续进详情: ${success}/${buyerIdx.length} 成功`);
  console.log(`  评价>2的: ${results.filter((r) => r.pass).length} 个`);
  console.log(success === buyerIdx.length ? "  >> 高频进详情稳定 ✅" : "  >> 有失败，看原因 ⚠️");
  console.log(`========================================`);
  console.log("\n[detail-loop] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[detail-loop] 异常:", e);
  process.exit(1);
});
