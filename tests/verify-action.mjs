#!/usr/bin/env node

/**
 * 京东搜索 - 单动作逐个验证
 *
 * 思路（用户定的）：一个动作跑10遍都OK，才做下一个动作。
 * 全程复用同一个长期浏览器实例（养号思路），不重启。
 *
 * 用法：
 *   node tests/verify-action.mjs home      # 动作1：打开首页 x10
 *   node tests/verify-action.mjs clickbox  # 动作2：定位+点击搜索框 x10
 *   node tests/verify-action.mjs type      # 动作3：输入关键词 x10
 *   node tests/verify-action.mjs submit    # 动作4：提交→结果页 x10
 *   node tests/verify-action.mjs all       # 串起来完整搜索 x10
 *
 * 第二个参数可指定轮数，默认10。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSession } from "../lib/ai-controller.js";

// 显式指定京东账号二（登录态完好），绕开会被 profileSummary 覆盖的自动挑选
const JD2_PROFILE = join(
  homedir(),
  "Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597"
);

const ACTION = process.argv[2] || "home";
const ROUNDS = Number(process.argv[3] || 10);
const KEYWORD = process.argv[4] || "蛋白粉";
const SHOT_DIR = join(process.cwd(), "tests", "verify-shots");

const HOME_URL = "https://www.jd.com";
const SEARCH_INPUT = "input.jd_pc_search_bar_react_search_input";
const SEARCH_BTN = "button.jd_pc_search_bar_react_search_btn";
const RISK_RE = /验证码|滑块|安全验证|访问频繁|账号异常|环境异常|拦截/;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanMoveTo(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randInt(8, 15) });
    await page.waitForTimeout(randInt(200, 500));
  }
}

async function humanType(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: randInt(60, 160) });
  }
}

async function checkRisk(page) {
  const txt = await page.locator("body").innerText({ timeout: 4000 }).catch(() => "");
  return RISK_RE.test(txt);
}

// ---------- 各动作 ----------

async function actHome(page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(randInt(1500, 2500));
  if (await checkRisk(page)) return { ok: false, reason: "命中风控" };
  // 首页标志：搜索框存在
  const hasBox = await page.locator(SEARCH_INPUT).first().isVisible({ timeout: 5000 }).catch(() => false);
  return hasBox ? { ok: true } : { ok: false, reason: "首页无搜索框" };
}

async function actClickBox(page) {
  // 前提：在首页
  if (!page.url().includes("jd.com")) await actHome(page);
  const box = page.locator(SEARCH_INPUT).first();
  const visible = await box.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) return { ok: false, reason: "搜索框不可见" };
  await humanMoveTo(page, box);
  await box.click({ timeout: 5000 });
  await page.waitForTimeout(randInt(300, 700));
  // 确认聚焦了
  const focused = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el === document.activeElement;
  }, SEARCH_INPUT);
  return focused ? { ok: true } : { ok: false, reason: "点击后未聚焦" };
}

async function actType(page) {
  const r = await actClickBox(page);
  if (!r.ok) return r;
  const box = page.locator(SEARCH_INPUT).first();
  await box.fill("");
  await page.waitForTimeout(randInt(200, 400));
  await humanType(page, KEYWORD);
  await page.waitForTimeout(randInt(400, 800));
  const value = await box.inputValue().catch(() => "");
  return value === KEYWORD ? { ok: true } : { ok: false, reason: `输入值不符: "${value}"` };
}

async function actSubmit(page) {
  const r = await actType(page);
  if (!r.ok) return r;
  // 优先回车（真人最常用，比找按钮稳）
  await page.keyboard.press("Enter");
  await page.waitForTimeout(randInt(2500, 3500));
  // 等结果页商品
  await page.waitForSelector("div[data-sku]", { timeout: 15000 }).catch(() => {});
  const url = page.url();
  const count = await page.locator("div[data-sku]").count().catch(() => 0);
  if (await checkRisk(page)) return { ok: false, reason: "命中风控" };
  if (!url.includes("search.jd.com")) return { ok: false, reason: `未跳结果页: ${url}` };
  if (count === 0) return { ok: false, reason: "结果页0商品" };
  return { ok: true, extra: `${count}个商品` };
}

const ACTIONS = {
  home: { fn: actHome, desc: "打开首页", needHomeBetween: false },
  clickbox: { fn: actClickBox, desc: "定位+点击搜索框", needHomeBetween: true },
  type: { fn: actType, desc: "输入关键词", needHomeBetween: true },
  submit: { fn: actSubmit, desc: "提交→结果页", needHomeBetween: true },
  all: { fn: actSubmit, desc: "完整搜索(同submit)", needHomeBetween: true }
};

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const target = ACTIONS[ACTION];
  if (!target) {
    console.error(`未知动作: ${ACTION}。可选: ${Object.keys(ACTIONS).join(", ")}`);
    process.exit(1);
  }

  const ctx = createContext();
  const db = openSourcingDb(ctx);

  console.log("========================================");
  console.log(`  单动作验证: ${target.desc}`);
  console.log(`  轮数: ${ROUNDS}  关键词: ${KEYWORD}`);
  console.log(`  实例: 单一长期实例(不重启)`);
  console.log("========================================\n");

  const session = await openAiSession(JD2_PROFILE);
  const page = session.page;
  console.log(`[验证] 账号: 京东账号二(登录态完好)\n`);

  let success = 0;
  const fails = {};

  for (let i = 1; i <= ROUNDS; i++) {
    // 需要"从首页开始"的动作，每轮先回首页营造干净起点
    if (target.needHomeBetween) {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(randInt(1000, 2000));
    }

    const t0 = Date.now();
    let res;
    try {
      res = await target.fn(page);
    } catch (e) {
      res = { ok: false, reason: `异常:${e instanceof Error ? e.message : String(e)}` };
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    if (res.ok) {
      success++;
      console.log(`[${i}/${ROUNDS}] ✅ ${dt}s ${res.extra || ""}`);
    } else {
      fails[res.reason] = (fails[res.reason] || 0) + 1;
      const shot = join(SHOT_DIR, `${ACTION}-${i}-fail.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      console.log(`[${i}/${ROUNDS}] ❌ ${dt}s | ${res.reason}\n        截图: ${shot}`);
    }

    // 真人节奏：轮次之间停 5-15 秒，避免高频触发风控
    const gap = randInt(5000, 15000);
    if (i < ROUNDS) {
      console.log(`        (真人间隔 ${(gap / 1000).toFixed(0)}s)`);
      await page.waitForTimeout(gap);
    }
  }

  const rate = ((success / ROUNDS) * 100).toFixed(0);
  console.log("\n========================================");
  console.log(`  ${target.desc}: ${success}/${ROUNDS} (${rate}%)`);
  if (Object.keys(fails).length) {
    console.log("  失败分布:");
    for (const [k, v] of Object.entries(fails)) console.log(`    - ${k}: ${v}次`);
  }
  if (success === ROUNDS) {
    console.log("  >> 10/10 稳定，可以做下一个动作 ✅");
  } else {
    console.log("  >> 未达10/10，先解决这个动作再往下 ⚠️");
  }
  console.log("========================================");
  console.log("\n[验证] 浏览器保持打开，看完按 Ctrl+C。");
}

main().catch((e) => {
  console.error("[验证] 脚本异常:", e);
  process.exit(1);
});
