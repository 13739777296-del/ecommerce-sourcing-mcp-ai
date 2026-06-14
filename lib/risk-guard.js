/**
 * 风控守卫
 *
 * 用户定的策略：
 * 1. 同一界面重试2次仍未达预期 → 截图 + 判断是否风控 → 通知用户手动处理
 * 2. 风控识别不能只靠"验证码"关键词，京东风控页是"验证一下，购物无忧/快速验证"
 *
 * 这里集中处理"页面是否被风控拦截"的判断和人工接管流程。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 风控页特征：文本关键词（京东风控页不含"验证码"三字，要按真实文案匹配）
const RISK_TEXT_PATTERNS = [
  "快速验证",
  "验证一下",
  "购物无忧",
  "验证后继续",
  "安全验证",
  "滑块",
  "拖动滑块",
  "完成验证",
  "访问频繁",
  "环境异常",
  "账号异常"
];

// 登录失效特征：页面弹出登录框/跳登录页（淘宝"请重新登录"、密码登录框等）。
// 这类不是验证码风控，但同样意味着当前账号不能用了，必须当成失效信号 → 触发换号。
const LOGIN_LOST_TEXT_PATTERNS = ["请重新登录", "亲，请登录", "扫码登录", "密码登录", "短信登录", "免费注册"];
const LOGIN_LOST_URL_PATTERNS = ["login.taobao.com", "login.tmall.com", "passport.jd.com/new/login", "login.jd.com"];

// 风控页特征：URL 关键词
const RISK_URL_PATTERNS = ["verify", "risk", "risk_handler", "privatedomain/risk_handler", "captcha", "safe.jd.com", "passport.jd.com/risk"];

/**
 * 判断当前页面是否被风控拦截
 * @returns {Promise<{blocked: boolean, signal: string}>}
 */
export async function detectRiskControl(page) {
  const url = page.url();
  for (const p of RISK_URL_PATTERNS) {
    if (url.includes(p)) return { blocked: true, signal: `URL含"${p}"` };
  }
  for (const p of LOGIN_LOST_URL_PATTERNS) {
    if (url.includes(p)) return { blocked: true, signal: `登录失效(URL含"${p}")` };
  }

  const bodyText = await page.locator("body").innerText({ timeout: 4000 }).catch(() => "");
  for (const p of RISK_TEXT_PATTERNS) {
    if (bodyText.includes(p)) return { blocked: true, signal: `页面含"${p}"` };
  }
  // 登录失效文本：需同时出现两个登录框特征词，避免普通页面里偶现"登录"二字误判。
  const loginHits = LOGIN_LOST_TEXT_PATTERNS.filter((p) => bodyText.includes(p));
  if (loginHits.length >= 2) {
    return { blocked: true, signal: `登录失效(页面含"${loginHits.slice(0, 2).join("/")}")` };
  }

  return { blocked: false, signal: "" };
}

/**
 * 等待用户手动处理风控（扫码/过验证），轮询直到页面恢复正常或超时
 * @param {object} page
 * @param {object} opts { onNotify, checkInterval, maxWaitMs, expectReady }
 *   - onNotify: 通知用户的回调（打印/发消息）
 *   - expectReady: async (page) => boolean，判断页面是否已恢复正常
 */
export async function waitForManualResolve(page, opts = {}) {
  const {
    onNotify = (msg) => console.log(msg),
    checkInterval = 3000,
    maxWaitMs = 5 * 60 * 1000,
    expectReady
  } = opts;

  onNotify("\n⚠️  ====== 检测到风控，需要你手动处理 ======");
  onNotify("⚠️  请在弹出的 Chrome 窗口里完成验证（点击/滑块/扫码）。");
  onNotify(`⚠️  处理完成后我会自动continue，最多等 ${Math.round(maxWaitMs / 60000)} 分钟。`);
  onNotify("⚠️  =========================================\n");

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(checkInterval);
    const risk = await detectRiskControl(page);
    if (!risk.blocked) {
      // 风控特征消失，再确认页面是否真的就绪
      if (!expectReady || (await expectReady(page).catch(() => false))) {
        onNotify("✅ 风控已解除，页面恢复正常，继续执行。\n");
        return { resolved: true };
      }
    }
  }
  onNotify("❌ 等待超时，风控仍未解除。\n");
  return { resolved: false };
}

/**
 * 截图存证
 */
export async function captureRiskShot(page, tag = "risk") {
  const dir = join(process.cwd(), "tests", "risk-shots");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${tag}-${Date.now()}.png`);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

/**
 * 带风控守卫的"达成预期"包装器
 *
 * 用户策略落地：执行 action，检查 expectReady；
 * 不达预期就刷新重试，最多 maxRetry 次；
 * 仍不行 → 截图 + 判断风控 → 风控则通知用户手动处理，处理后重试。
 *
 * @param {object} page
 * @param {object} opts
 *   - action: async (page) => void     要执行的动作（如打开首页/搜索）
 *   - expectReady: async (page) => boolean  判断是否达成预期
 *   - maxRetry: 默认2（用户要求"刷新两次"）
 *   - refresh: async (page) => void     重试前的恢复动作
 *       默认用"回退"(goBack)而非刷新(reload)——更像真人、更不易触发风控。
 *       回退失败再退而求其次重新导航到当前URL。
 *   - onNotify
 * @returns {Promise<{ok: boolean, manualResolved?: boolean, shot?: string}>}
 */
export async function runWithRiskGuard(page, opts = {}) {
  const {
    action,
    expectReady,
    maxRetry = 2,
    refresh = async (p) => {
      // 优先回退（稳，像真人按浏览器后退键）
      const before = p.url();
      await p.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(800);
      // 回退没生效（URL没变或仍异常）才重新导航，绝不用 reload
      if (p.url() === before) {
        await p.goto(before, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      }
    },
    onNotify = (msg) => console.log(msg)
  } = opts;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (attempt > 0) {
      onNotify(`[守卫] 未达预期，第 ${attempt}/${maxRetry} 次回退重试...`);
      await refresh(page).catch(() => {});
      await page.waitForTimeout(1500);
    }

    await action(page).catch(() => {});
    const ready = await expectReady(page).catch(() => false);
    if (ready) return { ok: true };
  }

  // 回退 maxRetry 次仍不行 → 截图审核
  const shot = await captureRiskShot(page, "guard");
  const risk = await detectRiskControl(page);
  onNotify(`[守卫] 回退${maxRetry}次仍未达预期，已截图: ${shot}`);

  if (risk.blocked) {
    onNotify(`[守卫] 判定为风控拦截（信号: ${risk.signal}）。`);
    const r = await waitForManualResolve(page, { onNotify, expectReady });
    if (r.resolved) {
      // 用户处理后，再执行一次 action
      await action(page).catch(() => {});
      const ready = await expectReady(page).catch(() => false);
      return { ok: ready, manualResolved: true, shot };
    }
    return { ok: false, manualResolved: false, shot };
  }

  onNotify("[守卫] 非风控特征，可能是页面结构变化或网络问题，需人工查看截图。");
  return { ok: false, shot };
}
