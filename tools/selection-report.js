import { openSourcingDb } from "../lib/db.js";
import { buildSelectionReport } from "../lib/report.js";

export const name = "selection-report";
export const description = "生成最近一次或指定任务的 Markdown 选品复盘报告，并保存到本地 reports 目录。";
export const parameters = {
  type: "object",
  properties: {
    runId: { type: "string", description: "可选，指定任务 ID；不填则使用最近一次任务。" }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const report = buildSelectionReport(ctx, db, input?.runId || null);
    if (ctx?.stageFile && report.filePath) {
      await ctx.stageFile(report.filePath).catch(() => undefined);
    }
    return {
      content: [{
        type: "text",
        text: [
          "选品复盘报告已生成。",
          `任务 ID：${report.run.id}`,
          `文件：${report.filePath}`,
          "",
          report.markdown
        ].join("\n")
      }],
      details: {
        filePath: report.filePath,
        summary: report.summary,
        run: report.run,
        artifacts: report.artifacts
      }
    };
  } finally {
    db.close();
  }
}
