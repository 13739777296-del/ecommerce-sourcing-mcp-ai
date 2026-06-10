#!/usr/bin/env node

/**
 * 探查：淘宝列表页DOM结构（重点找 48h发货 / 发货地 / 已售 三个字段）
 *
 * 淘宝列表页就能筛：是否48h发货、是否国内发货、已售多少。
 * 先把卡片结构和这三个字段的位置dump出来，再写提取逻辑。
 *
 * 用法: node tests/probe-taobao-list.mjs [关键词]
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
  console.log(`探查淘宝列表页DOM: "${KEYWORD}"\n`);

  const session = await openAiSession(TB);
  const page = session.page;

  await aiTaobaoSearch(page, KEYWORD);
  await page.waitForTimeout(3000);
  await aiScrollPage(page, 4);
  await page.waitForTimeout(2000);

  console.log(`页面标题: ${await page.title()}`);
  console.log(`当前URL: ${page.url().slice(0, 80)}\n`);

  const probe = await page.evaluate(() => {
    // 商品链接定位（淘宝商品卡用 item.taobao.com / detail.tmall.com）
    const links = document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
    const out = { linkCount: links.length, samples: [] };

    // 取前3个商品卡，dump其文本和关键字段
    const seen = new Set();
    for (const a of links) {
      const m = (a.href || "").match(/id=(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const card = a.closest('div[class*="Card"], div[class*="item"], div[class*="content"]') || a.parentElement;
      const text = (card?.innerText || "").trim();
      out.samples.push({
        id: m[1],
        href: a.href.slice(0, 50),
        cardClass: (card?.className || "").toString().slice(0, 50),
        text: text.slice(0, 200)
      });
      if (out.samples.length >= 3) break;
    }

    // 全页文本里找关键字段线索
    const bodyText = document.body.innerText || "";
    out.has48h = /48小时|24小时|当日发|次日达|小时内发货/.test(bodyText);
    out.shipFromHints = (bodyText.match(/[一-龥]{2,4}(?=\s*发货)/g) || []).slice(0, 8);
    out.salesHints = (bodyText.match(/\d+(?:\.\d+)?[万]?\+?\s*人?(?:付款|已售|销量)/g) || []).slice(0, 8);

    return out;
  });

  console.log(`商品链接数: ${probe.linkCount}`);
  console.log(`页面含"48h/24h发货"字样: ${probe.has48h}`);
  console.log(`发货地线索: ${probe.shipFromHints.join(" | ") || "无"}`);
  console.log(`已售线索: ${probe.salesHints.join(" | ") || "无"}`);

  console.log(`\n商品卡样例:`);
  probe.samples.forEach((s, i) => {
    console.log(`\n[${i + 1}] id=${s.id} cardClass="${s.cardClass}"`);
    console.log(`    文本: ${s.text.replace(/\n/g, " / ")}`);
  });

  console.log("\n[tb-list] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[tb-list] 异常:", e);
  process.exit(1);
});
