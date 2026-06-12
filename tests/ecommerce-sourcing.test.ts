import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessProfit,
  assessSameProductMatch,
  buildTaobaoSearchKeyword,
  buildTaobaoSearchKeywords,
  coreProductMatched,
  parseCommentCount,
  parseSalesCount,
  taobaoSelectedSkuRejectReason,
  taobaoRejectReason
} from "../lib/logic.js";
import { openSourcingDb } from "../lib/db.js";
import { exportToFeishu } from "../lib/feishu.js";
import { DEFAULT_STRATEGIES, evaluateJdProductByStrategy, evaluateTaobaoProductByStrategy, evaluateWithStrategy, findBannedBrandMatch } from "../lib/strategy-engine.js";
import { calculateUnitPrice, compareUnitPrice } from "../lib/unit-price.js";
import { extractJdSearchKeyword, jdProductMatchesAllowedBrands, jdProductMatchesBrandSeed, jdSearchKeywordMatches } from "../lib/ai-controller.js";
import { execute as sourcingExecute } from "../tools/sourcing.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ecommerce sourcing core", () => {
  it("builds compact Taobao keywords from a JD title", () => {
    const title = "Newink还原型辅酶q10纽维可软胶囊供养心肌保护心脏脑血管保健品 2瓶【守护装】健康活力 60粒*2瓶";

    expect(buildTaobaoSearchKeyword({ brand: "Newink", title })).toBe("Newink 还原型辅酶q10 软胶囊");
    const keywords = buildTaobaoSearchKeywords({ brand: "Newink", title });
    expect(keywords[0]).toBe("Newink 还原型辅酶q10 软胶囊");
    expect(keywords).toContain("纽维可 还原型辅酶q10 软胶囊");
    expect(keywords).toContain("Newink 纽维可 还原型辅酶q10");
    expect(keywords).toContain("辅酶q10 软胶囊");
  });

  it("extracts alpha lipoic acid as a compact Taobao keyword", () => {
    const title = "GNC健安喜美国阿尔法α-硫辛酸胰岛糖尿病人无糖食品护肝300/ 600mg 健安喜GNC硫辛酸600mg 60粒*2瓶";

    expect(buildTaobaoSearchKeyword({ brand: "GNC", title })).toBe("GNC 硫辛酸");
    expect(buildTaobaoSearchKeywords({ brand: "GNC", title })[0]).toBe("GNC 硫辛酸");
  });

  it("rejects irrelevant Taobao candidates before profit comparison", () => {
    expect(coreProductMatched("纽维可还原型辅酶Q10软胶囊60粒", "Newink 还原型辅酶q10 软胶囊")).toBe(true);
    expect(coreProductMatched("CPE路由器工厂设备测试使用反向nano sim卡", "Newink 还原型辅酶q10 软胶囊")).toBe(false);

    const reason = taobaoRejectReason({
      title: "CPE路由器工厂设备测试使用反向nano sim卡",
      price: 10,
      relevanceScore: 2,
      coreProductMatched: false,
      salesCount: 999,
      domesticShipping: true,
      shippingHours: 24
    }, {
      minTaobaoSales: 10,
      requireDomesticShipping: true,
      requireFastShippingHours: 48
    });

    expect(reason).toBe("淘宝标题缺少核心品名");
  });

  it("uses product-family checks to avoid false same-product matches", () => {
    const matched = assessSameProductMatch(
      {
        platform: "jd",
        title: "Swisse斯维诗 胆碱护肝片 奶蓟草片姜黄 熬夜职场高压养肝解酒 120粒",
        skuText: "120粒/瓶"
      },
      {
        platform: "taobao",
        title: "澳洲Swisse/斯维诗二代护肝片胆碱女性男奶蓟草熬夜水飞蓟120粒",
        skuText: "120粒"
      },
      "Swisse 奶蓟草 片"
    );
    const rejected = assessSameProductMatch(
      {
        platform: "jd",
        title: "Swisse天然黑蜂胶软胶囊 2000mg 高浓度蜂胶 浓缩提升免疫 澳洲进口 210粒",
        skuText: "210粒"
      },
      {
        platform: "taobao",
        title: "澳洲Swisse深海鱼油无腥味1000mg400粒软胶囊高浓度 Omega3中老年",
        skuText: "400粒"
      },
      "Swisse 软胶囊"
    );

    expect(matched.matched).toBe(true);
    expect(rejected.matched).toBe(false);
    expect(rejected.reason).toContain("品类不一致");
  });

  it("rejects Taobao candidates when the selected SKU is a different product family", () => {
    const rejected = taobaoSelectedSkuRejectReason("Swisse NAD+ PQQ", ["固醇胶囊1瓶"]);
    const allowedWhenSkuIsGeneric = taobaoSelectedSkuRejectReason("Swisse NAD+ PQQ", ["【1瓶】新生瓶ultra 30粒"]);

    expect(rejected).toContain("选中SKU品类不一致");
    expect(rejected).toContain("NAD");
    expect(rejected).toContain("植物固醇");
    expect(allowedWhenSkuIsGeneric).toBe("");
  });

  it("detects when JD search result keyword was replaced by suggestions", () => {
    const expected = "Swisse 辅酶Q10 买手店";
    const wrongUrl = "https://search.jd.com/Search?keyword=%E6%96%AF%E7%BB%B4%E8%AF%97swisse&enc=utf-8";
    const correctUrl = "https://search.jd.com/Search?keyword=Swisse%20%E8%BE%85%E9%85%B6Q10%20%E4%B9%B0%E6%89%8B%E5%BA%97&enc=utf-8";

    expect(extractJdSearchKeyword(wrongUrl)).toBe("斯维诗swisse");
    expect(jdSearchKeywordMatches(wrongUrl, expected)).toBe(false);
    expect(jdSearchKeywordMatches(correctUrl, expected)).toBe(true);
  });

  it("keeps JD shop harvesting focused on brand without requiring product-name tokens", () => {
    expect(jdProductMatchesBrandSeed({
      title: "Swisse斯维诗高浓度辅酶Q10胶囊150mg50粒"
    }, "Swisse 辅酶Q10")).toBe(true);

    expect(jdProductMatchesBrandSeed({
      title: "Swisse斯维诗Swisse超光瓶水光片30粒"
    }, "Swisse 辅酶Q10")).toBe(true);

    expect(jdProductMatchesBrandSeed({
      title: "Life Space益倍适成人益生菌320亿活菌60粒"
    }, "Swisse 辅酶Q10")).toBe(false);
  });

  it("allows JD shop harvesting to keep any brand from the configured brand pool", () => {
    const allowedBrands = ["GNC", "Nordic Naturals", "NEO", "维他树（VITATREE）"];

    expect(jdProductMatchesAllowedBrands({
      title: "Nordic Naturals挪威小鱼美国青少年儿童Ultimate Omega鱼油"
    }, allowedBrands, "TAHITIAN NONI")).toBe(true);

    expect(jdProductMatchesAllowedBrands({
      title: "VITATREE维他树辅酶Q10软胶囊60粒"
    }, allowedBrands, "TAHITIAN NONI")).toBe(true);

    expect(jdProductMatchesAllowedBrands({
      title: "Neocell胶原蛋白片120粒"
    }, allowedBrands, "TAHITIAN NONI")).toBe(false);

    expect(jdProductMatchesAllowedBrands({
      title: "California Naturals益生菌胶囊60粒"
    }, allowedBrands, "TAHITIAN NONI")).toBe(false);
  });

  it("reads banned brands from strategy rules instead of hardcoded workflow checks", () => {
    const strategy = DEFAULT_STRATEGIES["no-source-arbitrage"];

    expect(findBannedBrandMatch("澳洲 Swisse 斯维诗 辅酶Q10", strategy)?.name).toBe("斯维诗");
    expect(evaluateJdProductByStrategy({
      title: "澳洲Swisse斯维诗辅酶Q10",
      price: 228,
      shopType: "buyer"
    }, strategy)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("策略禁售品牌")
    });
    expect(evaluateTaobaoProductByStrategy({
      title: "Move Free 益节 维骨力",
      price: 99,
      sales: "100+"
    }, strategy)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("策略禁售品牌")
    });
  });

  it("parses sales and comments without mixing price digits", () => {
    expect(parseSalesCount("¥96.2 1人付款 北京")).toBe(1);
    expect(parseSalesCount("¥183.87 补贴后 100+人付款")).toBe(100);
    expect(parseSalesCount("49人付款 山东 青岛 48小时内发 包邮")).toBe(49);
    expect(parseCommentCount("3")).toBe(3);
    expect(parseCommentCount("100+")).toBe(100);
    expect(parseCommentCount("1万+")).toBe(10000);
  });

  it("calculates supplement unit prices by count before dosage", () => {
    const jd = calculateUnitPrice(228, "Swisse 辅酶Q10 150mg 60粒", "60粒/瓶");
    const taobao = calculateUnitPrice(168, "Swisse 辅酶Q10 150mg 60粒", "60粒");

    expect(jd.unit).toBe("粒");
    expect(jd.unitPrice).toBe(3.8);
    expect(taobao.unitPrice).toBe(2.8);

    const compared = compareUnitPrice(
      { price: 228, title: "Swisse 辅酶Q10 150mg 60粒", skuInfo: "60粒/瓶" },
      { price: 168, title: "Swisse 辅酶Q10 150mg 60粒", skuInfo: "60粒" }
    );
    expect(compared.canCompare).toBe(true);
    expect(compared.profitRate).toBeCloseTo(0.2632, 4);
  });

  it("uses JD unit price as the profit-rate denominator", () => {
    const result = assessProfit({
      jdTotalPrice: 395.4,
      jdUnitPrice: 197.7,
      taobaoUnitPrice: 140
    });

    expect(result.rule).toBe("rate");
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain("不足 35%");
  });

  it("applies configurable minimum profit and maximum profit rate", () => {
    const lowAmount = assessProfit({
      jdUnitPrice: 100,
      taobaoUnitPrice: 70
    }, {
      profit: { minRate: 0.2, maxRate: 0.6, minAmount: 40 }
    });
    const suspicious = assessProfit({
      jdUnitPrice: 100,
      taobaoUnitPrice: 20
    }, {
      profit: { minRate: 0.2, maxRate: 0.6, minAmount: 20 }
    });

    expect(lowAmount.qualified).toBe(false);
    expect(lowAmount.rule).toBe("amount");
    expect(lowAmount.reason).toContain("单件利润不足 40 元");
    expect(suspicious.qualified).toBe(false);
    expect(suspicious.reason).toContain("超过 60%");
  });

  it("uses unit prices for complete strategy profit evaluation when available", () => {
    const result = evaluateWithStrategy(
      {
        title: "京东 Q10 60粒",
        price: 398,
        unitPrice: 6.63,
        shopType: "buyer"
      },
      {
        title: "淘宝 Q10 60粒",
        price: 216,
        unitPrice: 3.6,
        sales: "20"
      },
      {
        platforms: {
          jd: { shopTypes: { include: ["buyer"] }, priceRange: [0, 9999] },
          taobao: { priceRange: [0, 9999], minSales: 10 }
        },
        profit: { minRate: 0.35, maxRate: 0.6, minAmount: 1 }
      }
    );

    expect(result.stage).toBe("profit");
    expect(result.passed).toBe(true);
    expect(result.profitRate).toBeCloseTo(0.457, 3);
  });

  it("exports JD-only candidates as CSV rows", () => {
    const dataDir = tempDir();
    const db = openSourcingDb({ dataDir });
    const outPath = join(dataDir, "exports", "result.csv");

    try {
      db.saveSourcing({
        productId: "jd-1",
        title: "京东候选",
        price: 398,
        unitPrice: 199,
        unit: "瓶",
        comments: "3",
        shop: "买手店",
        shopType: "buyer",
        brand: "GNC",
        skuInfo: "2瓶",
        url: "https://item.jd.com/1.html",
        screenshotPath: join(dataDir, "jd-1.jpg")
      }, [], null, { id: "no-source-arbitrage" });

      const exported = db.exportSourcing(outPath);
      const text = readFileSync(outPath, "utf8");

      expect(exported.count).toBe(1);
      expect(text).toContain("京东候选");
      expect(text).toContain("https://item.jd.com/1.html");
    } finally {
      db.close();
    }
  });

  it("keeps existing Taobao match and profit when a JD candidate is re-saved alone", () => {
    const dataDir = tempDir();
    const db = openSourcingDb({ dataDir });

    try {
      const jdProduct = {
        productId: "jd-preserve-1",
        title: "GNC 辅酶Q10 60粒",
        price: 398,
        unitPrice: 6.63,
        unit: "粒",
        comments: "3",
        shop: "京东买手店",
        shopType: "buyer",
        brand: "Swisse",
        skuInfo: "60粒/瓶",
        url: "https://item.jd.com/preserve-1.html"
      };
      db.saveSourcing(jdProduct, [{
        taobao: {
          productId: "tb-preserve-1",
          title: "GNC 辅酶Q10 60粒 国内现货",
          price: 216,
          unitPrice: 3.6,
          unit: "粒",
          shop: "淘宝供货店",
          shipFrom: "广东",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=preserve-1"
        },
        profit: { profitAmount: 182, profitRate: 0.4573 }
      }], null, { id: "no-source-arbitrage" });

      db.saveSourcing({
        ...jdProduct,
        title: "Swisse 辅酶Q10 60粒 更新标题",
        price: 388
      }, [], null, { id: "no-source-arbitrage" });

      const [row] = db.listSourcingResults(10);

      expect(row).toMatchObject({
        jdProductId: "jd-preserve-1",
        jdTitle: "Swisse 辅酶Q10 60粒 更新标题",
        jdPrice: 388,
        bestTaobaoId: "tb-preserve-1",
        taobaoMatchCount: 1
      });
      expect(row.profitAmount).toBe(182);
      expect(row.profitRate).toBeCloseTo(0.4573, 4);
    } finally {
      db.close();
    }
  });

  it("exports one final row for duplicated JD products and keeps the better match", () => {
    const dataDir = tempDir();
    const db = openSourcingDb({ dataDir });
    const outPath = join(dataDir, "exports", "deduped.csv");

    try {
      db.saveSourcing({
        productId: "jd-dup-low",
        title: "GNC健安喜 辅酶Q10 100mg 60粒 软胶囊",
        price: 228,
        unitPrice: 3.8,
        unit: "粒",
        comments: "20",
        shop: "买手店A",
        shopType: "buyer",
        brand: "GNC",
        skuInfo: "60粒/瓶",
        url: "https://item.jd.com/dup-low.html"
      }, [{
        taobao: {
          productId: "tb-dup-low",
          title: "GNC 辅酶Q10 100mg 60粒",
          price: 160,
          unitPrice: 2.67,
          unit: "粒",
          sales: "30",
          shop: "淘宝A",
          shipFrom: "广东",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=dup-low"
        },
        profit: { profitAmount: 68, profitRate: 0.2974 }
      }], null, { id: "no-source-arbitrage" });

      db.saveSourcing({
        productId: "jd-dup-best",
        title: "GNC 健安喜 美国辅酶Q10软胶囊100mg 60粒",
        price: 268,
        unitPrice: 4.47,
        unit: "粒",
        comments: "50",
        shop: "买手店B",
        shopType: "buyer",
        brand: "GNC",
        skuInfo: "60粒",
        url: "https://item.jd.com/dup-best.html"
      }, [{
        taobao: {
          productId: "tb-dup-best",
          title: "GNC 辅酶Q10 100mg 60粒 国内现货",
          price: 160,
          unitPrice: 2.67,
          unit: "粒",
          sales: "88",
          shop: "淘宝B",
          shipFrom: "浙江",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=dup-best"
        },
        profit: { profitAmount: 108, profitRate: 0.4029 }
      }], null, { id: "no-source-arbitrage" });

      const exported = db.exportSourcing(outPath);
      const text = readFileSync(outPath, "utf8");

      expect(exported.count).toBe(1);
      expect(text).toContain("jd-dup-best");
      expect(text).toContain("id=dup-best");
      expect(text).not.toContain("jd-dup-low");
    } finally {
      db.close();
    }
  });

  it("initializes Feishu export fields and clears default empty records", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "feishu-cred.json"), JSON.stringify({
      app_id: "test-app",
      app_secret: "test-secret",
      domain: "feishu"
    }));
    const db = openSourcingDb({ dataDir });
    const requests: Array<{ url: string; method: string; body: unknown }> = [];

    const fields = [
      { field_id: "fld-primary", field_name: "文本", type: 1, is_primary: true },
      { field_id: "fld-single", field_name: "单选", type: 3 },
      { field_id: "fld-date", field_name: "日期", type: 5 },
      { field_id: "fld-attach", field_name: "附件", type: 17 }
    ];
    const defaultRecords = [
      { record_id: "rec-empty-1", fields: {} },
      { record_id: "rec-empty-2", fields: {} }
    ];
    const createdRecords: unknown[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });

      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-token" });
      }
      if (url.endsWith("/bitable/v1/apps") && method === "POST") {
        return jsonResponse({ code: 0, data: { app: { app_token: "app-token", default_table_id: "tbl-main" } } });
      }
      if (url.endsWith("/tables/tbl-main/fields") && method === "GET") {
        return jsonResponse({ code: 0, data: { items: fields } });
      }
      if (url.endsWith("/tables/tbl-main/fields/fld-primary") && method === "PUT") {
        fields[0] = { ...fields[0], field_name: body.field_name, type: body.type };
        return jsonResponse({ code: 0, data: { field: fields[0] } });
      }
      if (url.endsWith("/tables/tbl-main/fields") && method === "POST") {
        fields.push({ field_id: `fld-${fields.length + 1}`, field_name: body.field_name, type: body.type });
        return jsonResponse({ code: 0, data: { field: fields.at(-1) } });
      }
      if (url.includes("/tables/tbl-main/fields/fld-") && method === "DELETE") {
        const fieldId = url.split("/").pop();
        const index = fields.findIndex((field) => field.field_id === fieldId);
        if (index >= 0) fields.splice(index, 1);
        return jsonResponse({ code: 0 });
      }
      if (url.includes("/tables/tbl-main/records?page_size=500") && method === "GET") {
        return jsonResponse({ code: 0, data: { items: defaultRecords, has_more: false } });
      }
      if (url.endsWith("/tables/tbl-main/records/batch_delete") && method === "POST") {
        defaultRecords.splice(0, defaultRecords.length);
        return jsonResponse({ code: 0 });
      }
      if (url.endsWith("/tables/tbl-main/records") && method === "POST") {
        createdRecords.push(body.fields);
        return jsonResponse({ code: 0, data: { record: { record_id: `rec-${createdRecords.length}` } } });
      }

      throw new Error(`Unexpected Feishu request: ${method} ${url}`);
    }) as typeof fetch;

    try {
      db.saveSourcing({
        productId: "jd-1",
        title: "GNC 辅酶Q10 软胶囊 60粒",
        price: 398,
        unitPrice: 6.63,
        unit: "粒",
        comments: "3",
        shop: "京东买手店",
        shopType: "buyer",
        brand: "GNC",
        skuInfo: "60粒/瓶",
        url: "https://item.jd.com/1.html"
      }, [{
        taobao: {
          productId: "tb-1",
          title: "GNC 辅酶Q10 60粒 国内现货",
          price: 216,
          unitPrice: 3.6,
          unit: "粒",
          sales: "20",
          shop: "淘宝供货店",
          shipFrom: "广东",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=1"
        },
        profit: { profitAmount: 182, profitRate: 0.4573 }
      }], null, { id: "no-source-arbitrage" });

      db.saveSourcing({
        productId: "jd-1-better",
        title: "GNC健安喜 辅酶Q10软胶囊 60粒",
        price: 420,
        unitPrice: 7,
        unit: "粒",
        comments: "9",
        shop: "京东买手店二",
        shopType: "buyer",
        brand: "GNC",
        skuInfo: "60粒",
        url: "https://item.jd.com/1-better.html"
      }, [{
        taobao: {
          productId: "tb-1-better",
          title: "GNC 辅酶Q10 60粒 国内现货",
          price: 210,
          unitPrice: 3.5,
          unit: "粒",
          sales: "80",
          shop: "淘宝供货店二",
          shipFrom: "浙江",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=1-better"
        },
        profit: { profitAmount: 210, profitRate: 0.5 }
      }], null, { id: "no-source-arbitrage" });

      const exported = await exportToFeishu(db, dataDir);

      expect(exported.ok).toBe(true);
      expect(exported.count).toBe(1);
      expect(fields.map((field) => field.field_name)).not.toContain("文本");
      expect(fields.map((field) => field.field_name)).not.toContain("单选");
      expect(fields[0]).toMatchObject({ field_name: "序号", type: 2, is_primary: true });
      expect(fields.map((field) => field.field_name)).toEqual([
        "序号",
        "京东截图",
        "京东价格",
        "京东单价",
        "淘宝截图",
        "淘宝价格",
        "淘宝单价",
        "利润率",
        "利润金额",
        "是否最佳",
        "京东SKU",
        "京东标题",
        "淘宝标题",
        "京东店铺",
        "淘宝店铺",
        "发货地",
        "京东商品ID",
        "京东链接",
        "淘宝链接",
        "创建时间"
      ]);
      expect(defaultRecords).toHaveLength(0);
      expect(createdRecords[0]).toMatchObject({
        "序号": 1,
        "京东店铺": "京东买手店二",
        "京东标题": "GNC健安喜 辅酶Q10软胶囊 60粒",
        "淘宝店铺": "淘宝供货店二",
        "利润率": "50.0%"
      });
      const deleteRequest = requests.find((request) => request.url.endsWith("/records/batch_delete"));
      expect((deleteRequest?.body as { records?: string[] } | undefined)?.records).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("exposes saved sourcing rows and operation logs to the calling Agent", async () => {
    const dataDir = tempDir();
    const ctx = testContext(dataDir);

    const saved = await sourcingExecute({
      action: "save_sourcing",
      jdProduct: {
        productId: "jd-log-1",
        title: "GNC 辅酶Q10 60粒",
        price: 398,
        unitPrice: 6.63,
        unit: "粒",
        shop: "京东买手店",
        shopType: "buyer",
        skuInfo: "60粒/瓶",
        url: "https://item.jd.com/log-1.html"
      },
      taobaoMatches: [{
        taobao: {
          productId: "tb-log-1",
          title: "GNC 辅酶Q10 60粒 国内现货",
          price: 216,
          sales: "20",
          unitPrice: 3.6,
          unit: "粒",
          shop: "淘宝供货店",
          shipFrom: "广东",
          isDomestic: true,
          shipHours: 24,
          url: "https://item.taobao.com/item.htm?id=log-1"
        },
        profit: { profitAmount: 182, profitRate: 0.4573 }
      }]
    }, ctx);
    const listed = await sourcingExecute({ action: "sourcing_list", limit: 10 }, ctx);
    const logs = await sourcingExecute({ action: "logs", limit: 10 }, ctx);

    expect(saved.ok).toBe(true);
    expect(listed.items[0]).toMatchObject({
      jdProductId: "jd-log-1",
      jdTitle: "GNC 辅酶Q10 60粒",
      taobaoMatchCount: 1
    });
    expect(listed.dedupedQualifiedCount).toBe(1);
    expect(logs.logs.some((log: { message: string }) => log.message.includes("save_sourcing 已入库"))).toBe(true);
  });

  it("blocks banned-brand rows at the final save_sourcing entrypoint", async () => {
    const dataDir = tempDir();
    const ctx = testContext(dataDir);

    const saved = await sourcingExecute({
      action: "save_sourcing",
      jdProduct: {
        productId: "jd-banned-1",
        title: "Swisse 斯维诗 辅酶Q10",
        price: 398,
        shopType: "buyer"
      },
      taobaoMatches: []
    }, ctx);

    expect(saved).toMatchObject({
      ok: false,
      code: "STRATEGY_REJECTED",
      message: expect.stringContaining("策略禁售品牌")
    });
  });

  it("persists custom strategies through the all-in-one MCP tool", async () => {
    const dataDir = tempDir();
    const ctx = testContext(dataDir);

    const saved = await sourcingExecute({
      action: "strategy_save",
      strategy: {
        id: "custom-low-risk",
        name: "自定义低风险",
        platforms: {
          jd: { minComments: 5 },
          taobao: { minSales: 20 }
        },
        profit: { minRate: 0.35, maxRate: 0.6, minAmount: 30 }
      }
    }, ctx);
    const loaded = await sourcingExecute({ action: "strategy_get", strategyId: "custom-low-risk" }, ctx);

    expect(saved.ok).toBe(true);
    expect(loaded.strategy.name).toBe("自定义低风险");
    expect(loaded.strategy.platforms.jd.minComments).toBe(5);
  });

  it("returns bootstrap guidance from the all-in-one MCP tool", async () => {
    const dataDir = tempDir();
    const result = await sourcingExecute({ action: "bootstrap", mode: "command" }, testContext(dataDir));

    expect(result.ok).toBe(true);
    expect(result.installCommand).toContain("curl -fsSL");
    expect(result.installScriptUrl).toContain("/install.sh");
    expect(result.guide).toBeNull();
  });

  it("returns batch sourcing guidance for calling Agents", async () => {
    const dataDir = tempDir();
    const result = await sourcingExecute({ action: "batch_guide" }, testContext(dataDir));
    const guide = result.guide as { command: string; dedupe: string[] };

    expect(result.ok).toBe(true);
    expect(guide.command).toContain("npm run batch:sourcing");
    expect(guide.command).toContain("--maxShopsPerBrand=8");
    expect(guide.dedupe.join(" ")).toContain("最终去重");
  });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function testContext(dataDir: string) {
  return {
    dataDir,
    pluginId: "ecommerce-sourcing",
    config: {
      get(key: string) {
        if (key === "legacyProfileRoot") return join(dataDir, "legacy-profiles");
        return "";
      }
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    async stageFile(filePath: string) {
      return filePath;
    }
  };
}
