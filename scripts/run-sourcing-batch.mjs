#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execute } from "../tools/sourcing.js";
import { openSourcingDb } from "../lib/db.js";
import { DEFAULT_STRATEGIES, evaluateWithStrategy } from "../lib/strategy-engine.js";
import {
  assessSameProductMatch,
  buildTaobaoSearchKeywords,
  extractBrand
} from "../lib/logic.js";
import { compareUnitPrice } from "../lib/unit-price.js";
import { buildJdProductFingerprint } from "../lib/sourcing-dedupe.js";

const args = parseArgs(process.argv.slice(2));
const dataDir = args.dataDir || join(process.env.HOME || process.cwd(), ".ecommerce-sourcing-agent");
const brandQueuePath = args.brands || join(dataDir, "brand-queue.json");
const statePath = args.state || join(dataDir, "batch-sourcing-state.json");
const target = numberArg(args.target, 100);
const brandLimit = numberArg(args.brandLimit, 0);
const jdTargetPerBrand = numberArg(args.jdTargetPerBrand, 3);
const maxPagesPerShop = numberArg(args.maxPagesPerShop, 1);
const taobaoMaxCount = numberArg(args.taobaoMaxCount, 30);
const taobaoMaxDetail = numberArg(args.taobaoMaxDetail, 8);
const maxKeywordsPerJd = numberArg(args.maxKeywordsPerJd, 2);
const strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];
const ctx = { dataDir, config: { get: () => "" }, log: console };
const sleepMs = numberArg(args.sleepMs, 1500);

mkdirSync(dataDir, { recursive: true });

const brandQueue = loadBrandQueue(brandQueuePath);
const state = loadState(statePath);

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\n[batch] 收到中断信号，当前步骤结束后保存状态退出。");
});

console.log(`[batch] dataDir=${dataDir}`);
console.log(`[batch] brands=${brandQueue.length}, target=${target}, jdTargetPerBrand=${jdTargetPerBrand}, maxPagesPerShop=${maxPagesPerShop}`);

const initialCount = qualifiedCount();
console.log(`[batch] 当前已达标可用品: ${initialCount}`);
for (const fingerprint of qualifiedFingerprints()) {
  state.completedProductFingerprints.push(fingerprint);
}
saveState(statePath, state);

let currentCount = initialCount;
let scannedBrands = 0;

for (const brand of brandQueue) {
  if (stopping) break;
  if (currentCount >= target) break;
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
    targetCount: jdTargetPerBrand,
    maxPagesPerShop
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
    const brandName = jd.brand || extractBrand(jd.title) || brand;
    const keywords = buildTaobaoSearchKeywords({ brand: brandName, title: jd.title }).slice(0, maxKeywordsPerJd);
    let saved = false;

    for (const keyword of keywords) {
      if (stopping || saved) break;
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

      const matches = buildQualifiedMatches(jd, tbResult.candidates || [], keyword);
      if (!matches.length) {
        console.log("[batch] 无利润达标同款。");
        await sleep(sleepMs);
        continue;
      }

      const saveResult = await execute({
        action: "save_sourcing",
        strategyId: "no-source-arbitrage",
        jdProduct: normalizeJdForSave(jd),
        taobaoMatches: matches
      }, ctx);

      state.runs.push({
        time: new Date().toISOString(),
        action: "save_sourcing",
        brand,
        jdProductId: jd.productId,
        ok: Boolean(saveResult.ok),
        saved: saveResult.saved || 0,
        message: saveResult.message || saveResult.error || ""
      });
      saveState(statePath, state);

      if (saveResult.ok && (saveResult.saved || 0) > 0) {
        state.completedJdProductIds.push(jd.productId);
        state.completedProductFingerprints.push(productFingerprint);
        currentCount = qualifiedCount();
        console.log(`[batch] ✅ 入库达标: ${jd.productId}, 当前 ${currentCount}/${target}`);
        saved = true;
        saveState(statePath, state);
      } else {
        console.log(`[batch] save_sourcing 未保存: ${saveResult.message || saveResult.error}`);
      }

      await sleep(sleepMs);
    }

    if (!saved) {
      state.completedJdProductIds.push(jd.productId);
      saveState(statePath, state);
    }
  }

  currentCount = qualifiedCount();
  if (currentCount === beforeCount) {
    console.log(`[batch] 品牌 ${brand} 本轮无新增达标品。`);
  }
  state.completedBrands.push(brand);
  state.currentBrand = "";
  saveState(statePath, state);
  await sleep(sleepMs);
}

const finalCount = qualifiedCount();
console.log(`\n[batch] 结束。达标可用品 ${finalCount}/${target}`);
const csv = await execute({ action: "export_results" }, ctx);
console.log(`[batch] CSV: ${csv.outputPath || csv.message}`);
if (finalCount >= target || args.exportFeishu === "true") {
  const feishu = await execute({ action: "export_feishu" }, ctx);
  console.log(`[batch] 飞书: ${JSON.stringify({ ok: feishu.ok, count: feishu.count, url: feishu.url, message: feishu.message }, null, 2)}`);
}
process.exit(stopping ? 130 : 0);

function buildQualifiedMatches(jd, taobaoCandidates, keyword) {
  const matches = [];
  const seenTaobao = new Set();
  for (const tb of taobaoCandidates) {
    if (!tb?.productId || seenTaobao.has(tb.productId)) continue;
    seenTaobao.add(tb.productId);

    const same = assessSameProductMatch(jd, tb, keyword);
    if (!same.matched || same.confidence < 0.5) {
      continue;
    }

    const dosage = dosageCompatibility(jd, tb);
    if (!dosage.compatible) continue;

    const compared = compareUnitPrice(jd, tb);
    if (!compared.canCompare || !compared.jd?.unitPrice || !compared.taobao?.unitPrice) {
      continue;
    }

    const evaluated = evaluateWithStrategy(
      { ...jd, unitPrice: compared.jd.unitPrice, shopType: jd.shopType || "buyer" },
      { ...tb, unitPrice: compared.taobao.unitPrice },
      strategy
    );
    if (!evaluated.passed) continue;

    matches.push({
      taobao: {
        ...tb,
        unitPrice: compared.taobao.unitPrice,
        unit: compared.taobao.unit || tb.unit || "",
        skuInfo: tb.skuInfo || tb.skuText || "",
        isDomestic: tb.isDomestic ?? tb.domesticShipping ?? true
      },
      profit: {
        profitAmount: roundMoney(evaluated.profitAmount),
        profitRate: roundRate(evaluated.profitRate)
      },
      review: {
        sameProduct: same.reason,
        confidence: same.confidence,
        dosage: dosage.reason,
        unitPrice: compared.summary,
        strategy: evaluated.reason
      }
    });
  }
  return matches.sort((a, b) => b.profit.profitRate - a.profit.profitRate);
}

function normalizeJdForSave(jd) {
  const comparedBase = {
    ...jd,
    shopType: jd.shopType || "buyer",
    comments: String(jd.commentsNum || jd.comments || ""),
    skuInfo: jd.skuInfo || jd.skuText || ""
  };
  return comparedBase;
}

function dosageCompatibility(jd, tb) {
  const jdDosages = extractDosages(`${jd.title || ""} ${jd.skuInfo || jd.skuText || ""}`);
  const tbDosages = extractDosages(`${tb.title || ""} ${tb.skuInfo || tb.skuText || ""}`);
  if (!jdDosages.length || !tbDosages.length) return { compatible: true, reason: "剂量不足，按品类和单位价复核" };
  const shared = jdDosages.some((left) => tbDosages.some((right) => dosageClose(left, right)));
  if (shared) return { compatible: true, reason: `剂量可比：JD ${jdDosages.join("/")} vs TB ${tbDosages.join("/")}` };
  return { compatible: false, reason: `剂量不一致：JD ${jdDosages.join("/")} vs TB ${tbDosages.join("/")}` };
}

function extractDosages(text) {
  const normalized = String(text || "").toLowerCase().replace(/，|,|；|;/g, " ");
  const values = [];
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(mg|毫克|g|克|mcg|μg|ug|微克)/g)) {
    const raw = Number(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const unit = match[2];
    let mg = raw;
    if (unit === "g" || unit === "克") mg = raw * 1000;
    if (unit === "mcg" || unit === "μg" || unit === "ug" || unit === "微克") mg = raw / 1000;
    if (mg >= 1 && mg <= 5000) values.push(Number(mg.toFixed(4)));
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function dosageClose(left, right) {
  const ratio = Math.max(left, right) / Math.max(0.0001, Math.min(left, right));
  return ratio <= 1.25;
}

function qualifiedCount() {
  return qualifiedRows().length;
}

function qualifiedFingerprints() {
  return qualifiedRows().map((row) => buildJdProductFingerprint(row));
}

function qualifiedRows() {
  const db = openSourcingDb({ dataDir });
  try {
    return db.listDedupedQualifiedResults(strategy.profit);
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
    return { version: 1, completedBrands: [], completedJdProductIds: [], completedProductFingerprints: [], currentBrand: "", runs: [] };
  }
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.completedBrands ||= [];
  state.completedJdProductIds ||= [];
  state.completedProductFingerprints ||= [];
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
    runs: state.runs.slice(-500)
  };
  writeFileSync(file, JSON.stringify(trimmed, null, 2), "utf8");
}

function shouldStopForRisk(result) {
  const text = `${result.message || ""} ${result.error || ""}`;
  return Boolean(result.needLogin || /验证码|安全验证|访问频繁|风控|未登录|登录/.test(text));
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

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function roundRate(value) {
  return Number(Number(value || 0).toFixed(4));
}
