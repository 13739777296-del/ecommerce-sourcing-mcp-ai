// Windows 平台适配：找/开/查/关正式 Google Chrome。
// 已按 Windows 机制写出初版实现，但【尚未在真实 Windows 上验证】，待用户用 Win 机器实测后再调。
// 与 mac.js 暴露完全相同的接口，chrome.js 主流程无需区分平台。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Chrome 在 Windows 上的常见安装位置（按优先级）。
function candidateChromePaths() {
  const paths = [];
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] || "";
  paths.push(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
  paths.push(join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
  if (localAppData) paths.push(join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
  return paths;
}

/** 找正式 Chrome 可执行文件：先查注册表 App Paths，再查常见安装目录；找不到返回 null。 */
export function findChromeExecutable() {
  // 1) 注册表 App Paths（最权威）
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe", "/ve"],
      { encoding: "utf8" }
    );
    const match = out.match(/REG_SZ\s+(.+chrome\.exe)/i);
    const path = match?.[1]?.trim();
    if (path && existsSync(path)) return path;
  } catch {
    // 注册表查不到就走默认路径
  }
  // 2) 常见安装目录
  for (const candidate of candidateChromePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 启动正式 Chrome（带调试端口和独立 profile）。
 * @param {string} profileDir user-data-dir
 * @param {number|null} port 调试端口
 * @param {string} targetUrl 初始页
 */
export function launchChrome(profileDir, port, targetUrl) {
  const executable = findChromeExecutable();
  if (!executable) {
    throw new Error("没有找到 Google Chrome。请先安装正式版 Chrome：https://www.google.cn/chrome/");
  }
  const args = chromeArgs(profileDir, port, targetUrl);
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  child.unref();
}

/**
 * 查某 profile 正在运行的 Chrome 的调试端口；没有返回 0。
 * 用 PowerShell 读 chrome.exe 进程的完整命令行（CommandLine），匹配 user-data-dir 和端口。
 */
export function findChromeDebugPort(profileDir) {
  for (const cmdLine of chromeCommandLines()) {
    if (!cmdLine.includes(`--user-data-dir=${profileDir}`)) continue;
    const port = Number(cmdLine.match(/--remote-debugging-port=(\d+)/)?.[1] || 0);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return 0;
}

/** 查某 profile 的 Chrome 进程 PID 列表。 */
export function findChromePids(profileDir) {
  const pids = [];
  for (const { pid, cmdLine } of chromeProcesses()) {
    if (cmdLine.includes(`--user-data-dir=${profileDir}`)) pids.push(pid);
  }
  return pids;
}

/**
 * 关进程。Windows 没有信号概念：
 * - "TERM" → taskkill 普通结束
 * - "KILL" → taskkill /F 强制结束
 */
export function killPids(pids, signal) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (uniquePids.length === 0) return;
  const pidArgs = uniquePids.flatMap((pid) => ["/PID", String(pid)]);
  try {
    execFileSync("taskkill", signal === "KILL" ? [...pidArgs, "/F", "/T"] : [...pidArgs, "/T"], { stdio: "ignore" });
  } catch {
    // Best effort only.
  }
}

// === Windows 进程查询辅助：用 PowerShell 拿 chrome.exe 的 PID + CommandLine ===

function chromeProcesses() {
  try {
    // 输出每行: <pid>\t<commandline>
    const script =
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | " +
      "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" }
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        if (tab < 0) return null;
        const pid = Number(line.slice(0, tab));
        const cmdLine = line.slice(tab + 1);
        return Number.isInteger(pid) ? { pid, cmdLine } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function chromeCommandLines() {
  return chromeProcesses().map((item) => item.cmdLine);
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
