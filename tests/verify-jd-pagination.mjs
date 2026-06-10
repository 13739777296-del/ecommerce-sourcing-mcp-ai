#!/usr/bin/env node

/**
 * 探查：搜索结果页能否翻页（最关键，决定能否拉大量品）
 *
 * 搜"品牌+买手店" → 第1页商品 → 找翻页控件 → 翻到第2页 → 看商品是否变化。
 *
 * 用法: node tests/verify-jd-pagination.mjs [品牌词]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiJdSearch, aiExtractJdProducts, aiScrollPage } from "../lib/ai-controller.js";

const KEYWORD = `${process.argv[2] || "SWISSE"} 买手店`;
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

async function main() {
  console.log("========================================");
  console.log(`  探查搜索结果页翻页能力`);
  console.log(`  搜索词: ${KEYWORD}`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  await aiJdSearch(page, KEYWORD);

  // 第1页商品
  const page1 = await aiExtractJdProducts(page, 60);
  const page1Ids = page1.map((p) => p.productId);
  console.log(`\n[第1页] ${page1.length} 个商品，前3个ID: ${page1Ids.slice(0, 3).join(", ")}`);

  // 探查翻页控件：dump 页面上所有可能的翻页元素
  console.log(`\n[探查] 页面上的翻页控件:`);
  const pagers = await page.evaluate(() => {
    const out = [];
    // 常见翻页选择器
    const candidates = [
      ".pn-next", "a.pn-next", ".page-next", "[class*='next']",
      "a[class*='next']", ".ui-pager-next", "#J_bottomPage .pn-next"
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        for (const el of els) {
          out.push({
            sel,
            tag: el.tagName,
            txt: (el.innerText || "").trim().slice(0, 10),
            cls: (el.className || "").toString().slice(0, 50),
            disabled: el.className.includes("disabled")
          });
        }
      }
    }
    // 也找所有含"下一页"文本的元素
    const allEls = Array.from(document.querySelectorAll("a, button, div, span"));
    for (const el of allEls) {
      const t = (el.innerText || "").trim();
      if (t === "下一页" || t === ">") {
        out.push({ sel: "(文本匹配)", tag: el.tagName, txt: t, cls: (el.className || "").toString().slice(0, 50), disabled: false });
      }
    }
    // 去重
    const seen = new Set();
    return out.filter((o) => {
      const k = o.sel + o.cls + o.txt;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 15);
  });

  if (pagers.length === 0) {
    console.log("  ⚠️ 没找到任何翻页控件！可能是无限滚动加载");
  } else {
    pagers.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.sel} <${p.tag}> "${p.txt}" cls="${p.cls}" ${p.disabled ? "[禁用]" : ""}`);
    });
  }

  // 尝试方式1：滚到底看是否自动加载更多（京东新版可能无限滚动）
  console.log(`\n[尝试1] 滚到底看是否无限加载...`);
  await aiScrollPage(page, 6);
  await page.waitForTimeout(3000);
  const afterScroll = await aiExtractJdProducts(page, 120);
  console.log(`  滚动后商品数: ${afterScroll.length}（第1页是${page1.length}）`);
  const newAfterScroll = afterScroll.filter((p) => !page1Ids.includes(p.productId)).length;
  console.log(`  滚动后新增: ${newAfterScroll} 个`);

  // 尝试方式2：点下一页按钮（京东新版是 div，class含 pagination_next，文本"下一页"）
  console.log(`\n[尝试2] 点"下一页"按钮（新版div分页）...`);
  // 用 Playwright locator 真实点击：文本是"下一页"的元素
  const nextBtn = page.locator('[class*="pagination_next"]').filter({ hasText: "下一页" }).first();
  let clicked = false;
  const nextVisible = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (nextVisible) {
    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(800);
    await nextBtn.click().catch((e) => console.log(`  点击异常: ${e.message}`));
    clicked = true;
  }
  console.log(`  点击下一页: ${clicked ? "成功触发" : "没找到可点的下一页"}`);

  if (clicked) {
    await page.waitForTimeout(4000);
    await aiScrollPage(page, 3);
    const page2 = await aiExtractJdProducts(page, 60);
    const page2Ids = page2.map((p) => p.productId);
    const newOnes = page2Ids.filter((id) => !page1Ids.includes(id)).length;
    console.log(`  [第2页] ${page2.length} 个商品，其中 ${newOnes} 个是新的`);
    console.log(`  当前URL: ${page.url()}`);
    if (newOnes > 10) {
      console.log(`\n  >> ✅ 翻页有效！第2页有 ${newOnes} 个新品`);
    } else {
      console.log(`\n  >> ⚠️ 翻页后新品很少，可能没真翻页`);
    }
  }

  console.log("\n========================================");
  console.log("  看上面：无限滚动 or 下一页按钮，哪个能拿到更多品");
  console.log("========================================");
  console.log("\n[翻页] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[翻页] 异常:", e);
  process.exit(1);
});
