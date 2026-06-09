import { openSourcingDb } from "../lib/db.js";
import { profileSummary } from "../lib/accounts.js";

export const name = "status";
export const description = "查看电商选品 Agent 的账号、最近任务、最近日志和最近匹配结果。";
export const parameters = {
  type: "object",
  properties: {
    limit: { type: "number", description: "返回日志和结果数量，默认 10。" }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const limit = Math.max(1, Math.min(50, Number(input?.limit || 10)));
    const accounts = profileSummary(ctx, db);
    const run = db.latestRun();
    const matches = db.listMatches(run?.id || null, limit);
    const logs = db.listLogs(limit, run?.id || null);
    const artifacts = run ? db.listArtifacts(run.id) : [];
    const text = [
      "电商选品 Agent 状态",
      `数据库：${db.dbPath}`,
      `账号：${accounts.length} 个，${accounts.filter((item) => item.status === "available").length} 个可用`,
      `最近任务：${run ? `${run.status} / ${run.inputValue}` : "暂无"}`,
      run ? `最近策略：${run.strategyProfileId || "未记录"}，淘宝搜索词：${(run.taobaoKeywords || []).map((item) => item.keyword).filter(Boolean).join(" / ") || "暂无"}` : "",
      run ? `最近素材：${artifacts.length} 个，本地截图/主图可用于复盘。` : "",
      `最近匹配：${matches.length} 条`,
      logs.length ? `最近日志：\n${logs.map((log) => `- [${log.level}] ${log.message}`).join("\n")}` : "最近日志：暂无"
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { dbPath: db.dbPath, accounts, run, matches, logs, artifacts }
    };
  } finally {
    db.close();
  }
}
