/**
 * 通用策略引擎
 *
 * 设计理念：引擎通用，规则可配。
 * 任何Agent接入这个MCP，只要带自己的策略库，就能做任意场景的选品。
 *
 * 策略JSON Schema：
 * {
 *   "id": "no-source-arbitrage",
 *   "name": "无货源套利策略",
 *   "description": "京东找好卖品，淘宝找供货",
 *   "platforms": {
 *     "jd": {
 *       "shopTypes": {                  // 店铺类型筛选
 *         "include": ["buyer"],          // 只要买手店
 *         "exclude": ["flagship", "overseas", "jd_self", "official"]
 *       },
 *       "minSales": 2,                   // 最低已售
 *       "minComments": 0,                // 最低评论数
 *       "priceRange": [10, 9999],        // 价格区间
 *       "titleKeywords": {               // 标题关键词
 *         "must": [],                    // 必须包含
 *         "exclude": ["二手", "旧"]      // 必须不包含
 *       }
 *     },
 *     "taobao": {
 *       "shipFrom": "domestic",          // 国内发货
 *       "shipWithinHours": 48,           // 48小时内发货
 *       "minSales": 10,                  // 最低已售
 *       "minRating": 4.5                 // 最低评分
 *     }
 *   },
 *   "profit": {
 *     "minRate": 0.35,                   // 最低利润率
 *     "maxRate": 0.60,                   // 最高利润率（防止异常）
 *     "minAmount": 5                     // 最低利润金额
 *   }
 * }
 */

/**
 * 默认策略：无货源套利
 */
export const DEFAULT_STRATEGIES = {
  "no-source-arbitrage": {
    id: "no-source-arbitrage",
    name: "无货源套利",
    description: "京东找买手店好卖品，淘宝找国内发货货源比价",
    platforms: {
      jd: {
        shopTypes: {
          include: ["buyer"],
          exclude: ["flagship", "overseas", "jd_self", "official", "franchise", "dealer"]
        },
        minSales: 2,
        minComments: 0,
        priceRange: [10, 9999],
        titleKeywords: {
          must: [],
          exclude: ["二手", "翻新", "样品"]
        }
      },
      taobao: {
        shipFrom: "domestic",
        shipWithinHours: 48,
        minSales: 10,
        minRating: 4.5,
        priceRange: [1, 9999]
      }
    },
    profit: {
      minRate: 0.35,
      maxRate: 0.60,
      minAmount: 5
    }
  },

  "brand-quality": {
    id: "brand-quality",
    name: "品牌优品",
    description: "只要旗舰店和海外店的高质量商品",
    platforms: {
      jd: {
        shopTypes: {
          include: ["flagship", "overseas", "official"],
          exclude: []
        },
        minSales: 100,
        priceRange: [50, 99999]
      }
    },
    profit: {
      minRate: 0.20,
      maxRate: 1.00,
      minAmount: 10
    }
  },

  "low-price-hunter": {
    id: "low-price-hunter",
    name: "低价猎手",
    description: "找超低价高销量商品",
    platforms: {
      jd: {
        shopTypes: { include: [], exclude: [] },
        minSales: 1000,
        priceRange: [1, 99]
      }
    },
    profit: {
      minRate: 0.10,
      maxRate: 2.00,
      minAmount: 1
    }
  }
};

/**
 * 解析销量字符串："1万+" -> 10000, "5000+" -> 5000, "100" -> 100
 */
export function parseSalesNumber(salesStr) {
  if (!salesStr) return 0;
  const s = String(salesStr).trim();

  // 提取数字部分
  const m = s.match(/(\d+(?:\.\d+)?)\s*([万千]?)/);
  if (!m) return 0;

  const num = parseFloat(m[1]);
  const unit = m[2];

  if (unit === '万') return Math.floor(num * 10000);
  if (unit === '千') return Math.floor(num * 1000);
  return Math.floor(num);
}

/**
 * 解析价格字符串
 */
export function parsePriceNumber(priceStr) {
  if (!priceStr) return 0;
  const m = String(priceStr).match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/**
 * 用策略评估京东商品
 * @returns { passed: boolean, reason: string }
 */
export function evaluateJdProductByStrategy(product, strategy) {
  const rules = strategy?.platforms?.jd;
  if (!rules) return { passed: true, reason: "无策略" };

  // 1. 店铺类型过滤
  if (rules.shopTypes) {
    const { include = [], exclude = [] } = rules.shopTypes;

    // 必须在include里（如果指定了include）
    if (include.length > 0 && !include.includes(product.shopType)) {
      return {
        passed: false,
        reason: `店铺类型(${product.shopType})不在include列表: ${include.join(',')}`
      };
    }

    // 不能在exclude里
    if (exclude.includes(product.shopType)) {
      return {
        passed: false,
        reason: `店铺类型(${product.shopType})被exclude: ${product.shop}`
      };
    }
  }

  // 2. 销量过滤
  const salesNum = parseSalesNumber(product.sales);
  if (rules.minSales && salesNum < rules.minSales) {
    return {
      passed: false,
      reason: `销量不足: ${salesNum} < ${rules.minSales}`
    };
  }

  // 3. 价格区间
  const priceNum = parsePriceNumber(product.price);
  if (rules.priceRange) {
    const [min, max] = rules.priceRange;
    if (priceNum < min || priceNum > max) {
      return {
        passed: false,
        reason: `价格(${priceNum})不在区间[${min}-${max}]`
      };
    }
  }

  // 4. 标题关键词
  if (rules.titleKeywords) {
    const { must = [], exclude = [] } = rules.titleKeywords;
    const title = product.title || '';

    for (const kw of must) {
      if (!title.includes(kw)) {
        return { passed: false, reason: `标题缺少关键词: ${kw}` };
      }
    }

    for (const kw of exclude) {
      if (title.includes(kw)) {
        return { passed: false, reason: `标题包含禁用词: ${kw}` };
      }
    }
  }

  return { passed: true, reason: "通过策略评估" };
}

/**
 * 用策略评估淘宝商品（供货端）
 */
export function evaluateTaobaoProductByStrategy(product, strategy) {
  const rules = strategy?.platforms?.taobao;
  if (!rules) return { passed: true, reason: "无策略" };

  // 销量
  const salesNum = parseSalesNumber(product.sales);
  if (rules.minSales && salesNum < rules.minSales) {
    return { passed: false, reason: `淘宝销量不足: ${salesNum} < ${rules.minSales}` };
  }

  // 价格区间
  if (rules.priceRange) {
    const priceNum = parsePriceNumber(product.price);
    const [min, max] = rules.priceRange;
    if (priceNum < min || priceNum > max) {
      return { passed: false, reason: `淘宝价格(${priceNum})不在区间` };
    }
  }

  // 国内发货 / 发货时效（需要从详情页提取，这里只标记）
  // 由 aiExtractTaobaoDetail 后再校验

  return { passed: true, reason: "淘宝通过策略评估" };
}

/**
 * 用策略评估利润是否合规
 */
export function evaluateProfitByStrategy(jdPrice, taobaoPrice, strategy) {
  const rules = strategy?.profit;
  if (!rules) return { passed: true, reason: "无利润策略" };

  const profitAmount = jdPrice - taobaoPrice;
  const profitRate = taobaoPrice > 0 ? profitAmount / taobaoPrice : 0;

  if (rules.minAmount && profitAmount < rules.minAmount) {
    return {
      passed: false,
      profitAmount,
      profitRate,
      reason: `利润金额不足: ¥${profitAmount.toFixed(2)} < ¥${rules.minAmount}`
    };
  }

  if (rules.minRate && profitRate < rules.minRate) {
    return {
      passed: false,
      profitAmount,
      profitRate,
      reason: `利润率不足: ${(profitRate * 100).toFixed(1)}% < ${(rules.minRate * 100).toFixed(1)}%`
    };
  }

  if (rules.maxRate && profitRate > rules.maxRate) {
    return {
      passed: false,
      profitAmount,
      profitRate,
      reason: `利润率异常偏高: ${(profitRate * 100).toFixed(1)}% > ${(rules.maxRate * 100).toFixed(1)}%（淘宝价可能有问题）`
    };
  }

  return {
    passed: true,
    profitAmount,
    profitRate,
    reason: `利润率 ${(profitRate * 100).toFixed(1)}% 合规`
  };
}

/**
 * 完整策略评估（一次性走完所有规则）
 */
export function evaluateWithStrategy(jdProduct, taobaoProduct, strategy) {
  // 1. 京东商品评估
  const jdResult = evaluateJdProductByStrategy(jdProduct, strategy);
  if (!jdResult.passed) {
    return { ...jdResult, stage: "jd" };
  }

  // 2. 淘宝商品评估
  if (taobaoProduct) {
    const taobaoResult = evaluateTaobaoProductByStrategy(taobaoProduct, strategy);
    if (!taobaoResult.passed) {
      return { ...taobaoResult, stage: "taobao" };
    }

    // 3. 利润评估
    const jdPrice = parsePriceNumber(jdProduct.price);
    const taobaoPrice = parsePriceNumber(taobaoProduct.price);
    const profitResult = evaluateProfitByStrategy(jdPrice, taobaoPrice, strategy);

    return { ...profitResult, stage: "profit" };
  }

  return { passed: true, stage: "jd_only", reason: "京东端通过，未做淘宝比价" };
}
