#!/usr/bin/env node
// Agent 驱动用的单步调用入口：把一个 action(JSON) 交给 tools/sourcing.js 的 execute 执行并打印结果。
// 用途：让 Agent 在循环里逐步驱动选品——先 jd_harvest 拿京东候选，Agent 亲自看标题生成淘宝关键词，
// 再 taobao_harvest（关键词由 Agent 传入，不再由脚本字符串切词），避免脚本近似导致的怪关键词。
// 用法：node scripts/run-action.mjs '{"action":"jd_harvest","brand":"FreeHalo","targetCount":3}'
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { execute } from "../tools/sourcing.js";

const dataDir = process.env.SOURCING_DATA_DIR || join(process.env.HOME || process.cwd(), ".ecommerce-sourcing-agent");
const ctx = { dataDir, config: { get: () => "" }, log: console };

const raw = process.argv[2];
if (!raw) {
  console.error("用法: node scripts/run-action.mjs '<action-json>'");
  process.exit(2);
}

let input;
try {
  input = JSON.parse(raw);
} catch (error) {
  console.error(`action JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const result = await execute(input, ctx);
console.log("\n===RESULT_JSON===");
console.log(JSON.stringify(result, null, 2));

// 把完整结果落盘，避免 stdout 截断丢失候选列表（少一次重复 harvest = 少一次风控）。
try {
  const outDir = join(dataDir, "action-runs");
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `${ts}_${input.action || "unknown"}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`===RESULT_FILE=== ${outPath}`);
} catch (error) {
  console.error(`结果落盘失败: ${error instanceof Error ? error.message : String(error)}`);
}

process.exit(result && result.ok === false ? 1 : 0);
