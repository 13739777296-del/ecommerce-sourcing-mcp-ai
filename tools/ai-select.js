/**
 * MCP工具: AI选品（通用引擎）
 *
 * 核心理念：引擎通用，策略可配。
 * Agent传入自己的策略，工具根据策略筛选商品并返回。
 */

import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts, aiClickProduct, aiExtractJdDetail, closeAiSession } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";

export const description = "AI驱动的电商选品工具。使用智能浏览器（正式Chrome+用户Cookie）模拟人类操作，绕过反爬。可传入自定义策略筛选商品。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["search", "extract", "detail", "search_and_filter", "close"],
      description: "操作: search=搜索, extract=提取列表, detail=进入详情(模拟人工点击), search_and_filter=搜索并按策略筛选, close=关闭会话"
    },
    keyword: {
      type: "string",
      description: "搜索关键词"
    },
    platform: {
      type: "string",
      enum: ["jd", "taobao"],
      default: "jd",
      description: "平台"
    },
    maxCount: {
      type: "number",
      default: 10,
      description: "最多提取数量"
    },
    productIndex: {
      type: "number",
      default: 0,
      description: "要点击的商品索引（detail时）"
    },
    strategy: {
      type: "object",
      description: "策略对象（search_and_filter时使用）。可参考 ecommerce_sourcing_strategy templates 获取模板"
    },
    strategyId: {
      type: "string",
      description: "策略ID（search_and_filter时使用，从策略库读取）"
    }
  },
  required: ["action"]
};

export async function handler(ctx, db, input) {
  const action = input.action;
  const platform = input.platform || "jd";
  profileSummary(ctx, db);

  try {
    if (action === "close") {
      await closeAiSession(`ai-${platform}`);
      return { ok: true, action, message: "AI浏览器会话已关闭" };
    }

    if (action === "search") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const session = await openAiSessionWithAccount(ctx, db, platform);
      const result = await aiJdSearch(session.page, input.keyword);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        platform,
        accountId: session.account.id,
        accountName: session.account.displayName,
        url: result.url,
        title: result.title,
        message: `搜索完成（${session.account.displayName}）`
      };
    }

    if (action === "extract") {
      const session = await openAiSessionWithAccount(ctx, db, platform);
      const products = await aiExtractJdProducts(session.page, input.maxCount || 10);
      return {
        ok: true,
        action,
        platform,
        accountId: session.account.id,
        count: products.length,
        products,
        message: `提取 ${products.length} 个商品`
      };
    }

    if (action === "detail") {
      const session = await openAiSessionWithAccount(ctx, db, platform);
      // 模仿人类：点击商品（不构造URL）
      const click = await aiClickProduct(session.page, input.productIndex || 0);
      // 提取详情（含已售、评论、品牌等）
      const detail = await aiExtractJdDetail(click.page);
      return {
        ok: true,
        action,
        platform,
        accountId: session.account.id,
        productIndex: input.productIndex || 0,
        url: click.url,
        detail,
        message: "详情页提取完成"
      };
    }

    if (action === "search_and_filter") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };

      // 解析策略：优先用传入的strategy，其次用strategyId查策略库，再次用默认
      let strategy = input.strategy;
      if (!strategy && input.strategyId) {
        strategy = DEFAULT_STRATEGIES[input.strategyId];
      }
      if (!strategy) {
        strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];
      }

      const session = await openAiSessionWithAccount(ctx, db, platform);

      // 1. 搜索
      await aiJdSearch(session.page, input.keyword);

      // 2. 提取列表
      const products = await aiExtractJdProducts(session.page, input.maxCount || 30);

      // 3. 用策略筛选
      const evaluated = products.map(p => {
        const result = evaluateJdProductByStrategy(p, strategy);
        return { ...p, passed: result.passed, rejectReason: result.passed ? null : result.reason };
      });

      const passed = evaluated.filter(p => p.passed);
      const rejected = evaluated.filter(p => !p.passed);

      return {
        ok: true,
        action,
        platform,
        keyword: input.keyword,
        strategy: { id: strategy.id, name: strategy.name },
        accountId: session.account.id,
        accountName: session.account.displayName,
        total: evaluated.length,
        passedCount: passed.length,
        rejectedCount: rejected.length,
        passed,
        rejectedSummary: rejected.slice(0, 5).map(p => ({
          title: p.title,
          shop: p.shop,
          shopType: p.shopType,
          reason: p.rejectReason
        })),
        message: `策略[${strategy.name}]筛选: ${passed.length}/${evaluated.length} 通过`
      };
    }

    return { ok: false, message: `未知操作: ${action}` };

  } catch (error) {
    return {
      ok: false,
      action,
      platform,
      error: error.message,
      message: `AI选品失败: ${error.message}`
    };
  }
}
