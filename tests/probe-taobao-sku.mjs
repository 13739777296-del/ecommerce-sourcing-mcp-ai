#!/usr/bin/env node

/**
 * 探查：淘宝详情页 SKU 区域结构（不同SKU选项 + 各自价格）
 *
 * 用户强调：同一链接不同SKU(60粒/200粒)价差很大，必须按SKU比价。
 * 目标：找到SKU选项区、点选不同SKU时价格怎么变。
 *
 * 用法: node tests/probe-taobao-sku.mjs
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiTaobaoSearch, aiScrollPage } from "../lib/ai-controller.js";

const KEYWORD = process.argv[2] || "swisse 护肝片";
const TB = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/taobao/85196a47-9964-4811-bedd-5fc8f5a57f96"
);

async function main() {
  console.log(`探查淘宝详情页SKU: 搜"${KEYWORD}"取第1个进详情\n`);

  const session = await openAiSession(TB);
  const page = session.page;
  const context = page.context();

  await aiTaobaoSearch(page, KEYWORD);
  await page.waitForTimeout(2500);
  await aiScrollPage(page, 2);

  // 点第1个商品（新标签页）
  const firstLink = page.locator('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]').first();
  const before = context.pages().length;
  await firstLink.click().catch(() => {});
  await page.waitForTimeout(3500);

  const pages = context.pages();
  const detail = pages.length > before ? pages[pages.length - 1] : page;
  await detail.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await detail.waitForTimeout(2000);
  await aiScrollPage(detail, 2);

  console.log(`详情页URL: ${detail.url().slice(0, 70)}`);
  console.log(`详情页标题: ${(await detail.title()).slice(0, 50)}\n`);

  const probe = await detail.evaluate(() => {
    const out = { skuBlocks: [], priceTexts: [] };

    // 找SKU选项区：常见关键词"选择/规格/分类/数量"附近的可点击项
    const skuKeywords = ['规格', '分类', '选择', '套餐', '数量', '版本', '口味', '颜色'];
    const allEls = Array.from(document.querySelectorAll('div, dl, ul'));
    for (const el of allEls) {
      const t = (el.innerText || '').trim();
      if (t.length < 4 || t.length > 200) continue;
      if (skuKeywords.some(k => t.startsWith(k) || t.includes(k + '：') || t.includes(k + ':'))) {
        // 找它里面的可点击SKU项
        const items = el.querySelectorAll('[class*="valueItem"], [class*="sku"], li, [role="button"], span[class*="text"]');
        const labels = Array.from(items).map(it => (it.innerText || '').trim()).filter(x => x && x.length < 30);
        if (labels.length >= 2) {
          out.skuBlocks.push({ head: t.slice(0, 20), cls: (el.className || '').toString().slice(0, 40), options: [...new Set(labels)].slice(0, 12) });
        }
      }
    }

    // 价格文本（找所有带¥的）
    const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"]');
    const seen = new Set();
    for (const el of priceEls) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && /\d/.test(t) && t.length < 30 && !seen.has(t)) { seen.add(t); out.priceTexts.push({ cls: (el.className||'').toString().slice(0,30), text: t }); }
      if (out.priceTexts.length >= 10) break;
    }
    return out;
  });

  console.log(`=== SKU选项区(找到${probe.skuBlocks.length}个) ===`);
  probe.skuBlocks.forEach((b, i) => {
    console.log(`[${i + 1}] ${b.head} (class=${b.cls})`);
    console.log(`    选项: ${b.options.join(' | ')}`);
  });

  console.log(`\n=== 价格元素(找到${probe.priceTexts.length}个) ===`);
  probe.priceTexts.forEach((p, i) => console.log(`[${i + 1}] "${p.text}" (class=${p.cls})`));

  console.log("\n[tb-sku] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[tb-sku] 异常:", e);
  process.exit(1);
});
