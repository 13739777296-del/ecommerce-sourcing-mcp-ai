import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { launchChrome, findChromeDebugPort, findChromePids, killPids } from "./platform/index.js";

const managedSessions = new Map();

export async function openChromeSession(profileDir, initialUrl = "about:blank", options = {}) {
  const sessionOptions = normalizeChromeSessionOptions(options);
  const existing = managedSessions.get(profileDir);
  if (!sessionOptions.forceFresh && await canUseManagedSession(existing)) {
    const page = await prepareControlledPage(existing.context, initialUrl, sessionOptions);
    existing.page = page;
    if (process.env.ECOMMERCE_SOURCING_BRING_TO_FRONT === "1") await page.bringToFront().catch(() => undefined);
    await page.waitForTimeout(900).catch(() => undefined);
    return createChromeSessionHandle(profileDir, existing, sessionOptions);
  }
  managedSessions.delete(profileDir);

  const existingPort = sessionOptions.forceFresh ? 0 : findChromeDebugPort(profileDir);
  if (existingPort) {
    // 端口已存在（账号 Chrome 正在跑）：重试连接，绝不因偶发超时就新开窗口（否则会狂开空白页）。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const handle = await connectChromeProfile(profileDir, existingPort, initialUrl, sessionOptions).catch((e) => {
        console.log(`[Chrome] 连接已有端口 ${existingPort} 第${attempt}次失败：${e instanceof Error ? e.message.slice(0, 60) : e}`);
        return null;
      });
      if (handle) return handle;
      await new Promise((r) => setTimeout(r, 1500));
    }
    // 端口存在但连不上：说明 Chrome 在跑只是暂时无响应，宁可报错也不新开窗口（避免空白页堆积+不触碰用户已登录实例）。
    throw new Error(`检测到账号 Chrome 在运行(端口${existingPort})但多次连接超时；未新开窗口以免堆积空白页，请稍后重试或检查该 Chrome 是否卡住。`);
  }

  const port = await findFreePort();
  if (sessionOptions.terminateConflictingProfile) {
    terminateChromeProfile(profileDir);
    await waitForChromeProfileExit(profileDir);
  }
  openSystemChrome(profileDir, port, "about:blank");
  await waitForCdp(port);
  return connectChromeProfile(profileDir, port, initialUrl, sessionOptions);
}

async function connectChromeProfile(profileDir, port, initialUrl, sessionOptions) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error("正式 Chrome 启动失败：未获取到浏览器上下文");
  }
  const state = { browser, context, page: null };
  const page = await prepareControlledPage(context, initialUrl, sessionOptions);
  state.page = page;
  if (sessionOptions.keepAlive) managedSessions.set(profileDir, state);
  if (process.env.ECOMMERCE_SOURCING_BRING_TO_FRONT === "1") await page.bringToFront().catch(() => undefined);
  await page.waitForTimeout(1200).catch(() => undefined);
  return createChromeSessionHandle(profileDir, state, sessionOptions);
}

export function openChromeLoginWindow(profileDir, targetUrl) {
  openSystemChrome(profileDir, null, targetUrl || "about:blank");
}

export function normalizeChromeSessionOptions(options = {}) {
  return {
    keepAlive: Boolean(options.keepAlive),
    forceFresh: Boolean(options.forceFresh),
    closeOtherPages: options.closeOtherPages !== false,
    newPage: Boolean(options.newPage),
    terminateConflictingProfile: options.terminateConflictingProfile === true
  };
}

export async function closeManagedChromeSessions(profileDir = "") {
  let closed = 0;
  const entries = [...managedSessions.entries()].filter(([key]) => !profileDir || key === profileDir);
  for (const [key, state] of entries) {
    managedSessions.delete(key);
    // 不杀浏览器进程，保持打开避免反复开闭触发风控
    closed += 1;
  }
  return closed;
}

function createChromeSessionHandle(profileDir, state, sessionOptions) {
  return {
    browser: state.browser,
    context: state.context,
    page: state.page,
    close: async () => {
      if (sessionOptions.keepAlive && await canUseManagedSession(state)) {
        managedSessions.set(profileDir, state);
        await state.page?.waitForTimeout?.(500).catch(() => undefined);
        return;
      }
      if (managedSessions.get(profileDir) === state) managedSessions.delete(profileDir);
      // 不杀浏览器进程，保持打开，避免正常任务反复开关账号窗口。
    }
  };
}

async function canUseManagedSession(session) {
  if (!session?.browser?.isConnected?.()) return false;
  const pages = session.context?.pages?.() || [];
  if (pages.length === 0) return false;
  return pages.some((page) => !page.isClosed());
}

async function prepareControlledPage(context, initialUrl, options = normalizeChromeSessionOptions()) {
  const page = options.newPage ? await pickTaskPage(context) : await pickInitialPage(context);
  if (options.closeOtherPages) await closeOtherPages(context, page);
  if (initialUrl !== "about:blank") {
    await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
  }
  return page;
}

async function pickTaskPage(context) {
  const blank = context.pages().find((page) => !page.isClosed() && page.url() === "about:blank");
  return blank || context.newPage();
}

async function pickInitialPage(context) {
  const deadline = Date.now() + 10000;
  let fallback = null;
  while (Date.now() < deadline) {
    const pages = context.pages();
    fallback = pages.at(-1) ?? fallback;
    const blank = pages.find((page) => page.url() === "about:blank");
    if (blank) return blank;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fallback ?? context.newPage();
}

async function closeOtherPages(context, keepPage) {
  for (const page of context.pages()) {
    if (page === keepPage || page.isClosed()) continue;
    await page.close().catch(() => undefined);
  }
}

function terminateChromeProfile(profileDir) {
  killPids(findChromePids(profileDir), "TERM");
}

async function waitForChromeProfileExit(profileDir) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (findChromePids(profileDir).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  killPids(findChromePids(profileDir), "KILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function openSystemChrome(profileDir, port, targetUrl) {
  mkdirSync(profileDir, { recursive: true });
  launchChrome(profileDir, port, targetUrl);
}


async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配浏览器调试端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForCdp(port) {
  const deadline = Date.now() + 20000;
  let lastMessage = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastMessage = `浏览器调试端口返回 ${response.status}`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`正式 Chrome 连接超时：${lastMessage}`);
}
