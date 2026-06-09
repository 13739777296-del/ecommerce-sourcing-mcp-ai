/**
 * 最小规格单价计算器
 *
 * 用途：比较不同商品时，按最小单位（片/克/毫升）计算单价
 * 例如：
 *   - "60粒 ¥100" → 每粒 ¥1.67
 *   - "500g ¥50" → 每克 ¥0.1
 *   - "500ml ¥30" → 每毫升 ¥0.06
 */

/**
 * 从标题/SKU中提取规格
 * 支持：粒/片/袋/盒/瓶/克/毫克/升/毫升/g/mg/ml/L
 */
export function extractSpec(text) {
  if (!text) return null;

  const patterns = [
    // 数量+单位（优先级从高到低）
    { regex: /(\d+(?:\.\d+)?)\s*(粒|片|袋|包|盒|瓶|罐|支|条|个|枚)/, type: 'count', units: ['粒', '片', '袋', '包', '盒', '瓶', '罐', '支', '条', '个', '枚'] },
    { regex: /(\d+(?:\.\d+)?)\s*(毫克|mg)/i, type: 'weight', unit: 'mg', factor: 1 },
    { regex: /(\d+(?:\.\d+)?)\s*(克|g)/i, type: 'weight', unit: 'g', factor: 1000 },  // 1g = 1000mg
    { regex: /(\d+(?:\.\d+)?)\s*(千克|kg)/i, type: 'weight', unit: 'g', factor: 1000 },  // 转为克
    { regex: /(\d+(?:\.\d+)?)\s*(毫升|ml)/i, type: 'volume', unit: 'ml', factor: 1 },
    { regex: /(\d+(?:\.\d+)?)\s*(升|l)/i, type: 'volume', unit: 'ml', factor: 1000 },  // 1L = 1000ml
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const value = parseFloat(match[1]);
      if (pattern.type === 'count') {
        const unit = match[2];
        return {
          type: 'count',
          value,
          unit,
          standardUnit: unit,  // 数量类直接用原单位
          standardValue: value
        };
      } else {
        return {
          type: pattern.type,
          value,
          unit: pattern.unit,
          standardUnit: pattern.unit,
          standardValue: value * (pattern.factor || 1)
        };
      }
    }
  }

  return null;
}

/**
 * 计算最小规格单价
 * @param price 总价
 * @param title 标题（含规格）
 * @param skuText SKU文本（可选，更准确）
 * @returns { unitPrice: number, unit: string, spec: object }
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
  const taobao = calculateUnitPrice(taobaoProduct.price, taobaoProduct.title, '');

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
  const profitRate = taobao.unitPrice > 0 ? profit / taobao.unitPrice : 0;

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
