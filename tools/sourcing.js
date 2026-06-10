/**
 * MCP工具：电商选品（All-in-One）
 *
 * 一个MCP工具，多个action，覆盖所有场景：
 * - 策略库管理
 * - 单步操作（搜索/提取/详情）
 * - 完整自动化选品
 */

import { openAiSessionWithAccount, aiJdSearch, aiExtractJdProducts, aiClickProduct, aiExtractJdDetail, aiJdHarvest, aiTaobaoHarvest, closeAiSession, aiTaobaoSearchByImage, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";
import { fullSelectionFlow, batchSelection } from "../lib/full-selection.js";

import { openSourcingDb } from "../lib/db.js";

export const description = "电商选品All-in-One工具。支持：策略库管理、单步操作（搜索/提取/详情）、完整自动化选品（京东→淘宝→比价）。一个MCP搞定所有场景。";

/**
 * MCP入口：runtime 调用的是 execute(args, ctx)。
 * 这里开 db，再转交给 handler(ctx, db, input)。
 */
export async function execute(args, ctx) {
  const db = openSourcingDb(ctx);
  return handler(ctx, db, args || {});
}

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "strategy_list", "strategy_get", "strategy_save", "strategy_templates",
        "jd_search", "jd_extract", "jd_detail", "jd_search_filter", "jd_harvest",
        "taobao_search", "taobao_search_image", "taobao_extract", "taobao_harvest",
        "full_selection", "batch_selection",
        "close"
      ],
      description: `操作类型：
        策略库: strategy_list/get/save/templates
        京东单步: jd_search/extract/detail/search_filter
        京东选品(推荐): jd_harvest —— 搜"品牌+买手店"→翻页拉买手店品→进详情拿评价→筛评价>2
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
    },
    brand: {
      type: "string",
      description: "jd_harvest用：品牌词(如SWISSE)，内部拼成\"品牌 买手店\"搜索"
    },
    maxPages: {
      type: "number",
      default: 3,
      description: "jd_harvest用：搜索结果翻几页(每页约60品，翻越多拉越多)"
    },
    maxDetail: {
      type: "number",
      default: 20,
      description: "jd_harvest用：最多进几个详情页拿评价(高频操作，注意风控，建议≤30)"
    },
    minSales: {
      type: "number",
      default: 10,
      description: "taobao_harvest用：最低已售(人付款)门槛"
    },
    requireDomestic: {
      type: "boolean",
      default: true,
      description: "taobao_harvest用：是否只要国内发货"
    },
    require48h: {
      type: "boolean",
      default: true,
      description: "taobao_harvest用：是否只要48小时内发货"
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

    // ===== 京东选品（推荐入口，用验证过的 aiJdHarvest）=====
    if (action === "jd_harvest") {
      const brand = input.brand || input.keyword;
      if (!brand) return { ok: false, message: "缺少 brand（品牌词，如 SWISSE）" };

      const session = await openAiSessionWithAccount(ctx, db, "jd");
      const result = await aiJdHarvest(session.page, brand, {
        maxPages: input.maxPages || 3,
        maxDetail: input.maxDetail || 20,
        minComments: 2
      });

      return {
        ok: true,
        action,
        brand,
        stats: result.stats,
        candidateCount: result.candidates.length,
        candidates: result.candidates,
        // 给调用方Agent的清洗指令（脚本只拉脏数据，清洗交给你）
        agentInstructions: buildJdCleaningInstructions(result.candidates.length),
        message: `京东选品完成：${result.candidates.length}个评价>2的候选品，请按 agentInstructions 清洗`
      };
    }


    // ===== 淘宝选品（推荐入口，用验证过的 aiTaobaoHarvest）=====
    if (action === "taobao_harvest") {
      if (!input.keyword) return { ok: false, message: "缺少 keyword(用京东品的品牌+品名)" };
      const session = await openAiSessionWithAccount(ctx, db, "taobao");
      const result = await aiTaobaoHarvest(session.page, input.keyword, {
        maxList: input.maxCount || 40,
        maxDetail: input.maxDetail || 10,
        minSales: input.minSales ?? 10,
        requireDomestic: input.requireDomestic !== false,
        require48h: input.require48h !== false
      });
      return {
        ok: true,
        action,
        keyword: input.keyword,
        stats: result.stats,
        candidateCount: result.candidates.length,
        candidates: result.candidates,
        agentInstructions: buildTaobaoCleaningInstructions(result.candidates.length),
        message: `淘宝选品完成：${result.candidates.length}个符合(国内+48h+已售达标)的货源，请按 agentInstructions 比价`
      };
    }

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

/**
 * 生成给调用方Agent的清洗指令。
 * 设计原则：脚本只负责拉脏数据，去重和算最小规格单价这种需要"理解力"的活，
 * 交给调用本MCP的Agent(大模型)做。指令必须整洁、清晰、可执行。
 */
function buildJdCleaningInstructions(candidateCount) {
  return {
    summary: `已拉取 ${candidateCount} 个京东买手店候选品(评价均>2)。请你对 candidates 数组做以下清洗，得到干净的京东品清单。`,
    steps: [
      {
        step: 1,
        name: "算最小规格单价",
        detail: "从每个品的 title 和 skuInfo 解析规格，把价格换算成『最小规格单价』。规则：含粒/片→每粒每片；含g/kg→每克(kg×1000)；含ml/L→每毫升(L×1000)。例：60粒¥120→¥2/粒。解析不出规格的，标记 unitPrice=null 并保留，备注『规格待人工确认』。",
        output: "给每个品补 unitPrice(数字) 和 unit(粒/g/ml等) 两个字段"
      },
      {
        step: 2,
        name: "识别同款并去重",
        detail: "同一款产品可能有多个链接(不同店铺、不同SKU装量)。依据 title 的品牌+品名+核心规格判断是否同款(忽略装量差异，如『1瓶』vs『3瓶』算同款)。同款只保留『最小规格单价最低』的那一个。",
        output: "去重后的京东品清单，每个同款只剩1条(最小规格单价最低的)"
      },
      {
        step: 3,
        name: "输出",
        detail: "输出清洗后的清单，每条含：title, price, unitPrice, unit, comments, shop, url。这是后续去淘宝比价的京东基准品。",
        output: "干净的京东基准品清单"
      }
    ],
    note: "最小规格单价是京东↔淘宝比价的统一标尺。下一步用这些品的标题/图去淘宝找货比价时，也用同样的最小规格单价口径。"
  };
}

/**
 * 生成给调用方Agent的淘宝比价指令。
 * 核心：①淘宝同一链接不同SKU价格差距大，必须按SKU比；
 *       ②一个京东品可匹配多个淘宝链接，符合的都保留；
 *       ③用最小规格单价做统一比价标尺。
 */
function buildTaobaoCleaningInstructions(candidateCount) {
  return {
    summary: `已拉取 ${candidateCount} 个淘宝货源(均已通过 国内发货+48h内发+已售达标 三道筛)。请你完成与京东品的比价。`,
    steps: [
      {
        step: 1,
        name: "按SKU算最小规格单价（关键）",
        detail: "淘宝同一链接里不同SKU(如60粒/200粒、1瓶/5瓶)价格差距很大，不能只用一个价。请从每个货源的 title 和 skuInfo 找出各SKU的规格与价格，分别换算成最小规格单价(每粒/每g/每ml)。规格换算：粒/片按个；g/kg→克(kg×1000)；ml/L→毫升(L×1000)。",
        output: "每个货源标注：各SKU的『规格→价格→最小规格单价』，并取其中最低的最小规格单价作为该货源的比价基准"
      },
      {
        step: 2,
        name: "与京东品匹配（一对多）",
        detail: "把这些淘宝货源与对应的京东品按『同款』匹配(品牌+品名+核心规格)。一个京东品可以匹配多个淘宝链接，只要符合规则都保留——这是正常的，给后续挑选留空间。",
        output: "每个京东品下挂一个或多个匹配的淘宝货源"
      },
      {
        step: 3,
        name: "算利润、按策略卡阈值",
        detail: "用统一的最小规格单价比价：利润率=(京东最小规格单价 - 淘宝最小规格单价)/京东最小规格单价。按当前策略的利润区间(如35%~60%)筛选。符合的才是最终可用品。",
        output: "最终可用品清单：京东品 + 匹配的淘宝货源(可多个) + 各自最小规格单价 + 利润率"
      }
    ],
    note: "最小规格单价是京东↔淘宝唯一可比的标尺。务必按SKU拆价，否则同链接不同装量会让比价完全失真。"
  };
}

