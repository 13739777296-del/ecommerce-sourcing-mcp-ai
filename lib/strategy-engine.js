/**
 * 通用策略引擎
 *
 * 设计理念：引擎通用，规则可配。
 *
 * 策略JSON Schema：
 * {
 *   "id": "no-source-arbitrage",
 *   "name": "无货源套利",
 *   "description": "京东找买手店好卖品，淘宝找国内发货货源比价",
 *   "platforms": {
 *     "jd": {
 *       "shopTypes": {
 *         "include": ["buyer"],
 *         "exclude": ["flagship", "overseas", "jd_self", "official", "franchise", "dealer"]
 *       },
 *       "minComments": 2,
 *       "priceRange": [1, 999999]
 *     },
 *     "taobao": {
 *       "shipFrom": "domestic",
 *       "shipWithinHours": 48,
 *       "minSales": 10,
 *       "priceRange": [80, 999999]
 *     }
 *   },
 *   "profit": {
 *     "minRate": 0.35,
 *     "maxRate": 0.60,
 *     "minAmount": 20
 *   },
 *   "riskControl": {
 *     "retryAfterHours": 5,           // 遇风控等待N小时后重试
 *     "notifyOnDetection": true,      // 首次遇见风控通知用户
 *     "maxRetries": 3,                // 最多重试几次，超限放弃
 *     "bannedBrands": [               // 策略层禁售品牌，命中后不采集/不入库
 *       { "name": "斯维诗", "aliases": ["Swisse"] }
 *     ]
 *   }
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
    description: "京东找买手店好卖品，淘宝找国内发货货源比价（毛利率35%~60%，最低20元）",
    platforms: {
      jd: {
        searchSuffix: "买手店",          // 品牌词后拼接→"GNC 买手店"
        collectShopNames: true,          // 从结果页收集买手店名,逐个搜店
        shopTypes: {
          include: ["buyer"],
          exclude: ["flagship", "overseas", "jd_self", "official", "franchise", "dealer"]
        },
        minComments: 2,
        priceRange: [100, 999999]
      },
      taobao: {
        shipFrom: "domestic",
        shipWithinHours: 48,
        minSales: 10,
        priceRange: [1, 999999],
        requireBrandInTitle: true,    // 淘宝标题必须含品牌词，否则跳过（杜绝无关品）。用户可在自己的策略里关掉。
        requireAllKeywordTokens: true // 淘宝标题必须含搜索词的【每一个】关键词才进详情（严格相关性，省风控）。false=含任一即可。
      }
    },
    profit: {
      minRate: 0.35,
      maxRate: null,
      minAmount: 40
    },
    riskControl: {
      retryAfterHours: 5,
      notifyOnDetection: true,
      maxRetries: 3,
      bannedBrands: [
        { name: "斯维诗", aliases: ["Swisse"] },
        { name: "益节", aliases: ["Move Free", "MoveFree"] },
        { name: "脉拓", aliases: ["MegaRed", "MEGARED"] },
        { name: "安利", aliases: ["Amway", "AMWAY", "纽崔莱", "NUTRILITE"] },
        { name: "优必欧", aliases: ["UBIO"] },
        { name: "汤普森", aliases: ["Thompsons", "THOMPSON'S", "Thopmson's", "Thompson's"] },
        { name: "佰澳朗德", aliases: ["BioIsland", "Bio Island"] },
        { name: "澳佳宝", aliases: ["Blackmores"] }
      ]
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
  const bannedBrand = findBannedBrandMatch(product, strategy);
  if (bannedBrand) {
    return {
      passed: false,
      reason: `命中策略禁售品牌: ${bannedBrand.name}`
    };
  }

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

  // 2. 价格区间
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

  return { passed: true, reason: "通过策略评估" };
}

/**
 * 用策略评估淘宝商品（供货端）
 */
export function evaluateTaobaoProductByStrategy(product, strategy) {
  const bannedBrand = findBannedBrandMatch(product, strategy);
  if (bannedBrand) {
    return {
      passed: false,
      reason: `命中策略禁售品牌: ${bannedBrand.name}`
    };
  }

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
  const profitRate = jdPrice > 0 ? profitAmount / jdPrice : 0;

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
    const jdPrice = numericOrParsedPrice(jdProduct.unitPrice) || parsePriceNumber(jdProduct.price);
    const taobaoPrice = numericOrParsedPrice(taobaoProduct.unitPrice) || parsePriceNumber(taobaoProduct.price);
    const profitResult = evaluateProfitByStrategy(jdPrice, taobaoPrice, strategy);

    return { ...profitResult, stage: "profit" };
  }

  return { passed: true, stage: "jd_only", reason: "京东端通过，未做淘宝比价" };
}

function numericOrParsedPrice(value) {
  const numeric = typeof value === "number" ? value : parsePriceNumber(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function findBannedBrandMatch(target, strategy) {
  const bannedBrands = strategy?.riskControl?.bannedBrands;
  if (!Array.isArray(bannedBrands) || bannedBrands.length === 0) return null;

  const haystack = normalizeBannedBrandTarget(target);
  if (!haystack) return null;

  for (const item of bannedBrands) {
    const name = typeof item === "string" ? item : item?.name;
    const terms = typeof item === "string"
      ? [item]
      : [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])];
    const matchedTerm = terms
      .filter(Boolean)
      .find((term) => {
        const normalized = normalizeBannedBrandText(term);
        return normalized && haystack.includes(normalized);
      });
    if (matchedTerm) {
      return {
        name: String(name || matchedTerm),
        matchedTerm: String(matchedTerm)
      };
    }
  }

  return null;
}

function normalizeBannedBrandTarget(target) {
  if (target == null) return "";
  if (typeof target === "string") return normalizeBannedBrandText(target);
  if (typeof target !== "object") return normalizeBannedBrandText(String(target));
  return normalizeBannedBrandText([
    target.title,
    target.brand,
    target.skuInfo,
    target.skuText
  ].filter(Boolean).join(" "));
}

function normalizeBannedBrandText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s'’._\-+/\\()（）【】\[\]:：,，;；]+/g, "");
}
