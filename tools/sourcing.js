/**
 * MCP工具：电商选品（All-in-One）
 *
 * 一个MCP工具，多个action，覆盖所有场景：
 * - 策略库管理
 * - 单步操作（搜索/提取/详情）
 * - 完整自动化选品
 */

import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts, aiClickProduct, aiExtractJdDetail, closeAiSession, aiTaobaoSearchByImage, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";
import { fullSelectionFlow, batchSelection } from "../lib/full-selection.js";

export const description = "电商选品All-in-One工具。支持：策略库管理、单步操作（搜索/提取/详情）、完整自动化选品（京东→淘宝→比价）。一个MCP搞定所有场景。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "strategy_list", "strategy_get", "strategy_save", "strategy_templates",
        "jd_search", "jd_extract", "jd_detail", "jd_search_filter",
        "taobao_search", "taobao_search_image", "taobao_extract",
        "full_selection", "batch_selection",
        "close"
      ],
      description: `操作类型：
        策略库: strategy_list/get/save/templates
        京东单步: jd_search/extract/detail/search_filter
        淘宝单步: taobao_search/search_image/extract
        完整流程: full_selection (单个关键词), batch_selection (批量)
        关闭: close`
    },
    keyword: {
      type: "string",
      description: "搜索关键词"
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "批量关键词"
    },
    platform: {
      type: "string",
      enum: ["jd", "taobao"],
      default: "jd"
    },
    maxCount: {
      type: "number",
      default: 10
    },
    productIndex: {
      type: "number",
      default: 0
    },
    strategyId: {
      type: "string",
      default: "no-source-arbitrage"
    },
    strategy: {
      type: "object",
      description: "自定义策略对象"
    },
    imageUrl: {
      type: "string",
      description: "淘宝以图搜图的图片URL"
    },
    maxJdCandidates: {
      type: "number",
      default: 10
    },
    maxTaobaoCandidatesPerJd: {
      type: "number",
      default: 10
    },
    targetCount: {
      type: "number",
      description: "批量选品目标数量"
    }
  },
  required: ["action"]
};

export async function handler(ctx, db, input) {
  const action = input.action;
  const platform = input.platform || "jd";
  profileSummary(ctx, db);

  try {
    // ===== 策略库管理 =====
    if (action === "strategy_templates") {
      return {
        ok: true,
        action,
        templates: Object.values(DEFAULT_STRATEGIES),
        message: `${Object.keys(DEFAULT_STRATEGIES).length} 个策略模板`
      };
    }

    if (action === "strategy_list") {
      return {
        ok: true,
        action,
        strategies: Object.values(DEFAULT_STRATEGIES),
        message: `${Object.keys(DEFAULT_STRATEGIES).length} 个策略`
      };
    }

    if (action === "strategy_get") {
      const strategy = DEFAULT_STRATEGIES[input.strategyId];
      if (!strategy) return { ok: false, message: `策略不存在: ${input.strategyId}` };
      return { ok: true, action, strategy };
    }

    if (action === "strategy_save") {
      // TODO: 保存到数据库
      return { ok: true, action, message: "策略保存功能待实现" };
    }

    // ===== 关闭 =====
    if (action === "close") {
      await closeAiSession(`ai-${platform}`);
      return { ok: true, action, message: `${platform}浏览器已关闭` };
    }

    // ===== 京东单步操作 =====
    if (action === "jd_search") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const session = await openAiSessionWithAccount(ctx, db, "jd");
      const result = await aiJdSearch(session.page, input.keyword);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        url: result.url,
        title: result.title,
        message: "京东搜索完成"
      };
    }

    if (action === "jd_extract") {
      const session = await openAiSessionWithAccount(ctx, db, "jd");
      const products = await aiExtractJdProducts(session.page, input.maxCount || 10);
      return {
        ok: true,
        action,
        count: products.length,
        products,
        message: `提取 ${products.length} 个京东商品`
      };
    }

    if (action === "jd_detail") {
      const session = await openAiSessionWithAccount(ctx, db, "jd");
      const click = await aiClickProduct(session.page, input.productIndex || 0);
      const detail = await aiExtractJdDetail(click.page);
      return {
        ok: true,
        action,
        url: click.url,
        detail,
        message: "京东详情提取完成"
      };
    }

    if (action === "jd_search_filter") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const strategy = input.strategy || DEFAULT_STRATEGIES[input.strategyId] || DEFAULT_STRATEGIES["no-source-arbitrage"];
      const session = await openAiSessionWithAccount(ctx, db, "jd");
      await aiJdSearch(session.page, input.keyword);
      const products = await aiExtractJdProducts(session.page, input.maxCount || 30);
      const evaluated = products.map(p => {
        const result = evaluateJdProductByStrategy(p, strategy);
        return { ...p, passed: result.passed, rejectReason: result.reason };
      });
      const passed = evaluated.filter(p => p.passed);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        strategy: { id: strategy.id, name: strategy.name },
        total: evaluated.length,
        passed: passed.length,
        passedProducts: passed,
        message: `策略筛选: ${passed.length}/${evaluated.length} 通过`
      };
    }

    // ===== 淘宝单步操作 =====
    if (action === "taobao_search") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const session = await openAiSessionWithAccount(ctx, db, "taobao");
      const result = await aiTaobaoSearch(session.page, input.keyword);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        url: result.url,
        message: "淘宝搜索完成"
      };
    }

    if (action === "taobao_search_image") {
      if (!input.imageUrl) return { ok: false, message: "缺少图片URL" };
      const session = await openAiSessionWithAccount(ctx, db, "taobao");
      const result = await aiTaobaoSearchByImage(session.page, input.imageUrl);
      return {
        ok: true,
        action,
        imageUrl: input.imageUrl,
        url: result.url,
        message: "淘宝以图搜图完成"
      };
    }

    if (action === "taobao_extract") {
      const session = await openAiSessionWithAccount(ctx, db, "taobao");
      const products = await aiExtractTaobaoProducts(session.page, input.maxCount || 10);
      return {
        ok: true,
        action,
        count: products.length,
        products,
        message: `提取 ${products.length} 个淘宝商品`
      };
    }

    // ===== 完整自动化选品 =====
    if (action === "full_selection") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const result = await fullSelectionFlow(ctx, db, input.keyword, {
        strategyId: input.strategyId,
        maxJdCandidates: input.maxJdCandidates,
        maxTaobaoCandidatesPerJd: input.maxTaobaoCandidatesPerJd
      });
      return {
        ok: true,
        action,
        keyword: input.keyword,
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
            url: m.jd.url
          },
          taobao: {
            productId: m.taobao.productId,
            title: m.taobao.title,
            price: m.taobao.price,
            unitPrice: m.taobao.unitPrice,
            unit: m.taobao.unit,
            shipFrom: m.taobao.shipFrom,
            url: m.taobao.url
          },
          profit: {
            rate: m.profit.profitRate,
            amount: m.profit.profitAmount
          }
        })),
        message: `完成！找到 ${result.matched.length} 个可用品`
      };
    }

    if (action === "batch_selection") {
      if (!input.keywords || input.keywords.length === 0) {
        return { ok: false, message: "缺少关键词列表" };
      }
      const results = await batchSelection(ctx, db, input.keywords, {
        strategyId: input.strategyId,
        maxJdCandidates: input.maxJdCandidates,
        maxTaobaoCandidatesPerJd: input.maxTaobaoCandidatesPerJd,
        targetCount: input.targetCount
      });
      const totalMatched = results.reduce((sum, r) => sum + r.matched.length, 0);
      return {
        ok: true,
        action,
        keywordsProcessed: results.length,
        totalMatched,
        message: `批量选品完成！共 ${totalMatched} 个可用品`
      };
    }

    return { ok: false, message: `未知操作: ${action}` };

  } catch (error) {
    return {
      ok: false,
      action,
      error: error.message,
      message: `操作失败: ${error.message}`
    };
  }
}
