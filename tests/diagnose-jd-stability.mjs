#!/usr/bin/env node

/**
 * 京东搜索稳定性诊断
 *
 * 目的：不改业务逻辑，只测量。
 * 在一个长期浏览器实例里，用同一个关键词连续搜 N 次，
 * 每次记录：到达的URL、商品数、耗时、失败时的页面状态+截图。
 *
 * 用数据回答："时好时坏"到底是会话脏、链路长、还是真实风控。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiJdSearch } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

const KEYWORD = process.argv[2] || "蛋白粉";
const ROUNDS = Number(process.argv[3] || 10);
const SHOT_DIR = join(process.cwd(), "tests", "diagnose-shots");

// 复用 accounts.js 里的风控检测口径
const RISK_RE = /验证码|滑块|安全验证|访问频繁|账号异常|环境异常|拦截/;

async function snapshot(page) {
  const url = page.url();
  let bodyText = "";
  try {
    bodyText = await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    bodyText = "(无法读取body)";
  }
  const onSearchPage = url.includes("search.jd.com");
  const productCount = await page.locator("div[data-sku]").count().catch(() => 0);
  const riskHit = RISK_RE.test(bodyText);
  const bouncedHome = /www\.jd\.com\/?(\?|$)/.test(url) && !onSearchPage;
  return { url, onSearchPage, productCount, riskHit, bouncedHome };
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  console.log("========================================");
  console.log("  京东搜索稳定性诊断");
  console.log(`  关键词: ${KEYWORD}  轮次: ${ROUNDS}`);
  console.log("  策略: 单一长期实例，连续搜，不重启");
  console.log("========================================\n");

  // 开一次会话，全程复用同一个实例（符合"养号"思路）
  const session = await openAiSessionWithAccount(ctx, db, "jd");
  const page = session.page;
  console.log(`[诊断] 会话已建立: ${session.account.displayName}\n`);

  const results = [];

  for (let i = 1; i <= ROUNDS; i++) {
    const startedAt = Date.now();
    let ok = false;
    let errMsg = "";
    let snap = null;

    try {
      await aiJdSearch(page, KEYWORD);
      snap = await snapshot(page);
      ok = snap.onSearchPage && snap.productCount > 0;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
      try {
        snap = await snapshot(page);
      } catch {
        snap = null;
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    // 失败就截图存证
    let shotPath = "";
    if (!ok) {
      shotPath = join(SHOT_DIR, `round-${i}-fail.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {
        shotPath = "(截图失败)";
      });
    }

    const tag = ok ? "✅成功" : "❌失败";
    let reason = "";
    if (!ok && snap) {
      if (snap.riskHit) reason = "命中风控关键词(验证码/滑块等)";
      else if (snap.bouncedHome) reason = "被弹回首页";
      else if (!snap.onSearchPage) reason = `停在非搜索页: ${snap.url}`;
      else if (snap.productCount === 0) reason = "在搜索页但0商品";
    }
    if (!ok && errMsg) reason = reason ? `${reason} | 异常:${errMsg}` : `异常:${errMsg}`;

    console.log(
      `[第${i}/${ROUNDS}轮] ${tag} | ${elapsed}s | 商品${snap?.productCount ?? "?"}个` +
        (reason ? `\n          原因: ${reason}` : "") +
        (shotPath ? `\n          截图: ${shotPath}` : "")
    );

    results.push({ round: i, ok, elapsed: Number(elapsed), reason, url: snap?.url });

    // 轮次间短暂停顿，像人翻看一会儿再搜下一次
    await page.waitForTimeout(2000);
  }

  // 汇总
  const success = results.filter((r) => r.ok).length;
  const rate = ((success / ROUNDS) * 100).toFixed(0);
  const avgTime = (results.reduce((s, r) => s + r.elapsed, 0) / ROUNDS).toFixed(1);

  console.log("\n========================================");
  console.log(`  成功率: ${success}/${ROUNDS} (${rate}%)`);
  console.log(`  平均耗时: ${avgTime}s/次`);

  // 失败模式归类
  const failReasons = {};
  for (const r of results.filter((x) => !x.ok)) {
    const key = r.reason || "未知";
    failReasons[key] = (failReasons[key] || 0) + 1;
  }
  if (Object.keys(failReasons).length > 0) {
    console.log("  失败模式分布:");
    for (const [k, v] of Object.entries(failReasons)) {
      console.log(`    - ${k}: ${v}次`);
    }
  }

  // 关键判断：第1轮 vs 后续，看是不是"越搜越脏"
  const firstOk = results[0]?.ok;
  const laterOk = results.slice(1).filter((r) => r.ok).length;
  const laterTotal = ROUNDS - 1;
  console.log("\n  会话衰减分析:");
  console.log(`    第1轮(最干净): ${firstOk ? "成功" : "失败"}`);
  console.log(`    后续${laterTotal}轮: ${laterOk}/${laterTotal} 成功`);
  if (firstOk && laterTotal > 0 && laterOk / laterTotal < 0.6) {
    console.log("    >> 结论倾向: 会话越用越脏(状态残留)");
  } else if (success / ROUNDS >= 0.9) {
    console.log("    >> 结论倾向: 长期实例其实很稳，之前问题可能在别处");
  } else if (!firstOk) {
    console.log("    >> 结论倾向: 第1轮就挂，是真实风控或代码问题，不是衰减");
  }
  console.log("========================================");

  console.log("\n[诊断] 保持浏览器不关，方便你肉眼看最后状态。");
  console.log("[诊断] 看完按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[诊断] 脚本异常:", e);
  process.exit(1);
});
