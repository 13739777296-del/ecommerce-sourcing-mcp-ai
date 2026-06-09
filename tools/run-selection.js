import { openSourcingDb } from "../lib/db.js";
import { profileSummary } from "../lib/accounts.js";
import { runSelectionFlow } from "../lib/browser-selection.js";

export const name = "run-selection";
export const description = "运行一次电商选品任务（备选工具）。支持关键词选品或京东链接匹配淘宝供货，使用旧项目正式 Chrome profile，小量、保守地执行 JD -> 淘宝流程并保存结果。⚠️ 注意：这不是 AI 驱动的，仅在 agent_collect 不可用时作为备选。";
export const promptGuidelines = [
  "这是备选选品工具，仅在 agent_collect 不可用时使用。",
  "默认小量执行：京东 1 页、京东候选 1 个、淘宝搜索 1 次。",
  "遇到验证码、安全验证、访问频繁、登录失效、账号异常时必须暂停，不要尝试绕过。"
];
export const parameters = {
  type: "object",
  properties: {
    keyword: { type: "string", description: "关键词、品牌词或产品词。和 jdUrl 二选一。" },
    jdUrl: { type: "string", description: "京东商品链接。和 keyword 二选一。" },
    taobaoKeyword: { type: "string", description: "可选，覆盖自动生成的淘宝搜索词。" },
    strategyPreset: { type: "string", description: "策略库预设 ID，例如 conservative、compare-more、strict-profit。" },
    jdPages: { type: "number", description: "京东采集页数，默认 1，最多 5。" },
    maxJdCandidates: { type: "number", description: "最多进入淘宝比价的京东候选数，默认 1。" },
    maxTaobaoSearches: { type: "number", description: "最多淘宝逐品搜索次数，默认 1。" },
    maxTaobaoKeywordAttempts: { type: "number", description: "每个京东候选最多尝试几个淘宝关键词，默认 1，最多 5。" },
    openTaskTab: { type: "boolean", description: "是否为任务打开新标签页，默认 true。这样不会反复复用同一个旧页面。" },
    keepBrowserOpen: { type: "boolean", description: "任务结束后是否保留 Chrome 窗口，默认 true。设为 false 才会关闭本次受控 Chrome。" },
    strategy: {
      type: "object",
      description: "选品策略覆盖项。",
      properties: {
        minJdComments: { type: "number" },
        minTaobaoSales: { type: "number" },
        requireDomesticShipping: { type: "boolean" },
        requireFastShippingHours: { type: "number" },
        maxTaobaoKeywordAttempts: { type: "number" }
      }
    }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    profileSummary(ctx, db);
    const result = await runSelectionFlow(ctx, db, input || {});
    const summary = [
      `电商选品 Agent 执行${result.ok ? "完成" : "暂停"}。`,
      `任务 ID：${result.run?.id || "未知"}`,
      `京东候选：${result.run?.jdFilteredCount ?? 0}`,
      `淘宝通过：${result.run?.taobaoFilteredCount ?? 0}`,
      `利润达标：${result.run?.eligibleCount ?? 0}`,
      `数据库：${result.dbPath}`,
      "",
      result.message
    ].join("\n");
    return {
      content: [{ type: "text", text: summary }],
      details: result
    };
  } finally {
    db.close();
  }
}
