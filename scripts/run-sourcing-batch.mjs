#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execute } from "../tools/sourcing.js";
import { openSourcingDb } from "../lib/db.js";
import { DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";
import {
  buildTaobaoSearchKeywords,
  resolveBrandForTaobao
} from "../lib/logic.js";
import { buildJdProductFingerprint } from "../lib/sourcing-dedupe.js";

const args = parseArgs(process.argv.slice(2));
const dataDir = args.dataDir || join(process.env.HOME || process.cwd(), ".ecommerce-sourcing-agent");
const brandQueuePath = args.brands || join(dataDir, "brand-queue.json");
const statePath = args.state || join(dataDir, "batch-sourcing-state.json");
const reviewOutputDir = args.reviewDir || join(dataDir, "review-tasks");
const target = numberArg(args.target, 100);
const brandLimit = numberArg(args.brandLimit, 0);
const jdTargetPerBrand = numberArg(args.jdTargetPerBrand, 3);
const maxPagesPerShop = numberArg(args.maxPagesPerShop, 1);
const maxShopsPerBrand = numberArg(args.maxShopsPerBrand, 8);
const maxDetailPerShop = numberArg(args.maxDetailPerShop, 12);
const maxConsecutiveCommentRejectsPerShop = numberArg(args.maxConsecutiveCommentRejectsPerShop, 8);
const taobaoMaxCount = numberArg(args.taobaoMaxCount, 30);
const taobaoMaxDetail = numberArg(args.taobaoMaxDetail, 8);
const maxKeywordsPerJd = numberArg(args.maxKeywordsPerJd, 2);
const maxPendingReviews = numberArg(args.maxPendingReviews, 30);
const strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];
const ctx = { dataDir, config: { get: () => "" }, log: console };
const sleepMs = numberArg(args.sleepMs, 1500);

mkdirSync(dataDir, { recursive: true });
mkdirSync(reviewOutputDir, { recursive: true });

const brandQueue = loadBrandQueue(brandQueuePath);
const state = loadState(statePath);

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\n[batch] 收到中断信号，当前步骤结束后保存状态退出。");
});

console.log(`[batch] dataDir=${dataDir}`);
console.log(`[batch] reviewTasks=${reviewOutputDir}`);
console.log(`[batch] brands=${brandQueue.length}, target=${target}, maxPendingReviews=${maxPendingReviews}, jdTargetPerBrand=${jdTargetPerBrand}, maxPagesPerShop=${maxPagesPerShop}, maxShopsPerBrand=${maxShopsPerBrand}, maxDetailPerShop=${maxDetailPerShop}`);

const initialCount = qualifiedCount();
console.log(`[batch] 当前已达标可用品: ${initialCount}，待AI审核任务: ${pendingReviewCount(state)}`);
for (const fingerprint of qualifiedFingerprints()) {
  state.completedProductFingerprints.push(fingerprint);
}
saveState(statePath, state);

let currentCount = initialCount;
let scannedBrands = 0;

for (const brand of brandQueue) {
  if (stopping) break;
  if (currentCount >= target) break;
  if (pendingReviewCount(state) >= maxPendingReviews) {
    console.log(`[batch] 待AI审核任务已达 ${pendingReviewCount(state)}/${maxPendingReviews}，暂停采集。请Agent先审核任务包并调用save_sourcing。`);
    break;
  }
  if (brandLimit > 0 && scannedBrands >= brandLimit) break;
  if (state.completedBrands.includes(brand)) continue;

  scannedBrands += 1;
  state.currentBrand = brand;
  saveState(statePath, state);

  console.log(`\n[batch] 品牌 ${scannedBrands}/${brandQueue.length}: ${brand}`);
  const beforeCount = currentCount;

  const jdResult = await execute({
    action: "jd_harvest",
    brand,
    allowedBrands: brandQueue,
    targetCount: jdTargetPerBrand,
    maxPagesPerShop,
    maxShopsPerBrand,
    maxDetailPerShop,
    maxConsecutiveCommentRejectsPerShop
  }, ctx);

  state.runs.push({
    time: new Date().toISOString(),
    action: "jd_harvest",
    brand,
    ok: Boolean(jdResult.ok),
    candidateCount: jdResult.candidateCount || 0,
    rejectedCount: jdResult.rejectedCount || 0,
    message: jdResult.message || jdResult.error || ""
  });
  saveState(statePath, state);

  if (!jdResult.ok) {
    console.log(`[batch] JD 失败: ${jdResult.message || jdResult.error}`);
    if (shouldStopForRisk(jdResult)) {
      console.log("[batch] 检测到需要人工处理的风险/登录问题，停止批量。");
      break;
    }
    state.completedBrands.push(brand);
    saveState(statePath, state);
    await sleep(sleepMs);
    continue;
  }

  for (const jd of jdResult.candidates || []) {
    if (stopping || currentCount >= target) break;
    if (pendingReviewCount(state) >= maxPendingReviews) {
      console.log(`[batch] 待AI审核任务已达 ${pendingReviewCount(state)}/${maxPendingReviews}，暂停当前品牌后续淘宝采集。`);
      stopping = true;
      break;
    }
    if (!jd?.productId) continue;
    const productFingerprint = buildJdProductFingerprint(jd);
    if (state.completedJdProductIds.includes(jd.productId)) continue;
    if (state.completedProductFingerprints.includes(productFingerprint)) {
      console.log(`[batch] 跳过重复商品: ${jd.productId} ${short(jd.title, 32)}`);
      state.completedJdProductIds.push(jd.productId);
      saveState(statePath, state);
      continue;
    }

    console.log(`[batch] JD候选: ${jd.productId} ${short(jd.title, 42)}`);
    const brandName = resolveBrandForTaobao(jd, brand);
    const keywords = buildTaobaoSearchKeywords({ brand: brandName, title: jd.title }).slice(0, maxKeywordsPerJd);
    let reviewTaskGenerated = false;

    for (const keyword of keywords) {
      if (stopping || reviewTaskGenerated) break;
      console.log(`[batch] 淘宝关键词: ${keyword}`);
      const tbResult = await execute({
        action: "taobao_harvest",
        keyword,
        maxCount: taobaoMaxCount,
        maxDetail: taobaoMaxDetail
      }, ctx);

      state.runs.push({
        time: new Date().toISOString(),
        action: "taobao_harvest",
        brand,
        jdProductId: jd.productId,
        keyword,
        ok: Boolean(tbResult.ok),
        candidateCount: tbResult.candidateCount || 0,
        rejectedCount: tbResult.rejectedCount || 0,
        message: tbResult.message || tbResult.error || ""
      });
      saveState(statePath, state);

      if (!tbResult.ok) {
        console.log(`[batch] 淘宝失败: ${tbResult.message || tbResult.error}`);
        if (shouldStopForRisk(tbResult)) {
          stopping = true;
          break;
        }
        await sleep(sleepMs);
        continue;
      }

      const reviewTaskResult = await execute({
        action: "ai_review_task",
        strategyId: "no-source-arbitrage",
        jdProduct: jd,
        taobaoCandidates: tbResult.candidates || [],
        keyword
      }, ctx);
      const reviewPath = writeReviewTask(brand, jd, keyword, reviewTaskResult);
      console.log(`[batch] 已生成AI审核任务包: ${reviewPath}`);
      addBatchLog("info", `batch ai_review_task：brand=${brand} jd=${jd.productId} keyword=${keyword} 候选${tbResult.candidates?.length || 0} 文件=${reviewPath}`);
      state.runs.push({
        time: new Date().toISOString(),
        action: "ai_review_task",
        brand,
        jdProductId: jd.productId,
        keyword,
        ok: Boolean(reviewTaskResult.ok),
        candidateCount: tbResult.candidates?.length || 0,
        reviewPath,
        message: reviewTaskResult.message || reviewTaskResult.error || ""
      });
      saveState(statePath, state);
      state.completedJdProductIds.push(jd.productId);
      state.pendingReviewJdProductIds.push(jd.productId);
      reviewTaskGenerated = true;
      saveState(statePath, state);
      currentCount = qualifiedCount();

      await sleep(sleepMs);
    }

    if (!reviewTaskGenerated) {
      state.completedJdProductIds.push(jd.productId);
      saveState(statePath, state);
    }
  }

  currentCount = qualifiedCount();
  if (currentCount === beforeCount) {
    console.log(`[batch] 品牌 ${brand} 本轮无新增已达标可用品。待AI审核任务: ${pendingReviewCount(state)}`);
  }
  state.completedBrands.push(brand);
  state.currentBrand = "";
  saveState(statePath, state);
  await sleep(sleepMs);
}

const finalCount = qualifiedCount();
const finalPendingReviewCount = pendingReviewCount(state);
console.log(`\n[batch] 结束。达标可用品 ${finalCount}，待AI审核任务 ${finalPendingReviewCount}，目标 ${target}`);
const csv = await execute({ action: "export_results" }, ctx);
console.log(`[batch] CSV: ${csv.outputPath || csv.message}`);
if (finalCount >= target || args.exportFeishu === "true") {
  const feishu = await execute({ action: "export_feishu" }, ctx);
  console.log(`[batch] 飞书: ${JSON.stringify({ ok: feishu.ok, count: feishu.count, url: feishu.url, message: feishu.message }, null, 2)}`);
}
process.exit(stopping ? 130 : 0);

function qualifiedCount() {
  return qualifiedRows().length;
}

function qualifiedFingerprints() {
  return qualifiedRows().map((row) => buildJdProductFingerprint(row));
}

function pendingReviewCount(state) {
  return new Set(state.pendingReviewJdProductIds || []).size;
}

function qualifiedRows() {
  const db = openSourcingDb({ dataDir });
  try {
    return db.listDedupedQualifiedResults(strategy.profit);
  } finally {
    db.close();
  }
}

function addBatchLog(level, message) {
  const db = openSourcingDb({ dataDir });
  try {
    db.addLog(null, level, message);
  } catch {
    // 日志失败不能影响批量任务续跑。
  } finally {
    db.close();
  }
}

function loadBrandQueue(file) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(payload)) return payload.map(String).filter(Boolean);
  if (Array.isArray(payload.brands)) return payload.brands.map(String).filter(Boolean);
  throw new Error(`品牌队列格式不正确: ${file}`);
}

function loadState(file) {
  if (!existsSync(file)) {
    return { version: 2, completedBrands: [], completedJdProductIds: [], completedProductFingerprints: [], pendingReviewJdProductIds: [], currentBrand: "", runs: [] };
  }
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.completedBrands ||= [];
  state.completedJdProductIds ||= [];
  state.completedProductFingerprints ||= [];
  state.pendingReviewJdProductIds ||= [];
  state.currentBrand ||= "";
  state.runs ||= [];
  return state;
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const trimmed = {
    ...state,
    completedBrands: [...new Set(state.completedBrands)],
    completedJdProductIds: [...new Set(state.completedJdProductIds)],
    completedProductFingerprints: [...new Set(state.completedProductFingerprints || [])],
    pendingReviewJdProductIds: [...new Set(state.pendingReviewJdProductIds || [])],
    runs: state.runs.slice(-500)
  };
  writeFileSync(file, JSON.stringify(trimmed, null, 2), "utf8");
}

function writeReviewTask(brand, jd, keyword, result) {
  const id = sanitizeFilePart(jd?.productId || jd?.title || Date.now());
  const file = join(reviewOutputDir, `${Date.now()}_${sanitizeFilePart(brand)}_${id}.json`);
  writeFileSync(file, JSON.stringify({
    createdAt: new Date().toISOString(),
    brand,
    keyword,
    ok: Boolean(result.ok),
    message: result.message || result.error || "",
    task: result.task || null
  }, null, 2), "utf8");
  return file;
}

function sanitizeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .slice(0, 80);
}

function shouldStopForRisk(result) {
  const text = `${result.message || ""} ${result.error || ""}`;
  return Boolean(result.risk || result.needLogin || /验证码|安全验证|访问频繁|风控|未登录|登录/.test(text));
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

function numberArg(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(text, length) {
  const value = String(text || "");
  return value.length > length ? `${value.slice(0, length)}...` : value;
}
