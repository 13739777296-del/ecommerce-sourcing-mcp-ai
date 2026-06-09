import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildSelectionReport(ctx, db, runId = null) {
  const run = runId ? db.getRun(runId) : db.latestRun();
  if (!run) {
    throw new Error("暂无选品任务，先运行一次选品。");
  }

  const candidates = db.listCandidates(run.id, 1000);
  const matches = db.listMatches(run.id, 1000);
  const artifacts = db.listArtifacts(run.id);
  const logs = db.listLogs(20, run.id);
  const reportDir = join(ctx?.dataDir || process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const filePath = join(reportDir, `selection-report-${run.id}-${Date.now()}.md`);
  const markdown = renderReport({ run, candidates, matches, artifacts, logs, dbPath: db.dbPath });
  writeFileSync(filePath, markdown, "utf8");
  return {
    filePath,
    markdown,
    run,
    candidates,
    matches,
    artifacts,
    logs,
    summary: summarizeRun(run, candidates, matches, artifacts)
  };
}

function renderReport({ run, candidates, matches, artifacts, logs, dbPath }) {
  const jdCandidates = candidates.filter((item) => item.platform === "jd");
  const taobaoCandidates = candidates.filter((item) => item.platform === "taobao");
  const qualified = matches.filter((item) => item.status === "qualified");
  const eliminated = matches.filter((item) => item.status !== "qualified");
  const reasonSummary = summarizeReasons(candidates.filter((item) => item.status !== "passed"));

  return [
    `# 电商选品任务报告`,
    "",
    `## 结论`,
    "",
    `- 任务 ID：${run.id}`,
    `- 输入：${run.inputValue}`,
    `- 状态：${statusText(run.status)}`,
    `- 策略：${run.strategyProfileId || "未记录"}`,
    `- 京东候选：${run.jdFilteredCount} / 原始 ${run.jdRawCount}`,
    `- 淘宝通过：${run.taobaoFilteredCount} / 原始 ${run.taobaoRawCount}`,
    `- 利润达标：${run.eligibleCount}`,
    `- 本地数据库：${dbPath}`,
    "",
    `## 淘宝搜索词`,
    "",
    ...(run.taobaoKeywords?.length
      ? run.taobaoKeywords.map((item, index) => `- ${index + 1}. ${item.keyword}（京东：${trimText(item.jdTitle, 36)}）`)
      : ["- 暂无"]),
    "",
    `## 京东候选`,
    "",
    ...(jdCandidates.length ? jdCandidates.map(renderCandidateLine) : ["- 暂无"]),
    "",
    `## 淘宝候选`,
    "",
    ...(taobaoCandidates.length ? taobaoCandidates.slice(0, 30).map(renderCandidateLine) : ["- 暂无"]),
    taobaoCandidates.length > 30 ? `- 其余 ${taobaoCandidates.length - 30} 条已省略，可导出 CSV 查看。` : "",
    "",
    `## 利润匹配`,
    "",
    ...(matches.length ? [...qualified, ...eliminated].map(renderMatchLine) : ["- 暂无利润匹配，通常表示没有淘宝候选通过同款、发货、销量或时效规则。"]),
    "",
    `## 淘汰原因`,
    "",
    ...(reasonSummary.length ? reasonSummary.map((item) => `- ${item.reason}：${item.count} 条`) : ["- 暂无淘汰记录"]),
    "",
    `## 本地素材`,
    "",
    ...(artifacts.length ? artifacts.map(renderArtifactLine) : ["- 暂无本地素材"]),
    "",
    `## 最近日志`,
    "",
    ...(logs.length ? logs.map((log) => `- ${formatTime(log.createdAt)} [${log.level}] ${log.message}`) : ["- 暂无日志"]),
    "",
    `## 建议下一步`,
    "",
    ...nextActions(run, { taobaoCandidates, matches }),
    ""
  ].join("\n");
}

function summarizeRun(run, candidates, matches, artifacts) {
  return {
    runId: run.id,
    input: run.inputValue,
    status: run.status,
    jdPassed: run.jdFilteredCount,
    taobaoPassed: run.taobaoFilteredCount,
    eligible: run.eligibleCount,
    candidateCount: candidates.length,
    matchCount: matches.length,
    artifactCount: artifacts.length
  };
}

function renderCandidateLine(item) {
  const status = item.status === "passed" ? "通过" : "淘汰";
  const platform = item.platform === "jd" ? "京东" : "淘宝";
  const price = money(item.price);
  const unit = money(item.unitPrice);
  const sku = item.skuText ? `，SKU：${trimText(item.skuText, 30)}` : "";
  const reason = item.reason ? `，原因：${item.reason}` : "";
  return `- ${platform} ${status}：${trimText(item.title, 56)}，价格 ${price}，单位价 ${unit}${sku}${reason}，链接：${item.url}`;
}

function renderMatchLine(item) {
  const status = item.status === "qualified" ? "可用" : "淘汰";
  return `- ${status}：${trimText(item.jdTitle, 40)} -> ${trimText(item.taobaoTitle, 40)}，利润 ${money(item.profitAmount)}，利润率 ${(Number(item.profitRate || 0) * 100).toFixed(1)}%，原因：${item.reason}`;
}

function renderArtifactLine(item) {
  const platform = item.platform === "jd" ? "京东" : item.platform === "taobao" ? "淘宝" : "任务";
  return `- ${platform} ${item.label || item.artifactType}：${item.filePath || item.sourceUrl}`;
}

function summarizeReasons(candidates) {
  const map = new Map();
  for (const item of candidates) {
    const reason = item.reason || "未记录原因";
    map.set(reason, (map.get(reason) || 0) + 1);
  }
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function nextActions(run, { taobaoCandidates, matches }) {
  if (run.status === "paused") {
    return ["- 当前任务已暂停，先查看日志里的登录、验证码、访问频繁或账号风险提示。"];
  }
  if (run.jdFilteredCount === 0) {
    return ["- 京东候选为 0，建议换更具体的品牌 + 产品名，或临时放宽评论数后再小量重试。"];
  }
  if (taobaoCandidates.length === 0) {
    return ["- 淘宝候选为 0，建议使用 `compare-more` 策略或手动提供一个更贴近供货端的淘宝关键词。"];
  }
  if (matches.length === 0 || run.eligibleCount === 0) {
    return [
      "- 暂无利润达标商品，优先尝试 `compare-more` 策略，多试几个淘宝关键词。",
      "- 如果淘宝结果明显跑偏，下一步应接入以图搜图或多模态同款判断。"
    ];
  }
  return ["- 有利润达标商品，可以先导出 CSV，再人工抽查链接和 SKU 后进入后续监控。"];
}

function trimText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function statusText(status) {
  if (status === "completed") return "已完成";
  if (status === "running") return "执行中";
  if (status === "paused") return "已暂停";
  return status || "未知";
}

function money(value) {
  const number = Number(value || 0);
  return number.toFixed(2);
}

function formatTime(value) {
  return String(value || "").replace("T", " ").replace(/\.\d+Z$/, "");
}
