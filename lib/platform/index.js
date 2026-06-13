// 平台适配层入口：按 process.platform 选择具体实现，对外暴露统一接口。
// chrome.js 只调用这里，不再直接碰 /Applications、/bin/ps、taskkill 等平台细节。
//
// 统一接口（mac.js / windows.js 都实现）：
//   findChromeExecutable(): string | null
//   launchChrome(profileDir, port|null, targetUrl): void
//   findChromeDebugPort(profileDir): number   // 0 表示没找到
//   findChromePids(profileDir): number[]
//   killPids(pids, "TERM"|"KILL"): void
//
// Linux 暂未实现：worker 目标平台是 Mac 和 Windows。Linux 上会明确报错而非静默出错。
import * as mac from "./mac.js";
import * as windows from "./windows.js";

function selectAdapter() {
  if (process.platform === "darwin") return mac;
  if (process.platform === "win32") return windows;
  return null;
}

const adapter = selectAdapter();

function ensureAdapter() {
  if (!adapter) {
    throw new Error(
      `当前操作系统（${process.platform}）暂不支持。本工具的浏览器自动化目前支持 macOS 与 Windows。`
    );
  }
  return adapter;
}

export function isPlatformSupported() {
  return adapter !== null;
}

export function findChromeExecutable() {
  return ensureAdapter().findChromeExecutable();
}

export function launchChrome(profileDir, port, targetUrl) {
  return ensureAdapter().launchChrome(profileDir, port, targetUrl);
}

export function findChromeDebugPort(profileDir) {
  return ensureAdapter().findChromeDebugPort(profileDir);
}

export function findChromePids(profileDir) {
  return ensureAdapter().findChromePids(profileDir);
}

export function killPids(pids, signal) {
  return ensureAdapter().killPids(pids, signal);
}
