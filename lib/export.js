import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function exportMatchesCsv(ctx, db, runId = null) {
  const exportDir = join(ctx?.dataDir || process.cwd(), "exports");
  mkdirSync(exportDir, { recursive: true });
  const targetRun = runId || db.latestRun()?.id || null;
  const run = targetRun ? db.getRun(targetRun) : null;
  const artifacts = targetRun ? db.listArtifacts(targetRun) : [];
  const metadata = exportMetadata(run, artifacts);
  const artifactIndex = indexArtifacts(artifacts);
  const rows = db.listMatches(targetRun, 500);
  const filePath = join(exportDir, `selection-results-${targetRun || "all"}-${Date.now()}.csv`);
  if (rows.length === 0) {
    return exportCandidatesCsv(filePath, targetRun, db.listCandidates(targetRun, 1000), metadata, artifactIndex);
  }
  const header = [
    "任务ID",
    "策略",
    "淘宝搜索词",
    "状态",
    "京东标题",
    "京东价格",
    "京东单位价",
    "京东SKU",
    "京东店铺",
    "京东链接",
    "京东主图",
    "京东本地素材",
    "淘宝标题",
    "淘宝价格",
    "淘宝单位价",
    "淘宝SKU",
    "淘宝链接",
    "淘宝主图",
    "淘宝本地素材",
    "页面截图",
    "利润金额",
    "利润率",
    "判断原因"
  ];
  const lines = [header, ...rows.map((row) => [
    targetRun,
    metadata.strategyProfileId,
    metadata.taobaoKeywords.join(" / "),
    row.status === "qualified" ? "可用" : "淘汰",
    row.jdTitle,
    row.jdPrice,
    row.jdUnitPrice,
    row.jdSkuText,
    row.jdShopName,
    row.jdUrl,
    row.jdImage,
    artifactPaths(artifactIndex, "jd", productIdFromUrl(row.jdUrl), "product_image"),
    row.taobaoTitle,
    row.taobaoPrice,
    row.taobaoUnitPrice,
    row.taobaoSkuText,
    row.taobaoUrl,
    row.taobaoImage,
    artifactPaths(artifactIndex, "taobao", productIdFromUrl(row.taobaoUrl), "product_image"),
    artifactPaths(artifactIndex, "", "", "page_screenshot", { allowGlobalFallback: true }),
    row.profitAmount,
    `${(row.profitRate * 100).toFixed(1)}%`,
    row.reason
  ])];
  writeFileSync(filePath, lines.map((line) => line.map(csvCell).join(",")).join("\n"), "utf8");
  return { filePath, rows: rows.length, runId: targetRun, mode: "matches", metadata };
}

function exportCandidatesCsv(filePath, runId, candidates, metadata, artifactIndex) {
  const header = [
    "任务ID",
    "策略",
    "淘宝搜索词",
    "平台",
    "状态",
    "标题",
    "价格",
    "单位价",
    "SKU",
    "店铺",
    "链接",
    "主图",
    "本地素材",
    "页面截图",
    "判断原因"
  ];
  const lines = [header, ...candidates.map((row) => [
    runId,
    metadata.strategyProfileId,
    metadata.taobaoKeywords.join(" / "),
    row.platform === "jd" ? "京东" : "淘宝",
    row.status === "passed" ? "通过" : "淘汰",
    row.title,
    row.price,
    row.unitPrice,
    row.skuText,
    row.shopName,
    row.url,
    row.mainImageUrl,
    artifactPaths(artifactIndex, row.platform, row.productId, "product_image"),
    artifactPaths(artifactIndex, "", "", "page_screenshot", { allowGlobalFallback: true }),
    row.reason
  ])];
  writeFileSync(filePath, lines.map((line) => line.map(csvCell).join(",")).join("\n"), "utf8");
  return { filePath, rows: candidates.length, runId, mode: "candidates", metadata };
}

function exportMetadata(run, artifacts) {
  return {
    strategyProfileId: run?.strategyProfileId || "",
    strategy: run?.strategy || {},
    taobaoKeywords: Array.isArray(run?.taobaoKeywords)
      ? run.taobaoKeywords.map((item) => item.keyword).filter(Boolean)
      : [],
    artifactCount: artifacts.length,
    artifacts
  };
}

function indexArtifacts(artifacts) {
  const map = new Map();
  for (const artifact of artifacts) {
    for (const key of [
      `${artifact.platform}:${artifact.productId}:${artifact.artifactType}`,
      `::${artifact.artifactType}`
    ]) {
      const list = map.get(key) || [];
      list.push(artifact.filePath);
      map.set(key, list);
    }
  }
  return map;
}

function artifactPaths(index, platform, productId, artifactType, opts = {}) {
  const specific = index.get(`${platform}:${productId}:${artifactType}`) || [];
  const global = specific.length || !opts.allowGlobalFallback ? [] : index.get(`::${artifactType}`) || [];
  return [...specific, ...global].filter(Boolean).join(" / ");
}

function productIdFromUrl(url) {
  const text = String(url || "");
  return text.match(/item\.jd\.com\/(\d+)\.html/)?.[1] || text.match(/[?&]id=(\d+)/)?.[1] || "";
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
