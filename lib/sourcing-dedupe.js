import { buildTaobaoSearchKeyword, extractBrand } from "./logic.js";

const BRAND_GROUPS = [
  ["gnc", "健安喜"],
  ["swisse", "斯维诗"],
  ["movefree", "move free", "益节"],
  ["blackmores", "澳佳宝"],
  ["bioisland", "bio island", "佰澳朗德"],
  ["amway", "安利", "nutrilite", "纽崔莱"],
  ["ubio", "优必欧"],
  ["xikang", "希康"],
  ["newink", "纽维可"],
  ["puritan", "普丽普莱"]
];

const NOISE_WORDS = [
  "京东", "淘宝", "天猫", "买手店", "全球", "海外", "进口", "现货", "正品", "官方", "旗舰店",
  "保健品", "营养品", "推荐", "新老包装随机", "新旧包装随机", "拍下", "包邮", "组合装", "囤货装",
  "家庭装", "优惠装", "礼盒装", "升级版", "加强版", "原装", "美国", "澳洲", "加拿大", "香港"
];

/**
 * 生成“同款商品”的稳定指纹。
 *
 * 目标不是识别 SKU 数量，而是识别同一个产品本体：
 * - 品牌一致
 * - 核心品名一致
 * - 剂量/含量一致
 *
 * 包装数量(60粒/120粒/3瓶)不参与核心指纹，避免同款不同包装被重复算作多个品。
 */
export function buildJdProductFingerprint(row = {}) {
  const title = get(row, "jd_title", "jdTitle", "title");
  const sku = get(row, "jd_sku_info", "jdSkuInfo", "skuInfo", "skuText");
  const brandText = get(row, "jd_brand", "jdBrand", "brand") || extractBrand(title);
  const combined = `${brandText} ${title} ${sku}`;
  const brand = normalizeBrand(brandText || combined);
  const keyword = buildTaobaoSearchKeyword({ brand: brandText, title });
  const identity = normalizeProductIdentity(keyword || title, brand);
  const dosage = extractDosageKey(combined);
  const form = extractFormKey(combined);
  const productId = get(row, "jd_product_id", "jdProductId", "productId");

  if (identity.length >= 2) {
    return [brand || "unknown-brand", identity, dosage, form].filter(Boolean).join("|");
  }

  const fallback = normalizeProductIdentity(`${title} ${sku}`, brand);
  return fallback.length >= 2 ? `fallback|${brand || "unknown-brand"}|${fallback}` : `jd|${productId || ""}`;
}

export function dedupeSourcingRows(rows = []) {
  const selected = new Map();
  const order = [];
  for (const row of rows) {
    const key = buildJdProductFingerprint(row);
    if (!selected.has(key)) {
      selected.set(key, row);
      order.push(key);
      continue;
    }
    selected.set(key, chooseBetterRow(selected.get(key), row));
  }
  return order.map((key) => selected.get(key)).filter(Boolean);
}

function chooseBetterRow(left, right) {
  return compareRows(right, left) > 0 ? right : left;
}

function compareRows(left, right) {
  const leftProfit = numeric(get(left, "profit_rate", "profitRate"));
  const rightProfit = numeric(get(right, "profit_rate", "profitRate"));
  const leftAmount = numeric(get(left, "profit_amount", "profitAmount"));
  const rightAmount = numeric(get(right, "profit_amount", "profitAmount"));

  const leftHasTaobao = Boolean(get(left, "taobao_product_id", "best_taobao_id", "bestTaobaoId", "taobaoTitle", "taobao_title"));
  const rightHasTaobao = Boolean(get(right, "taobao_product_id", "best_taobao_id", "bestTaobaoId", "taobaoTitle", "taobao_title"));
  if (leftHasTaobao !== rightHasTaobao) return leftHasTaobao ? 1 : -1;

  if (leftProfit !== rightProfit) return leftProfit - rightProfit;
  if (leftAmount !== rightAmount) return leftAmount - rightAmount;

  const leftBest = Number(get(left, "is_best", "isBest") || 0);
  const rightBest = Number(get(right, "is_best", "isBest") || 0);
  if (leftBest !== rightBest) return leftBest - rightBest;

  const leftUnit = numeric(get(left, "jd_unit_price", "jdUnitPrice"));
  const rightUnit = numeric(get(right, "jd_unit_price", "jdUnitPrice"));
  if (leftUnit && rightUnit && leftUnit !== rightUnit) return rightUnit - leftUnit;

  const leftPrice = numeric(get(left, "jd_price", "jdPrice"));
  const rightPrice = numeric(get(right, "jd_price", "jdPrice"));
  if (leftPrice && rightPrice && leftPrice !== rightPrice) return rightPrice - leftPrice;

  const leftTime = Date.parse(get(left, "updated_at", "updatedAt", "created_at", "createdAt") || "") || 0;
  const rightTime = Date.parse(get(right, "updated_at", "updatedAt", "created_at", "createdAt") || "") || 0;
  return leftTime - rightTime;
}

function normalizeProductIdentity(text, brand) {
  let value = normalizeText(text)
    .replace(normalizeText(brand), "")
    .replace(/\d+(?:\.\d+)?(?:mg|毫克|g|克|mcg|μg|ug|微克|ml|毫升|l|升)/g, "")
    .replace(/\d+(?:\.\d+)?(?:粒|片|颗|瓶|盒|罐|袋|支|件)/g, "");
  for (const word of NOISE_WORDS) {
    value = value.replaceAll(normalizeText(word), "");
  }
  return value.slice(0, 48);
}

function normalizeBrand(value) {
  const text = normalizeText(value);
  if (!text) return "";
  for (const group of BRAND_GROUPS) {
    if (group.some((alias) => text.includes(normalizeText(alias)))) return normalizeText(group[0]);
  }
  return text.slice(0, 24);
}

function extractDosageKey(text) {
  const values = [];
  const normalized = String(text || "").toLowerCase();
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(mg|毫克|g|克|mcg|μg|ug|微克)/g)) {
    let value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2];
    if (unit === "g" || unit === "克") value *= 1000;
    if (unit === "mcg" || unit === "μg" || unit === "ug" || unit === "微克") value /= 1000;
    if (value >= 0.001 && value <= 100000) values.push(Number(value.toFixed(4)));
  }
  return values.length ? `mg:${[...new Set(values)].sort((a, b) => a - b).join("+")}` : "";
}

function extractFormKey(text) {
  const value = String(text || "");
  if (/软胶囊/.test(value)) return "form:softgel";
  if (/胶囊/.test(value)) return "form:capsule";
  if (/片/.test(value)) return "form:tablet";
  if (/颗粒/.test(value)) return "form:granule";
  if (/粉/.test(value)) return "form:powder";
  if (/液/.test(value)) return "form:liquid";
  return "";
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}+]+/gu, "");
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function get(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") return object[key];
  }
  return "";
}
