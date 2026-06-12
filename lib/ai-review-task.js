export function buildAiReviewTask({ jdProduct, taobaoCandidates = [], keyword = "", strategy = {} }) {
  const profit = strategy?.profit || {};
  const jd = normalizeJdEvidence(jdProduct || {});
  const candidates = (Array.isArray(taobaoCandidates) ? taobaoCandidates : [])
    .map((candidate, index) => normalizeTaobaoEvidence(candidate, index));

  return {
    version: 1,
    taskType: "ai_sku_profit_review",
    decisionOwner: "calling_agent",
    keyword,
    jdProduct: jd,
    taobaoCandidates: candidates,
    strategySnapshot: {
      id: strategy?.id || "no-source-arbitrage",
      jd: {
        minComments: strategy?.platforms?.jd?.minComments ?? 2,
        shopTypes: strategy?.platforms?.jd?.shopTypes || { include: ["buyer"] }
      },
      taobao: {
        minSales: strategy?.platforms?.taobao?.minSales ?? 10,
        shipFrom: strategy?.platforms?.taobao?.shipFrom || "domestic",
        shipWithinHours: strategy?.platforms?.taobao?.shipWithinHours ?? 48
      },
      profit: {
        minRate: profit.minRate ?? 0.35,
        maxRate: profit.maxRate ?? 0.6,
        minAmount: profit.minAmount ?? 20
      }
    },
    requiredEvidence: [
      "京东标题、SKU、价格、主图/详情截图、商品链接",
      "淘宝标题、选中SKU、SKU候选、价格、销量、发货地、截图、商品链接",
      "如截图路径存在，必须用多模态能力看图复核，不只看脚本字段"
    ],
    instructions: buildReviewInstructions(profit),
    outputContract: {
      description: "Agent 审核完后，把 taobaoMatches 传给 save_sourcing。代码不会替你决定同款、单位价或利润。",
      jsonShape: {
        jdProduct: "原样带回京东品，必要时补充 Agent 亲自换算的 unitPrice/unit",
        taobaoMatches: [
          {
            taobao: {
              productId: "淘宝商品ID",
              title: "淘宝标题",
              price: "Agent确认的淘宝SKU总价",
              unitPrice: "Agent按SKU亲自换算的最小规格单价",
              unit: "粒/片/g/ml/瓶等",
              skuInfo: "Agent确认用于比价的淘宝SKU",
              sales: "销量文本或数字",
              shop: "淘宝店铺",
              shipFrom: "发货地",
              isDomestic: true,
              shipHours: 48,
              url: "淘宝链接",
              screenshotPath: "截图路径"
            },
            profit: {
              profitAmount: "按等量整件折算后的单件利润金额",
              profitRate: "利润率=(京东等量售价-淘宝等量成本)/京东等量售价，小数"
            },
            review: {
              sameProductReason: "为什么判断为同款",
              skuCalculation: "京东SKU和淘宝SKU分别如何换算成最小单位价",
              profitCalculation: "利润金额和利润率计算过程",
              evidenceUsed: "用到了哪些截图/字段",
              riskNotes: "不确定性、假货/异常低价/品牌风险"
            }
          }
        ],
        rejections: [
          {
            taobaoProductId: "淘宝商品ID",
            reason: "淘汰原因：不同款/SKU不可比/利润不达标/利润异常过高/发货或销量不符等"
          }
        ]
      }
    },
    saveInstruction: "只有 Agent 自己确认同款、SKU可比、利润达标后，才调用 ecommerce_sourcing({ action:'save_sourcing', jdProduct, taobaoMatches })。如果无法确认，taobaoMatches 传空数组或不要保存。"
  };
}

export function dbRowToJdProduct(row = {}) {
  return {
    productId: row.jdProductId || row.jd_product_id || "",
    title: row.jdTitle || row.jd_title || "",
    price: numberOrNull(row.jdPrice ?? row.jd_price),
    unitPrice: numberOrNull(row.jdUnitPrice ?? row.jd_unit_price),
    unit: row.jdUnit || row.jd_unit || "",
    sales: row.jdSales || row.jd_sales || "",
    comments: row.jdComments || row.jd_comments || "",
    shop: row.jdShop || row.jd_shop || "",
    shopType: row.jdShopType || row.jd_shop_type || "buyer",
    brand: row.jdBrand || row.jd_brand || "",
    skuInfo: row.jdSkuInfo || row.jd_sku_info || "",
    url: row.jdUrl || row.jd_url || "",
    screenshotPath: row.jdScreenshotPath || row.jd_screenshot_path || ""
  };
}

function buildReviewInstructions(profit) {
  const minRate = profit.minRate ?? 0.35;
  const maxRate = profit.maxRate ?? 0.6;
  const minAmount = profit.minAmount ?? 20;
  return [
    "这是 AI 审核任务包，不是脚本自动比价结果。不要让脚本替你裁决同款、单位价或利润。",
    "第一步：用京东标题、SKU、截图确认京东基准商品。要识别品牌、核心品名、剂量/含量、装量。营销词和几瓶装不要当产品名。",
    "第二步：逐个看淘宝候选。结合标题、选中SKU、SKU列表、截图和链接判断是否同款；品牌不同、剂量不同、产品家族不同的一律拒绝。",
    "第三步：由你亲自换算 SKU。京东 5 瓶和淘宝 1 瓶不能比总价；必须换算成同一最小单位，如每粒、每片、每克、每毫升。",
    "第四步：利润要按等量整件折算。比如京东 120 粒与淘宝 60 粒，要把淘宝成本折算到 120 粒再算利润金额；不要只拿每粒差价当单件利润。",
    `第五步：利润率=(京东等量售价-淘宝等量成本)/京东等量售价，必须在 ${(minRate * 100).toFixed(0)}%-${(maxRate * 100).toFixed(0)}% 内，且单件利润不少于 ${minAmount} 元。利润率过高也要淘汰，避免异常货源。`,
    "第六步：不确定就拒绝，不要硬凑。输出时必须写清 sameProductReason、skuCalculation、profitCalculation，方便后续复盘。"
  ];
}

function normalizeJdEvidence(product) {
  return {
    productId: product.productId || product.jdProductId || "",
    title: product.title || product.jdTitle || "",
    brand: product.brand || product.jdBrand || "",
    price: numberOrNull(product.price ?? product.jdPrice),
    comments: product.comments || product.commentsNum || product.jdComments || "",
    shop: product.shop || product.jdShop || "",
    shopType: product.shopType || product.jdShopType || "",
    skuInfo: product.skuInfo || product.skuText || product.jdSkuInfo || "",
    url: product.url || product.jdUrl || "",
    screenshotPath: product.screenshotPath || product.jdScreenshotPath || "",
    parserHints: parserHints(product)
  };
}

function normalizeTaobaoEvidence(candidate, index) {
  return {
    index,
    productId: candidate.productId || candidate.taobaoProductId || "",
    title: candidate.title || candidate.taobaoTitle || "",
    price: numberOrNull(candidate.price ?? candidate.taobaoPrice),
    sales: candidate.sales || candidate.salesText || candidate.taobaoSales || "",
    salesCount: numberOrNull(candidate.salesCount),
    shop: candidate.shop || candidate.taobaoShop || "",
    shipFrom: candidate.shipFrom || "",
    isDomestic: candidate.isDomestic ?? candidate.domesticShipping ?? null,
    shipHours: numberOrNull(candidate.shipHours ?? candidate.shippingHours),
    skuInfo: candidate.skuInfo || candidate.skuText || "",
    selectedSkuOptions: Array.isArray(candidate.selectedSkuOptions) ? candidate.selectedSkuOptions : [],
    skuOptions: Array.isArray(candidate.skuOptions) ? candidate.skuOptions : [],
    selectedSkuRejectReason: candidate.selectedSkuRejectReason || "",
    url: candidate.url || candidate.taobaoUrl || "",
    screenshotPath: candidate.screenshotPath || "",
    parserHints: parserHints(candidate)
  };
}

function parserHints(item) {
  return {
    unitPrice: numberOrNull(item.unitPrice),
    unit: item.unit || "",
    spec: item.spec || null,
    unitPriceFormula: item.unitPriceFormula || "",
    note: "仅为脚本解析提示，不可作为最终裁决；最终同款、SKU换算、利润由 Agent/AI 根据证据重新判断。"
  };
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
