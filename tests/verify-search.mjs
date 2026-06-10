#!/usr/bin/env node

/**
 * 测试整合版 aiJdSearch（真人节奏 + 风控守卫 + 回车提交）
 *
 * 用账号二，真人间隔连搜 N 遍，看稳定性。
 * 触发风控时 aiJdSearch 内部会截图+提示手动处理。
 *
 * 用法: node tests/verify-search.mjs [轮数] [关键词]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession, aiJdSearch } from "../lib/ai-controller.js";

const ROUNDS = Number(process.argv[2] || 5);
const KEYWORD = process.argv[3] || "蛋白粉";
const JD2 = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

async function main() {
  console.log("========================================");
  console.log(`  测试 aiJdSearch（整合版）`);
  console.log(`  账号: 京东账号二 | 轮数: ${ROUNDS} | 词: ${KEYWORD}`);
  console.log(`  真人节奏: 轮次间隔 8-18 秒`);
  console.log("========================================\n");

  const session = await openAiSession(JD2);
  const page = session.page;

  let success = 0;
  const fails = {};

  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    let ok = false;
    let reason = "";
    try {
      const r = await aiJdSearch(page, KEYWORD);
      ok = r.productsCount > 0 && r.url.includes("search.jd.com");
      if (!ok) reason = `结果异常: ${r.productsCount}商品 url=${r.url}`;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    if (ok) {
      success++;
      console.log(`\n[第${i}/${ROUNDS}轮] ✅ 成功 (${dt}s)\n`);
    } else {
      fails[reason] = (fails[reason] || 0) + 1;
      console.log(`\n[第${i}/${ROUNDS}轮] ❌ 失败 (${dt}s): ${reason}\n`);
    }

    if (i < ROUNDS) {
      const gap = randInt(8000, 18000);
      console.log(`  ...真人间隔 ${(gap / 1000).toFixed(0)}s...`);
      await page.waitForTimeout(gap);
    }
  }

  const rate = ((success / ROUNDS) * 100).toFixed(0);
  console.log("\n========================================");
  console.log(`  成功率: ${success}/${ROUNDS} (${rate}%)`);
  if (Object.keys(fails).length) {
    console.log("  失败分布:");
    for (const [k, v] of Object.entries(fails)) console.log(`    - ${k}: ${v}次`);
  }
  console.log(success === ROUNDS ? "  >> 全过，稳定 ✅" : "  >> 有失败，看上面原因 ⚠️");
  console.log("========================================");
  console.log("\n[测试] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[测试] 异常:", e);
  process.exit(1);
});
