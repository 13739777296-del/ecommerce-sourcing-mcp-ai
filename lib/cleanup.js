// 本地数据按时间清理：选品数据目录会不断堆积截图/调试输出，不清会撑爆磁盘。
// 安全策略（白名单）：只清下面这几个"衍生/可重建"子目录里超过 N 天的文件。
// 绝不遍历 profiles/（浏览器登录态）和 *.sqlite（选品数据库）——这俩是禁删红线，
// 不在白名单里就永远不会被碰到。
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

// 只清这些子目录（相对 dataDir）。登录态、数据库、迁移文件都不在内，天然安全。
export const CLEANABLE_SUBDIRS = [
  "action-runs",
  "ai-browser-screenshots",
  "shots",
  "review-tasks",
  "exports"
];

export const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * 递归删除目录下 mtime 超过 maxAgeMs 的文件（不删目录结构本身）。
 * @param {string} dir
 * @param {number} cutoffMs 早于此时间戳的文件删除
 * @returns {{ removed: number, bytes: number }}
 */
function cleanDirOlderThan(dir, cutoffMs) {
  let removed = 0;
  let bytes = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, bytes };
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = cleanDirOlderThan(full, cutoffMs);
        removed += sub.removed;
        bytes += sub.bytes;
      } else {
        const st = statSync(full);
        if (st.mtimeMs < cutoffMs) {
          bytes += st.size;
          rmSync(full, { force: true });
          removed += 1;
        }
      }
    } catch {
      // 单个文件失败不影响整体清理
    }
  }
  return { removed, bytes };
}

/**
 * 清理数据目录下超过 maxAgeDays 天的衍生文件。
 * @param {string} dataDir 选品数据根目录
 * @param {{ maxAgeDays?: number }} [options]
 * @returns {{ maxAgeDays: number, removedFiles: number, freedBytes: number, perDir: Record<string, {removed:number,bytes:number}> }}
 */
export function cleanupOldData(dataDir, options = {}) {
  const maxAgeDays = Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) : DEFAULT_MAX_AGE_DAYS;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const perDir = {};
  let removedFiles = 0;
  let freedBytes = 0;
  for (const sub of CLEANABLE_SUBDIRS) {
    const dir = join(dataDir, sub);
    if (!existsSync(dir)) {
      perDir[sub] = { removed: 0, bytes: 0 };
      continue;
    }
    const res = cleanDirOlderThan(dir, cutoffMs);
    perDir[sub] = res;
    removedFiles += res.removed;
    freedBytes += res.bytes;
  }
  return { maxAgeDays, removedFiles, freedBytes, perDir };
}

/** 把字节数格式化成人类可读（用于日志/返回信息）。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
