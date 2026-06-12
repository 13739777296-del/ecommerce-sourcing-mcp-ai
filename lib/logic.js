const PACKAGE_UNITS = ["瓶", "盒", "罐", "袋", "件"];
const CONTENT_UNITS = ["粒", "片", "颗", "支", "袋"];
const COUNT_UNITS = new Set(["粒", "片", "颗"]);
const GENERIC_PRODUCT_FAMILIES = new Set(["vitamin_c", "vitamin_general"]);

const PRODUCT_FAMILY_DEFINITIONS = [
  { id: "coq10", label: "辅酶 Q10", pattern: /还原型辅酶q?10|辅酶q?10|coq10|q10/i },
  { id: "nad", label: "NAD", pattern: /nad\+?/i },
  { id: "pqq", label: "PQQ", pattern: /pqq/i },
  { id: "fish_oil", label: "鱼油", pattern: /鱼油|深海鱼油|dha|epa/i },
  { id: "propolis", label: "蜂胶", pattern: /蜂胶|propolis/i },
  { id: "probiotic", label: "益生菌", pattern: /益生菌|乳酸菌|双歧杆菌|菌群/i },
  { id: "milk_thistle_liver", label: "奶蓟草/水飞蓟护肝", pattern: /奶蓟草|水飞蓟|护肝|护旰|肝护|养肝|净肝|保肝|解酒|胆碱|姜黄|洋蓟/i },
  { id: "lutein", label: "叶黄素护眼", pattern: /叶黄素|越橘|玉米黄质|护眼|蓝莓叶黄素/i },
  { id: "lung_support", label: "养肺/呼吸健康", pattern: /养肺|护肺|润肺|清肺|肺片|呼吸健康|支气管/i },
  { id: "lecithin", label: "卵磷脂", pattern: /卵磷脂|软磷脂|lecithin/i },
  { id: "grape_seed", label: "葡萄籽", pattern: /葡萄籽|grape\s*seed|原花青素/i },
  { id: "memory_ginkgo", label: "记忆力/银杏", pattern: /记忆力|银杏|银杏叶|ginkgo/i },
  { id: "chasteberry", label: "圣洁莓/月经调理", pattern: /圣洁莓|月经|经期|内分泌|卵巢|促排卵|chasteberry|vitex/i },
  { id: "collagen", label: "胶原蛋白", pattern: /胶原蛋白|collagen/i },
  { id: "plant_sterol", label: "植物固醇", pattern: /植物固醇|固醇胶囊|plant\s*sterol/i },
  { id: "nmn", label: "NMN", pattern: /\bnmn\b|烟酰胺单核苷酸/i },
  { id: "calcium", label: "钙", pattern: /液体钙|钙镁锌|柠檬酸钙|碳酸钙|钙片|\bcalcium\b/i },
  { id: "magnesium", label: "镁", pattern: /镁片|甘氨酸镁|magnesium/i },
  { id: "glucosamine", label: "氨糖", pattern: /氨糖|氨基葡萄糖|软骨素|glucosamine/i },
  { id: "melatonin", label: "褪黑素", pattern: /褪黑素|melatonin/i },
  { id: "hyaluronic", label: "透明质酸", pattern: /透明质酸|玻尿酸|hyaluronic/i },
  { id: "vitamin_d", label: "维生素 D", pattern: /维生素d3?|vd3?\b|vitamin\s*d/i },
  { id: "vitamin_b", label: "B族维生素", pattern: /b族维生素|复合维生素b|维生素b\d*|vitamin\s*b/i },
  { id: "vitamin_c", label: "维生素 C", pattern: /维生素c|维c|vc\b|vitamin\s*c|泡腾片/i },
  { id: "vitamin_general", label: "复合维生素", pattern: /复合维生素|多种维生素|维生素[abdek0-9]+|multivitamin/i }
];

export const DEFAULT_STRATEGY = Object.freeze({
  jdPages: 1,
  minJdComments: 2,
  minTaobaoSales: 10,
  requireDomesticShipping: true,
  requireFastShippingHours: 48,
  maxJdCandidates: 1,
  maxTaobaoSearches: 1,
  maxTaobaoKeywordAttempts: 1
});

export function sanitizeStrategy(input = {}) {
  return {
    jdPages: clampInteger(input.jdPages, 1, 5, DEFAULT_STRATEGY.jdPages),
    minJdComments: Math.max(2, clampInteger(input.minJdComments, 0, 999999, DEFAULT_STRATEGY.minJdComments)),
    minTaobaoSales: Math.max(10, clampInteger(input.minTaobaoSales, 0, 999999, DEFAULT_STRATEGY.minTaobaoSales)),
    requireDomesticShipping: typeof input.requireDomesticShipping === "boolean" ? input.requireDomesticShipping : DEFAULT_STRATEGY.requireDomesticShipping,
    requireFastShippingHours: clampInteger(input.requireFastShippingHours, 1, 168, DEFAULT_STRATEGY.requireFastShippingHours),
    maxJdCandidates: clampInteger(input.maxJdCandidates, 1, 10, DEFAULT_STRATEGY.maxJdCandidates),
    maxTaobaoSearches: clampInteger(input.maxTaobaoSearches, 1, 10, DEFAULT_STRATEGY.maxTaobaoSearches),
    maxTaobaoKeywordAttempts: clampInteger(input.maxTaobaoKeywordAttempts, 1, 5, DEFAULT_STRATEGY.maxTaobaoKeywordAttempts)
  };
}

export function parseSkuProfile(text = "") {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const packageMatch = findLastQuantity(normalized, PACKAGE_UNITS);
  const contentMatch = findFirstQuantity(normalized, CONTENT_UNITS);
  const packageCount = packageMatch?.count ?? 1;
  const contentCount = contentMatch ? contentMatch.count * packageCount : null;
  return {
    raw: normalized,
    packageCount,
    packageUnit: packageMatch?.unit ?? null,
    contentCount,
    contentUnit: contentMatch?.unit ?? null
  };
}

export function unitPrice(totalPrice, sku) {
  const denominator = sku.packageCount > 1 ? sku.packageCount : 1;
  return roundMoney(totalPrice / denominator);
}

export function assessProfit(input, strategy = {}) {
  const profitAmount = roundMoney(input.jdUnitPrice - input.taobaoUnitPrice);
  const profitRate = input.jdUnitPrice > 0 ? roundRate(profitAmount / input.jdUnitPrice) : 0;
  const profitRules = strategy.profit || strategy || {};
  const minRate = numberOrDefault(input.minRate ?? profitRules.minRate, 0.35);
  const maxRate = numberOrDefault(input.maxRate ?? profitRules.maxRate, 0.60);
  const minAmount = numberOrDefault(input.minAmount ?? profitRules.minAmount, 0);

  if (profitAmount < minAmount) {
    return { qualified: false, rule: "amount", profitAmount, profitRate, reason: `单件利润不足 ${minAmount} 元` };
  }
  if (profitRate < minRate) {
    return { qualified: false, rule: "rate", profitAmount, profitRate, reason: `利润率不足 ${(minRate * 100).toFixed(0)}%` };
  }
  if (profitRate > maxRate) {
    return { qualified: false, rule: "rate", profitAmount, profitRate, reason: `利润率超过 ${(maxRate * 100).toFixed(0)}%，淘宝价可能异常` };
  }
  return { qualified: true, rule: "rate", profitAmount, profitRate, reason: `利润率 ${(profitRate * 100).toFixed(1)}%，达标` };
}

export function buildTaobaoSearchKeyword({ brand, title }) {
  const normalizedBrand = String(brand || "").trim();
  const productTokens = extractProductTokens(title);
  const meaningfulTokens = productTokens.filter((token) => !isDosageFormToken(token));
  if (meaningfulTokens.length > 0) {
    return [normalizedBrand, ...productTokens]
      .filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 5)
      .join(" ");
  }
  const normalizedTitle = String(title || "")
    .replace(/\d+(?:\.\d+)?\s*(?:mg|g|kg|ml|l|毫克|克|千克|毫升|升)\b/gi, " ")
    .replace(/\d+\s*(?:粒|片|颗|瓶|盒|罐|袋|件)(?:\s*[*xX×]\s*\d+\s*(?:粒|片|颗|瓶|盒|罐|袋|件))?/g, " ")
    .replace(/[【】\[\]()（）]/g, " ")
    .replace(/[:：*※·,，;；]/g, " ")
    .replace(/强化装|组合装|囤货装|家庭装|优惠装|买一送一|新老包装随机|官方|旗舰店|正品|营养液|进口/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [brand, normalizedTitle]
    .filter(Boolean)
    .join(" ")
    .split(/\s+/)
    .filter((part, index, all) => all.indexOf(part) === index)
    .slice(0, 6)
    .join(" ");
}

export function buildTaobaoSearchKeywords({ brand, title }) {
  const primary = buildTaobaoSearchKeyword({ brand, title });
  const productTokens = extractProductTokens(title);
  const aliases = extractChineseBrandAliases(title);
  const compactProduct = productTokens.filter((token) => !/^(?:软胶囊|胶囊|片|颗粒)$/.test(token)).join(" ");
  const productDescriptor = extractProductDescriptor(title, compactProduct);
  const formToken = productTokens.find((token) => /软胶囊|胶囊|片|颗粒/.test(token)) || "";
  const genericProduct = compactProduct
    .replace(/还原型/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const hasBrand = Boolean(String(brand || "").trim());
  const brandedCandidates = [
    primary,
    ...aliases.map((alias) => [brand, alias, compactProduct].filter(Boolean).join(" ")),
    [brand, productDescriptor].filter(Boolean).join(" "),
    [brand, compactProduct].filter(Boolean).join(" "),
    [brand, genericProduct, formToken].filter(Boolean).join(" "),
    ...aliases.map((alias) => [alias, compactProduct, formToken].filter(Boolean).join(" "))
  ];
  const unbrandedFallbacks = [
    [compactProduct, formToken].filter(Boolean).join(" "),
    [genericProduct, formToken].filter(Boolean).join(" ")
  ];
  const candidates = hasBrand ? brandedCandidates : [...brandedCandidates, ...unbrandedFallbacks];
  return candidates
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 6);
}

function extractProductTokens(title = "") {
  const normalized = String(title).replace(/\s+/g, " ");
  const tokens = [];
  const patterns = [
    /还原型辅酶\s*q\s*10/i,
    /辅酶\s*q\s*10/i,
    /coq10/i,
    /q10/i,
    /NAD\+?/i,
    /PQQ/i,
    /α-?硫辛酸|阿尔法α-?硫辛酸|硫辛酸|alpha[-\s]*lipoic\s*acid|lipoic\s*acid/i,
    /β-?葡聚糖|葡聚糖/i,
    /超活代谢/,
    /燃烧脂肪/,
    /新陈代谢|体重管理/,
    /白藜芦醇/,
    /鱼油/,
    /蜂胶/,
    /益生菌/,
    /水飞蓟|奶蓟草/,
    /护肝片|肝护片|养肝片|净肝片/,
    /胆碱/,
    /姜黄/,
    /养肺片|护肺片|润肺片|养肺|护肺|润肺|呼吸健康/,
    /叶黄素/,
    /葡萄籽|原花青素|烟酰胺/,
    /卵磷脂|软磷脂/,
    /记忆力|银杏叶|银杏/,
    /圣洁莓|月经|经期|内分泌|卵巢|促排卵/,
    /液体钙|钙镁锌|柠檬酸钙|碳酸钙|钙片|钙/,
    /氨基葡萄糖|氨糖|软骨素/,
    /褪黑素/,
    /透明质酸|玻尿酸/,
    /胶原蛋白/,
    /维生素\s*d3?|vd3?\b/i,
    /b族维生素|复合维生素b|维生素\s*b\d*/i,
    /维生素\s*[A-Z0-9]+/i,
    /软胶囊|胶囊|片|颗粒/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    let token = match[0].replace(/\s+/g, "");
    if (/硫辛酸|lipoic/i.test(token)) token = "硫辛酸";
    if (/葡聚糖/i.test(token)) token = "葡聚糖";
    if (/液体钙|钙镁锌|柠檬酸钙|碳酸钙|钙片|钙/.test(token)) {
      token = /液体钙/.test(normalized) ? "液体钙" : /钙镁锌/.test(normalized) ? "钙镁锌" : "钙";
    }
    if (/氨基葡萄糖|氨糖/.test(token)) token = "氨糖";
    if (tokens.some((existing) => existing.toLowerCase().includes(token.toLowerCase()))) continue;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (token.toLowerCase().includes(tokens[index].toLowerCase())) tokens.splice(index, 1);
    }
    tokens.push(token);
  }
  return tokens;
}

function isDosageFormToken(token = "") {
  return /^(?:软胶囊|胶囊|片|颗粒)$/.test(String(token || "").trim());
}

function extractProductDescriptor(title = "", compactProduct = "") {
  const text = String(title || "").replace(/\s+/g, "");
  const descriptors = [
    /深海鱼油/,
    /磷虾油/,
    /还原型辅酶\s*q\s*10/i,
    /辅酶\s*q\s*10/i,
    /β-?葡聚糖|葡聚糖/i,
    /超活代谢/,
    /燃烧脂肪/,
    /新陈代谢|体重管理/,
    /白藜芦醇/,
    /水飞蓟|奶蓟草/,
    /护肝片|肝护片|养肝片|净肝片/,
    /α-?硫辛酸|阿尔法α-?硫辛酸|硫辛酸|alpha[-\s]*lipoic\s*acid|lipoic\s*acid/i,
    /叶黄素/,
    /葡萄籽|原花青素/,
    /益生菌/,
    /蜂胶/,
    /卵磷脂|软磷脂/
  ];
  for (const pattern of descriptors) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match[0].replace(/\s+/g, "");
    if (/硫辛酸|lipoic/i.test(value)) return "硫辛酸";
    if (/辅酶|q10/i.test(value)) return "辅酶Q10";
    if (/葡聚糖/i.test(value)) return "葡聚糖";
    return value;
  }
  return compactProduct;
}

function extractChineseBrandAliases(title = "") {
  const normalized = String(title).replace(/\s+/g, "");
  const aliases = [];
  const beforeForm = [...normalized.matchAll(/([\u4e00-\u9fa5]{2,6})(?=软?胶囊|片|颗粒|保健品)/g)]
    .map((match) => match[1].replace(/软$/, ""))
    .filter((item) => isUsefulChineseBrandAlias(item));
  aliases.push(...beforeForm);
  const branded = normalized.match(/[A-Za-z][A-Za-z0-9+.-]{1,20}([\u4e00-\u9fa5]{2,6})/);
  if (branded?.[1] && isUsefulChineseBrandAlias(branded[1])) aliases.push(branded[1]);
  return aliases.filter((item, index, all) => all.indexOf(item) === index).slice(0, 3);
}

function isUsefulChineseBrandAlias(alias = "") {
  const text = String(alias || "").trim();
  if (!text) return false;
  return !/辅酶|还原型|维生素|保健品|健康|活力|心肌|心脏|脑血管|美国|原装|进口|本土|海外|全球|跨境|澳洲|澳大利亚|加拿大|德国|法国|西班牙|丹麦|英国|日本|新西兰|香港|水溶性|鱼油|深海|浓缩|护眼|护肝|养肝|奶蓟|水飞蓟|姜黄|益生菌|蜂胶|蛋白|叶黄素|葡萄籽|烟酰胺|卵磷脂|软磷脂|胆碱|氨糖|骨胶原|胶原|软骨素|褪黑素|葡聚糖|白藜芦醇|燃烧脂肪|超活代谢|新陈代谢|体重管理/.test(text);
}

export function extractBrand(title = "") {
  return String(title).match(/[A-Za-z][A-Za-z0-9+.-]{1,20}/)?.[0] ?? String(title).match(/^[\u4e00-\u9fa5]{2,6}/)?.[0] ?? "";
}

export function resolveBrandForTaobao(product = {}, fallbackBrand = "") {
  const candidates = [
    product.matchedBrand,
    product.brand,
    extractBrand(product.title || ""),
    fallbackBrand
  ];
  for (const item of candidates) {
    const brand = cleanResolvedBrand(item);
    if (brand && !isGenericResolvedBrand(brand)) return brand;
  }
  return "";
}

function cleanResolvedBrand(value = "") {
  const text = String(value || "").trim();
  const englishInParentheses = text.match(/[（(]\s*([A-Za-z][A-Za-z0-9&.\-\s]{2,40})\s*[）)]/);
  if (englishInParentheses?.[1]) return englishInParentheses[1].replace(/\s+/g, " ").trim();
  return text
    .replace(/买手店/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericResolvedBrand(value = "") {
  const text = String(value || "").trim();
  if (!text) return true;
  const normalized = normalizeSearchText(text);
  if (/^(?:other|others|unknown|misc|nobrand|generic|其他|其它|无品牌)$/.test(normalized)) return true;
  if (/[A-Za-z]/.test(text)) return isGenericBrandToken(text);
  return /鱼油|深海|浓缩|护肝|肝片|胶囊|软胶囊|维生素|辅酶|蛋白|营养|进口|原装|美国|澳洲|德国|法国|加拿大|日本|香港/.test(text);
}

export function jdRejectReason(product, strategy) {
  if (!product.isBuyerStore) return "不是买手店商品";
  if ((product.commentCount ?? 0) < strategy.minJdComments) return `京东评论数不足 ${strategy.minJdComments}`;
  if (product.price <= 0) return "未识别到京东价格";
  return "";
}

export function taobaoRejectReason(product, strategy) {
  if (product.coreProductMatched === false) return "淘宝标题缺少核心品名";
  if ((product.relevanceScore ?? 0) < 2) return "淘宝标题与京东商品不匹配";
  if ((product.salesCount ?? 0) < strategy.minTaobaoSales) return `淘宝销量不足 ${strategy.minTaobaoSales}`;
  if (strategy.requireDomesticShipping && product.domesticShipping !== true) return "不是国内发货";
  if ((product.shippingHours ?? 999) > strategy.requireFastShippingHours) return `不满足 ${strategy.requireFastShippingHours} 小时内发货`;
  if (product.price <= 0) return "未识别到淘宝价格";
  return "";
}

export function evaluateJdCandidates(products, strategy) {
  return products.filter((item) => !jdRejectReason(item, strategy)).sort((a, b) => a.unitPrice - b.unitPrice);
}

export function evaluateTaobaoCandidates(products, strategy) {
  return products.filter((item) => !taobaoRejectReason(item, strategy)).sort((a, b) => a.unitPrice - b.unitPrice);
}

export function assessSameProductMatch(jdProduct = {}, taobaoProduct = {}, keyword = "") {
  const jdText = productSearchText(jdProduct);
  const taobaoText = productSearchText(taobaoProduct);
  const keywordText = String(keyword || "");
  const jdFamilies = productFamilies(`${jdText} ${keywordText}`);
  const taobaoFamilies = productFamilies(taobaoText);
  const jdRequired = primaryFamilies(jdFamilies);
  const taobaoRequired = primaryFamilies(taobaoFamilies);
  const sharedRequired = jdRequired.filter((family) => taobaoRequired.includes(family));
  const sharedAny = jdFamilies.filter((family) => taobaoFamilies.includes(family));

  if (jdRequired.length > 0 && taobaoRequired.length > 0 && sharedRequired.length === 0) {
    return sameProductResult(false, 0.12, `品类不一致：京东是${familyLabels(jdRequired)}，淘宝是${familyLabels(taobaoRequired)}`, jdFamilies, taobaoFamilies, false);
  }
  if (jdRequired.length > 0 && taobaoRequired.length === 0) {
    return sameProductResult(false, 0.2, `淘宝未识别到对应核心品类：京东是${familyLabels(jdRequired)}`, jdFamilies, taobaoFamilies, false);
  }
  if (jdRequired.length === 0 && taobaoRequired.length > 0) {
    return sameProductResult(false, 0.2, `京东未识别到对应核心品类，淘宝是${familyLabels(taobaoRequired)}`, jdFamilies, taobaoFamilies, false);
  }
  if (jdFamilies.length > 0 && taobaoFamilies.length > 0 && sharedAny.length === 0) {
    return sameProductResult(false, 0.18, `品类不一致：京东是${familyLabels(jdFamilies)}，淘宝是${familyLabels(taobaoFamilies)}`, jdFamilies, taobaoFamilies, false);
  }

  const brandReview = assessBrandCompatibility(jdProduct, taobaoProduct);
  if (!brandReview.compatible) {
    return sameProductResult(false, 0.18, brandReview.reason, jdFamilies, taobaoFamilies, false);
  }

  const skuReview = assessSkuCompatibility(jdProduct, taobaoProduct);
  if (!skuReview.compatible) {
    return sameProductResult(false, 0.28, skuReview.reason, jdFamilies, taobaoFamilies, false);
  }

  const keywordMatched = coreProductMatched(taobaoProduct.title || "", keyword);
  const keywordScore = relevanceScore(taobaoProduct.title || "", keyword);
  if (jdFamilies.length === 0 && taobaoFamilies.length === 0 && (!keywordMatched || keywordScore < 2)) {
    return sameProductResult(false, 0.22, "同款复核失败：标题缺少可确认的核心品名", jdFamilies, taobaoFamilies, skuReview.compatible);
  }

  const brandBonus = brandReview.strong || sharedBrand(jdText, taobaoText) ? 0.12 : 0;
  const familyBonus = sharedRequired.length > 0 ? 0.55 : sharedAny.length > 0 ? 0.45 : 0.25;
  const skuBonus = skuReview.strong ? 0.15 : 0.06;
  const confidence = Math.min(0.96, familyBonus + brandBonus + skuBonus + Math.min(keywordScore, 3) * 0.04);
  const familyReason = sharedAny.length > 0 ? `同品类：${familyLabels(sharedAny)}` : "同款标题相关性通过";
  return sameProductResult(true, confidence, `${familyReason}；${skuReview.reason}`, jdFamilies, taobaoFamilies, skuReview.compatible);
}

export function taobaoSelectedSkuRejectReason(keyword = "", selectedSkuOptions = []) {
  const skuText = Array.isArray(selectedSkuOptions)
    ? selectedSkuOptions.join(" ")
    : String(selectedSkuOptions || "");
  if (!skuText.trim()) return "";

  const keywordFamilies = primaryFamilies(productFamilies(keyword));
  const skuFamilies = primaryFamilies(productFamilies(skuText));
  if (!keywordFamilies.length || !skuFamilies.length) return "";

  const shared = keywordFamilies.filter((family) => skuFamilies.includes(family));
  if (shared.length) return "";

  return `选中SKU品类不一致：搜索词是${familyLabels(keywordFamilies)}，SKU是${familyLabels(skuFamilies)}`;
}

export function parsePrice(text = "") {
  const normalized = String(text).replace(/,/g, "");
  const compact = normalized.replace(/\s+/g, "");
  const matches = [...compact.matchAll(/(?:¥|￥)(\d+(?:\.\d{1,2})?)/g)];
  if (matches.length > 0) return Number(matches[0][1]);
  const plain = compact.match(/^(\d+(?:\.\d{1,2})?)$/);
  if (plain) return Number(plain[1]);
  const contextual = normalized.match(/(?:到手价|券后价|售价|价格)\D{0,8}(\d+(?:\.\d{1,2})?)/);
  return contextual ? Number(contextual[1]) : 0;
}

export function parseCommentCount(text = "") {
  const normalized = String(text).replace(/,/g, "").replace(/\s+/g, "");
  const plain = normalized.match(/^(\d+(?:\.\d+)?)(万)?\+?$/);
  if (plain) {
    const value = Number(plain[1]);
    return plain[2] ? Math.round(value * 10000) : value;
  }
  const match =
    normalized.match(/(\d+(?:\.\d+)?)\s*(万)?\+?\s*(?:条|人)?(?:评价|评论)/) ||
    normalized.match(/(?:评价|评论)\D{0,8}(\d+(?:\.\d+)?)\s*(万)?\+?/);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] ? Math.round(value * 10000) : value;
}

export function parseSalesCount(text = "") {
  const normalized = String(text).replace(/,/g, "").replace(/\s+/g, " ");
  const prefixed = normalized.match(/(?:月销|已售|销量)\D{0,8}(\d+(?:\.\d+)?)\s*(万)?\s*\+?/);
  if (prefixed) {
    const value = Number(prefixed[1]);
    return prefixed[2] ? Math.round(value * 10000) : value;
  }
  const payer = normalized.match(/(^|[^\d.])(\d+(?:\.\d+)?)\s*(万)?\s*\+?\s*(?:人付款|付款|已售)/);
  if (!payer) return 0;
  const value = Number(payer[2]);
  return payer[3] ? Math.round(value * 10000) : value;
}

export function parseShippingHours(text = "") {
  const normalized = String(text).replace(/\s+/g, "");
  if (/预售|定金|预约|缺货|补货/.test(normalized)) return 999;
  if (/7天|七天/.test(normalized)) return 168;
  if (/3天|三天|72小时/.test(normalized)) return 72;
  if (/48小时后/.test(normalized)) return 72;
  if (/24小时|当天|当日|次日/.test(normalized)) return 24;
  if (/48小时/.test(normalized)) return 48;
  return 48;
}

export function relevanceScore(title = "", keyword = "") {
  const normalizedTitle = String(title).toLowerCase();
  return extractSearchTokens(keyword).filter((token) => normalizedTitle.includes(token)).length;
}

export function coreProductMatched(title = "", keyword = "") {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedKeyword = normalizeSearchText(keyword);
  const groups = [
    ["辅酶q10", "coq10", "q10"],
    ["nad"],
    ["pqq"],
    ["鱼油", "dha", "epa"],
    ["蜂胶", "propolis"],
    ["益生菌"],
    ["水飞蓟", "奶蓟草"],
    ["护肝", "护旰", "肝护", "养肝", "净肝", "胆碱", "姜黄"],
    ["叶黄素"],
    ["养肺", "护肺", "润肺", "呼吸"],
    ["葡萄籽", "原花青素"],
    ["卵磷脂", "软磷脂"],
    ["记忆力", "银杏"],
    ["圣洁莓", "月经", "经期", "内分泌", "卵巢", "促排卵"],
    ["液体钙", "钙镁锌", "柠檬酸钙", "碳酸钙", "钙片", "钙"],
    ["氨糖", "氨基葡萄糖", "软骨素"],
    ["褪黑素"],
    ["透明质酸", "玻尿酸"],
    ["胶原蛋白"],
    ["维生素"]
  ];
  const requiredGroups = groups.filter((group) => group.some((token) => normalizedKeyword.includes(token)));
  if (requiredGroups.length === 0) return true;
  return requiredGroups.every((group) => group.some((token) => normalizedTitle.includes(token)));
}

export function normalizeImageUrl(url = "") {
  const trimmed = String(url).trim();
  if (!trimmed || trimmed.startsWith("data:")) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

export function normalizeProductUrl(url = "", platform) {
  if (!String(url).trim()) return "";
  const normalized = String(url).startsWith("//") ? `https:${url}` : String(url);
  if (platform === "jd") {
    const sku = normalized.match(/^\d+$/)?.[0] ?? jdProductIdFromUrl(normalized);
    return sku ? `https://item.jd.com/${sku}.html` : normalized;
  }
  const id = taobaoProductId(normalized);
  if (!id) return normalized;
  const host = normalized.includes("tmall.com") ? "detail.tmall.com" : "item.taobao.com";
  return `https://${host}/item.htm?id=${id}`;
}

export function jdProductIdFromUrl(url = "") {
  const normalized = String(url).startsWith("//") ? `https:${url}` : String(url);
  const sku = normalized.match(/item\.jd\.com\/(\d+)\.html/)?.[1];
  if (sku) return sku;
  try {
    return new URL(normalized).searchParams.get("pid") ?? "";
  } catch {
    return "";
  }
}

export function taobaoProductId(url = "") {
  try {
    const parsed = new URL(String(url).startsWith("//") ? `https:${url}` : String(url));
    return parsed.searchParams.get("id") ?? "";
  } catch {
    return "";
  }
}

export function dedupeByProductId(products) {
  const map = new Map();
  for (const product of products) {
    const existing = map.get(product.productId);
    if (!existing || product.unitPrice < existing.unitPrice) map.set(product.productId, product);
  }
  return [...map.values()];
}

export function summarizeRejectReasons(reasons) {
  const counts = new Map();
  for (const reason of reasons.filter(Boolean)) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} ${count} 个`)
    .join("，");
}

function extractSearchTokens(keyword = "") {
  const normalized = normalizeSearchText(keyword);
  const tokens = new Set();
  for (const match of normalized.matchAll(/[a-z0-9+]{2,}/g)) tokens.add(match[0]);
  for (const token of ["辅酶q10", "辅酶", "q10", "coq10", "nad", "xikang", "swisse", "斯维诗", "gnc", "普丽普莱", "纽维可", "还原型", "胶囊", "软胶囊", "奶蓟草", "水飞蓟", "护肝", "护旰", "护肝片", "肝护片", "养肝片", "净肝片", "胆碱", "姜黄", "叶黄素", "养肺", "护肺", "润肺", "呼吸", "蜂胶", "葡萄籽", "原花青素", "烟酰胺", "卵磷脂", "软磷脂", "记忆力", "银杏", "圣洁莓", "月经", "经期", "内分泌", "卵巢", "促排卵", "维生素c", "维c", "vc", "液体钙", "钙镁锌", "柠檬酸钙", "碳酸钙", "钙片", "钙", "氨糖", "氨基葡萄糖", "软骨素", "褪黑素", "透明质酸", "玻尿酸", "胶原蛋白", "维生素d", "维生素b", "b族"]) {
    if (normalized.includes(token)) tokens.add(token);
  }
  return [...tokens].filter((token) => token.length >= 2);
}

function normalizeSearchText(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, "");
}

function productSearchText(product = {}) {
  return [product.title, product.skuText, product.skuInfo, product.shopName, product.shop].filter(Boolean).join(" ");
}

function productFamilies(text = "") {
  const normalized = normalizeSearchText(text);
  return PRODUCT_FAMILY_DEFINITIONS
    .filter((family) => family.pattern.test(normalized))
    .map((family) => family.id)
    .filter((family, index, all) => all.indexOf(family) === index);
}

function primaryFamilies(families = []) {
  const specific = families.filter((family) => !GENERIC_PRODUCT_FAMILIES.has(family));
  return specific.length > 0 ? specific : families;
}

function familyLabels(families = []) {
  if (!families.length) return "未识别品类";
  return families
    .map((family) => PRODUCT_FAMILY_DEFINITIONS.find((item) => item.id === family)?.label || family)
    .join("、");
}

function sameProductResult(matched, confidence, reason, jdFamilies, taobaoFamilies, skuCompatible) {
  return {
    matched,
    confidence,
    reason,
    jdFamilies,
    taobaoFamilies,
    skuCompatible
  };
}

function assessSkuCompatibility(jdProduct = {}, taobaoProduct = {}) {
  const jdSku = parseSkuProfile(jdProduct.skuText || jdProduct.skuInfo || jdProduct.title || "");
  const taobaoSku = parseSkuProfile(taobaoProduct.skuText || taobaoProduct.skuInfo || taobaoProduct.title || "");
  if (!jdSku.contentCount || !taobaoSku.contentCount) {
    return { compatible: true, strong: false, reason: "SKU 数量不足，按单位价继续复核" };
  }
  const jdUnitGroup = normalizeContentUnit(jdSku.contentUnit);
  const taobaoUnitGroup = normalizeContentUnit(taobaoSku.contentUnit);
  if (jdUnitGroup && taobaoUnitGroup && jdUnitGroup !== taobaoUnitGroup) {
    return {
      compatible: false,
      strong: false,
      reason: `SKU 单位不一致：京东 ${jdSku.contentUnit || "-"}，淘宝 ${taobaoSku.contentUnit || "-"}`
    };
  }
  const ratio = Math.max(jdSku.contentCount, taobaoSku.contentCount) / Math.max(1, Math.min(jdSku.contentCount, taobaoSku.contentCount));
  return {
    compatible: true,
    strong: ratio <= 1.5,
    reason: ratio <= 1.5
      ? `SKU 可比：京东 ${jdSku.contentCount}${jdSku.contentUnit || ""}，淘宝 ${taobaoSku.contentCount}${taobaoSku.contentUnit || ""}`
      : `SKU 装量不同，按单位价继续复核：京东 ${jdSku.contentCount}${jdSku.contentUnit || ""}，淘宝 ${taobaoSku.contentCount}${taobaoSku.contentUnit || ""}`
  };
}

function normalizeContentUnit(unit) {
  if (!unit) return "";
  if (COUNT_UNITS.has(unit)) return "count";
  return unit;
}

function sharedBrand(left = "", right = "") {
  const normalizedLeft = normalizeSearchText(left);
  const normalizedRight = normalizeSearchText(right);
  return BRAND_ALIAS_GROUPS.some((group) => group.some((token) => normalizedLeft.includes(normalizeSearchText(token))) && group.some((token) => normalizedRight.includes(normalizeSearchText(token))));
}

function assessBrandCompatibility(jdProduct = {}, taobaoProduct = {}) {
  const jdAliases = productBrandAliases(jdProduct);
  if (!jdAliases.length) {
    return { compatible: true, strong: false, reason: "京东品牌不足，按品类继续复核" };
  }

  const taobaoText = normalizeSearchText(productSearchText(taobaoProduct));
  if (jdAliases.some((alias) => taobaoText.includes(normalizeSearchText(alias)))) {
    return { compatible: true, strong: true, reason: `品牌一致：${displayBrandAliases(jdAliases)}` };
  }

  const taobaoAliases = productBrandAliases(taobaoProduct);
  if (taobaoAliases.length) {
    return {
      compatible: false,
      strong: false,
      reason: `品牌不一致：京东 ${displayBrandAliases(jdAliases)}，淘宝 ${displayBrandAliases(taobaoAliases)}`
    };
  }

  return {
    compatible: false,
    strong: false,
    reason: `淘宝标题未包含京东品牌：${displayBrandAliases(jdAliases)}`
  };
}

function productBrandAliases(product = {}) {
  const text = [product.brand, product.matchedBrand, product.title].filter(Boolean).join(" ");
  const normalized = normalizeSearchText(text);
  const aliases = new Set();

  for (const group of BRAND_ALIAS_GROUPS) {
    if (group.some((token) => normalized.includes(normalizeSearchText(token)))) {
      for (const token of group) aliases.add(token);
    }
  }

  const explicitBrand = [product.brand, product.matchedBrand].filter(Boolean).join(" ");
  for (const token of explicitBrand.match(/[A-Za-z][A-Za-z0-9+.-]{1,30}/g) || []) {
    if (!isGenericBrandToken(token)) aliases.add(token);
  }

  const titlePrefix = String(product.title || "").slice(0, 32);
  for (const token of titlePrefix.match(/[A-Za-z][A-Za-z0-9+.-]{2,30}/g) || []) {
    if (!isGenericBrandToken(token)) aliases.add(token);
  }

  return [...aliases].filter((item) => normalizeSearchText(item).length >= 2);
}

function displayBrandAliases(aliases = []) {
  const normalized = [];
  for (const alias of aliases) {
    const text = String(alias || "").trim();
    if (text && !normalized.some((item) => normalizeSearchText(item) === normalizeSearchText(text))) normalized.push(text);
  }
  return normalized.slice(0, 3).join("/") || "未知品牌";
}

function isGenericBrandToken(token = "") {
  return /^(?:nad|pqq|q10|coq10|pro|plus|ultra|max|epa|dha|egcg|eaa|eaas|omega|vitamin|testosterone|booster)$/i.test(String(token));
}

const BRAND_ALIAS_GROUPS = [
  ["swisse", "斯维诗"],
  ["gnc", "健安喜"],
  ["xikang", "希康"],
  ["newink", "纽维可"],
  ["puritan", "普丽普莱"],
  ["blackmores", "澳佳宝"],
  ["megagold", "美嘉高"],
  ["camette", "凯美", "凯麦特"],
  ["uqb"],
  ["sixstar", "six star", "六星"],
  ["usana", "优莎娜"],
  ["sotya"],
  ["fairvital"],
  ["biocyte", "碧维"],
  ["vedonon", "维多能"],
  ["vitavitality", "维他活力"]
];

function findFirstQuantity(text, units) {
  return findQuantityMatches(text, units)[0] ?? null;
}

function findLastQuantity(text, units) {
  return findQuantityMatches(text, units).at(-1) ?? null;
}

function findQuantityMatches(text, units) {
  const regex = new RegExp(`(\\d+)\\s*(${units.join("|")})`, "g");
  return [...text.matchAll(regex)].map((match) => ({ count: Number(match[1]), unit: match[2] }));
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundRate(value) {
  return Number(value.toFixed(4));
}

function numberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampInteger(value, min, max, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}
