// macOS 平台适配：找/开/查/关正式 Google Chrome。
// 这些逻辑从早期 chrome.js 原样迁出，保证 Mac 行为不变（真实已登录 Chrome + CDP 连接防风控）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CHROME_APP_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_APP_MARKER = "/Applications/Google Chrome.app/";

/** 找正式 Chrome 可执行文件，找不到返回 null（调用方据此提示用户安装）。 */
export function findChromeExecutable() {
  return existsSync(CHROME_APP_PATH) ? CHROME_APP_PATH : null;
}

/**
 * 启动正式 Chrome（带调试端口和独立 profile）。
 * @param {string} profileDir user-data-dir
 * @param {number|null} port 调试端口，null 表示不开调试端口（仅登录窗口）
 * @param {string} targetUrl 初始页
 */
export function launchChrome(profileDir, port, targetUrl) {
  const args = chromeArgs(profileDir, port, targetUrl);
  const executable = findChromeExecutable();
  const child = executable
    ? spawn(executable, args, { detached: true, stdio: "ignore" })
    : spawn("open", ["-na", "Google Chrome", "--args", ...args], { detached: true, stdio: "ignore" });
  child.unref();
}

/** 查某 profile 正在运行的 Chrome 的调试端口；没有返回 0。 */
export function findChromeDebugPort(profileDir) {
  try {
    const output = execFileSync("/bin/ps", ["axo", "command="], { encoding: "utf8" });
    const line = output
      .split("\n")
      .find((item) =>
        item.includes(CHROME_APP_MARKER) &&
        item.includes(`--user-data-dir=${profileDir}`) &&
        item.includes("--remote-debugging-port=")
      );
    const port = Number(line?.match(/--remote-debugging-port=(\d+)/)?.[1] || 0);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

/** 查某 profile 的 Chrome 进程 PID 列表。 */
export function findChromePids(profileDir) {
  try {
    const output = execFileSync("/bin/ps", ["axo", "pid=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(CHROME_APP_MARKER) && line.includes(`--user-data-dir=${profileDir}`))
      .map((line) => Number(line.match(/^(\d+)/)?.[1]))
      .filter((pid) => Number.isInteger(pid));
  } catch {
    return [];
  }
}

/** 给一批 PID 发信号（"TERM" 优雅退出 / "KILL" 强杀）。 */
export function killPids(pids, signal) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (uniquePids.length === 0) return;
  try {
    execFileSync("/bin/kill", [`-${signal}`, ...uniquePids.map((pid) => String(pid))], { stdio: "ignore" });
  } catch {
    // Best effort only.
  }
}

function chromeArgs(profileDir, port, targetUrl) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--new-window",
    targetUrl
  ];
  if (port !== null && port !== undefined) args.unshift(`--remote-debugging-port=${port}`);
  return args;
}
