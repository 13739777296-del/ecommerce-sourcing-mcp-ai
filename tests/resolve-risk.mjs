#!/usr/bin/env node

/**
 * 解除当前账号的风控 + 验证风控守卫逻辑
 *
 * 打开指定账号首页，检测是否被风控。
 * 若被风控 → 提示你在 Chrome 窗口里手动点"快速验证"过掉 →
 * 脚本轮询检测，过掉后自动确认恢复正常。
 *
 * 用法: node tests/resolve-risk.mjs [jd2|jd1|tb]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openAiSession } from "../lib/ai-controller.js";
import { detectRiskControl, waitForManualResolve, captureRiskShot } from "../lib/risk-guard.js";

const PROFILES = {
  jd2: {
    name: "京东账号二",
    url: "https://www.jd.com",
    dir: "browser-profiles/accounts/jd/403478cb-a4e1-47e6-9e18-ed3fa1fb6597",
    ready: (page) => page.locator("input.jd_pc_search_bar_react_search_input").first().isVisible({ timeout: 5000 }).catch(() => false)
  },
  jd1: {
    name: "京东账号一",
    url: "https://www.jd.com",
    dir: "browser-profiles/accounts/jd/0b8e87b1-d8c1-4910-a176-e0aa474576f7",
    ready: (page) => page.locator("input.jd_pc_search_bar_react_search_input").first().isVisible({ timeout: 5000 }).catch(() => false)
  },
  tb: {
    name: "淘宝账号一",
    url: "https://www.taobao.com",
    dir: "browser-profiles/accounts/taobao/85196a47-9964-4811-bedd-5fc8f5a57f96",
    ready: (page) => page.locator("input#q, input[name='q']").first().isVisible({ timeout: 5000 }).catch(() => false)
  }
};

const which = process.argv[2] || "jd2";
const cfg = PROFILES[which];
if (!cfg) {
  console.error(`未知账号: ${which}，可选 jd2/jd1/tb`);
  process.exit(1);
}

const APP_ROOT = join(homedir(), "Library/Application Support/电商选品智能体");

async function main() {
  console.log(`\n=== 解除风控 / 检测账号: ${cfg.name} ===\n`);

  const session = await openAiSession(join(APP_ROOT, cfg.dir));
  const page = session.page;

  console.log(`[检测] 打开 ${cfg.url} ...`);
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  const risk = await detectRiskControl(page);
  const shot = await captureRiskShot(page, `${which}-check`);
  console.log(`[检测] 截图: ${shot}`);

  if (!risk.blocked) {
    // 再确认页面就绪
    const ready = await cfg.ready(page);
    if (ready) {
      console.log(`[检测] ✅ ${cfg.name} 正常，无风控，页面就绪。`);
      console.log("[检测] 这个账号现在可以用。浏览器保持打开，按 Ctrl+C 退出。");
      return;
    }
    console.log("[检测] ⚠️ 未检测到风控特征，但页面也未就绪，请看截图确认。");
  } else {
    console.log(`[检测] ⚠️ 检测到风控（信号: ${risk.signal}）`);
  }

  // 进入人工接管
  const r = await waitForManualResolve(page, {
    expectReady: cfg.ready,
    maxWaitMs: 5 * 60 * 1000
  });

  if (r.resolved) {
    console.log(`[检测] ✅ ${cfg.name} 风控已解除，现在可以正常用了。`);
  } else {
    console.log(`[检测] ❌ ${cfg.name} 风控未解除（超时）。`);
  }
  console.log("[检测] 浏览器保持打开，按 Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("[检测] 异常:", e);
  process.exit(1);
});
