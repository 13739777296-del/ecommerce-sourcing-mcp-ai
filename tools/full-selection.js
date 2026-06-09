/**
 * MCP工具：完整选品流程
 *
 * 一条指令，端到端自动化：
 * 京东搜索 → 提取详情 → 淘宝以图搜图 → 比价 → 计算利润 → 输出可用品
 */

import { fullSelectionFlow, batchSelection } from "../lib/full-selection.js";
import { profileSummary } from "../lib/accounts.js";

export const description = "完整的自动化选品流程。一条指令完成：京东搜索→提取详情(SKU/评论)→淘宝以图搜图→比价→计算单价和利润→输出符合策略的可用品。支持批量关键词。";

export const parameters = {
  type: "object",
  properties: {
    keyword: {
      type: "string",
      description: "搜索关键词（单个）"
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "批量关键词列表"
    },
    strategyId: {
      type: "string",
      default: "no-source-arbitrage",
      description: "策略ID（从 ecommerce_sourcing_strategy 获取，默认：无货源套利）"
    },
    maxJdCandidates: {
      type: "number",
      default: 10,
      description: "每个关键词最多处理几个京东候选商品"
    },
    maxTaobaoCandidatesPerJd: {
      type: "number",
      default: 10,
      description: "每个京东品搜索多少个淘宝供货"
    },
    targetCount: {
      type: "number",
      description: "目标商品数（批量模式，达到目标就停止）"
    },
    saveScreenshots: {
      type: "boolean",
      default: false,
      description: "是否保存商品截图"
    }
  }
};

export async function handler(ctx, db, input) {
  profileSummary(ctx, db);

  try {
    // 单个关键词模式
    if (input.keyword) {
      const result = await fullSelectionFlow(ctx, db, input.keyword, {
        strategyId: input.strategyId,
        maxJdCandidates: input.maxJdCandidates,
        maxTaobaoCandidatesPerJd: input.maxTaobaoCandidatesPerJd,
        saveScreenshots: input.saveScreenshots
      });

      return {
        ok: true,
        mode: "single",
        keyword: input.keyword,
        jdTotal: result.jd.total,
        jdPassed: result.jd.passed,
        taobaoTotal: result.taobao.total,
        taobaoPassed: result.taobao.passed,
        matchedCount: result.matched.length,
        matched: result.matched.map(m => ({
          jd: {
            productId: m.jd.productId,
            title: m.jd.title,
            price: m.jd.price,
            unitPrice: m.jd.unitPrice,
            unit: m.jd.unit,
            shop: m.jd.shop,
            shopType: m.jd.shopType,
            sales: m.jd.sales,
            comments: m.jd.comments,
            url: m.jd.url
          },
          taobao: {
            productId: m.taobao.productId,
            title: m.taobao.title,
            price: m.taobao.price,
            unitPrice: m.taobao.unitPrice,
            unit: m.taobao.unit,
            shop: m.taobao.shop,
            sales: m.taobao.sales,
            shipFrom: m.taobao.shipFrom,
            shipHours: m.taobao.shipHours,
            url: m.taobao.url
          },
          profit: {
            amount: m.profit.profitAmount,
            rate: m.profit.profitRate,
            summary: `利润率 ${(m.profit.profitRate * 100).toFixed(1)}%`
          }
        })),
        message: `完成！找到 ${result.matched.length} 个可用品`
      };
    }

    // 批量关键词模式
    if (input.keywords && input.keywords.length > 0) {
      const results = await batchSelection(ctx, db, input.keywords, {
        strategyId: input.strategyId,
        maxJdCandidates: input.maxJdCandidates,
        maxTaobaoCandidatesPerJd: input.maxTaobaoCandidatesPerJd,
        targetCount: input.targetCount,
        saveScreenshots: input.saveScreenshots
      });

      const totalMatched = results.reduce((sum, r) => sum + r.matched.length, 0);

      return {
        ok: true,
        mode: "batch",
        keywordsProcessed: results.length,
        totalMatched,
        results: results.map(r => ({
          keyword: r.keyword,
          matchedCount: r.matched.length
        })),
        message: `批量选品完成！共 ${totalMatched} 个可用品`
      };
    }

    return {
      ok: false,
      message: "需要提供 keyword 或 keywords"
    };

  } catch (error) {
    return {
      ok: false,
      error: error.message,
      stack: error.stack,
      message: `选品失败: ${error.message}`
    };
  }
}
