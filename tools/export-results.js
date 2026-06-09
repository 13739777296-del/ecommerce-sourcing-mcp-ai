import { openSourcingDb } from "../lib/db.js";
import { exportMatchesCsv } from "../lib/export.js";

export const name = "export-results";
export const description = "把最近一次或指定任务的选品匹配结果导出为本地 CSV 表格。";
export const parameters = {
  type: "object",
  properties: {
    runId: { type: "string", description: "可选，指定任务 ID；不填则导出最近一次任务。" }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const exported = exportMatchesCsv(ctx, db, input?.runId || null);
    if (ctx?.stageFile && exported.filePath) {
      await ctx.stageFile(exported.filePath).catch(() => undefined);
    }
    return {
      content: [{
        type: "text",
        text: `选品结果已导出。\n文件：${exported.filePath}\n行数：${exported.rows}`
      }],
      details: exported
    };
  } finally {
    db.close();
  }
}
