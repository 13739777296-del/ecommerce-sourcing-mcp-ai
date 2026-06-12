/**
 * 最小规格单价计算器
 *
 * 用途：比较不同商品时，按最小单位（片/克/毫升）计算单价
 * 例如：
 *   - "60粒 ¥100" → 每粒 ¥1.67
 *   - "500g ¥50" → 每克 ¥0.1
 *   - "500ml ¥30" → 每毫升 ¥0.06
 */

const CONTENT_COUNT_UNITS = ["粒", "片", "颗", "丸", "枚"];
const PACKAGE_UNITS = ["瓶", "盒", "罐", "袋", "包", "支", "条", "个", "件"];

/**
 * 从标题/SKU中提取规格。
 *
 * 保健品标题里经常同时出现剂量和数量，例如「150mg 60粒」。
 * 比价时应该优先按内容数量（粒/片/颗）换算，而不是把 150mg 当成整瓶重量。
 */
export function extractSpec(text) {
  if (!text) return null;
  const normalized = normalizeSpecText(text);

  const countSpec = extractContentCountSpec(normalized);
  if (countSpec) return countSpec;

  const volumeSpec = extractVolumeSpec(normalized);
  if (volumeSpec) return volumeSpec;

  const weightSpec = extractWeightSpec(normalized);
  if (weightSpec) return weightSpec;

  const packageSpec = extractPackageSpec(normalized);
  if (packageSpec) return packageSpec;

  return null;
}

/**
 * 计算最小规格单价
 * @param price 总价
 * @param title 标题（含规格）
 * @param skuText SKU文本（可选，更准确）
 * @returns {{ unitPrice: number|null, unit: string|null, spec: object|null, reason?: string, formula?: string }}
 */
export function calculateUnitPrice(price, title, skuText = '') {
  const priceNum = typeof price === 'number' ? price : parseFloat(String(price).replace(/[^0-9.]/g, ''));
  if (!priceNum || priceNum <= 0) {
    return { unitPrice: null, unit: null, spec: null, reason: '价格无效' };
  }

  // 优先从SKU提取，更准确
  const fullText = skuText ? `${skuText} ${title}` : title;
  const spec = extractSpec(fullText);

  if (!spec) {
    return { unitPrice: null, unit: null, spec: null, reason: '未找到规格' };
  }

  // 计算单价
  const unitPrice = priceNum / spec.standardValue;

  return {
    unitPrice: Math.round(unitPrice * 10000) / 10000,  // 保留4位小数
    unit: spec.standardUnit,
    spec,
    formula: `¥${priceNum} / ${spec.standardValue}${spec.standardUnit} = ¥${unitPrice.toFixed(4)}/${spec.standardUnit}`
  };
}

/**
 * 比较两个商品的单价
 * 返回：{ canCompare: boolean, jdUnitPrice, taobaoUnitPrice, difference, reason }
 */
export function compareUnitPrice(jdProduct, taobaoProduct) {
  const jd = calculateUnitPrice(jdProduct.price, jdProduct.title, jdProduct.skuInfo);
  const taobao = calculateUnitPrice(taobaoProduct.price, taobaoProduct.title, taobaoProduct.skuInfo || taobaoProduct.skuText || '');

  // 单位不同，无法比较
  if (jd.unit !== taobao.unit) {
    return {
      canCompare: false,
      jd,
      taobao,
      reason: `单位不同：京东(${jd.unit}) vs 淘宝(${taobao.unit})`
    };
  }

  // 都没有规格
  if (!jd.unit && !taobao.unit) {
    return {
      canCompare: false,
      jd,
      taobao,
      reason: '两边都未找到规格'
    };
  }

  // 可以比较
  const difference = jd.unitPrice - taobao.unitPrice;
  const profit = jd.unitPrice - taobao.unitPrice;
  const profitRate = jd.unitPrice > 0 ? profit / jd.unitPrice : 0;

  return {
    canCompare: true,
    jd,
    taobao,
    difference,
    profit,
    profitRate,
    summary: `京东 ¥${jd.unitPrice.toFixed(4)}/${jd.unit} vs 淘宝 ¥${taobao.unitPrice.toFixed(4)}/${taobao.unit}，利润率 ${(profitRate * 100).toFixed(1)}%`
  };
}

/**
 * 批量计算（用于列表）
 */
export function batchCalculateUnitPrice(products) {
  return products.map(p => {
    const result = calculateUnitPrice(p.price, p.title, p.skuInfo || '');
    return {
      ...p,
      unitPrice: result.unitPrice,
      unit: result.unit,
      spec: result.spec
    };
  });
}

function normalizeSpecText(text) {
  return String(text)
    .replace(/[×Xx]/g, "*")
    .replace(/[，,、；;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractContentCountSpec(text) {
  const unitPattern = CONTENT_COUNT_UNITS.join("|");
  const matches = [...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})(?![a-zA-Z])`, "g"))]
    .map((match) => ({
      value: Number(match[1]),
      unit: match[2],
      index: match.index ?? 0,
      text: match[0]
    }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0);
  if (!matches.length) return null;

  const content = chooseContentMatch(matches);
  const multiplier = packageMultiplierAfter(text, content.index + content.text.length) || lastPackageCount(text) || 1;
  const standardValue = content.value * multiplier;
  return {
    type: "count",
    value: content.value,
    unit: content.unit,
    packageCount: multiplier,
    standardUnit: content.unit,
    standardValue,
    raw: text
  };
}

function extractPackageSpec(text) {
  const count = lastPackageCount(text);
  if (!count) return null;
  const unit = [...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${PACKAGE_UNITS.join("|")})(?![a-zA-Z])`, "g"))].at(-1)?.[2] || "件";
  return {
    type: "package",
    value: count,
    unit,
    standardUnit: unit,
    standardValue: count,
    raw: text
  };
}

function extractWeightSpec(text) {
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*(千克|公斤|kg)/i, toStandard: (value) => value * 1000, unit: "g" },
    { regex: /(\d+(?:\.\d+)?)\s*(克|g)(?![a-zA-Z一-龥])/i, toStandard: (value) => value, unit: "g" },
    { regex: /(\d+(?:\.\d+)?)\s*(毫克|mg)/i, toStandard: (value) => value / 1000, unit: "g" }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const value = Number(match[1]);
    const packageCount = lastPackageCount(text) || 1;
    return {
      type: "weight",
      value,
      unit: match[2],
      packageCount,
      standardUnit: pattern.unit,
      standardValue: pattern.toStandard(value) * packageCount,
      raw: text
    };
  }
  return null;
}

function extractVolumeSpec(text) {
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*(升|l)(?![a-zA-Z一-龥])/i, toStandard: (value) => value * 1000, unit: "ml" },
    { regex: /(\d+(?:\.\d+)?)\s*(毫升|ml)/i, toStandard: (value) => value, unit: "ml" }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const value = Number(match[1]);
    const packageCount = lastPackageCount(text) || 1;
    return {
      type: "volume",
      value,
      unit: match[2],
      packageCount,
      standardUnit: pattern.unit,
      standardValue: pattern.toStandard(value) * packageCount,
      raw: text
    };
  }
  return null;
}

function chooseContentMatch(matches) {
  return [...matches].sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return b.index - a.index;
  })[0];
}

function packageMultiplierAfter(text, startIndex) {
  const after = text.slice(startIndex, startIndex + 16);
  const match = after.match(new RegExp(`^\\s*(?:[/每一]?\\s*)?(?:\\*\\s*)?(\\d+(?:\\.\\d+)?)\\s*(${PACKAGE_UNITS.join("|")})(?![a-zA-Z])`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function lastPackageCount(text) {
  const matches = [...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${PACKAGE_UNITS.join("|")})(?![a-zA-Z])`, "g"))]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return matches.at(-1) || null;
}
