import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportMatchesCsv } from "../lib/export.js";
import { buildSelectionReport } from "../lib/report.js";
import { assessSameProductMatch, buildTaobaoSearchKeyword, buildTaobaoSearchKeywords, assessProfit, coreProductMatched, parseCommentCount, parseSalesCount, relevanceScore, taobaoRejectReason } from "../lib/logic.js";
import { buildBrowseLightlyPlan, buildSearchResultUrl, buildSelectionBrowserSessionOptions, mergeJdSearchCardWithDetail, searchPageReflectsKeyword, selectJdCardsForDetailProbe } from "../lib/browser-selection.js";
import { normalizeChromeSessionOptions } from "../lib/chrome.js";
import { openSourcingDb } from "../lib/db.js";
import { resolveStrategyProfile } from "../lib/strategy.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ecommerce sourcing plugin", () => {
  it("builds a compact Taobao keyword from brand and JD title", () => {
    const keyword = buildTaobaoSearchKeyword({
      brand: "Newink",
      title: "Newink还原型辅酶q10纽维可软胶囊供养心肌保护心脏脑血管保健品 2瓶【守护装】健康活力 60粒*2瓶"
    });

    expect(keyword).toBe("Newink 还原型辅酶q10 软胶囊");
  });

  it("builds fallback Taobao keywords with Chinese aliases", () => {
    const keywords = buildTaobaoSearchKeywords({
      brand: "Newink",
      title: "Newink还原型辅酶q10纽维可软胶囊供养心肌保护心脏脑血管保健品 2瓶【守护装】健康活力 60粒*2瓶"
    });

    expect(keywords[0]).toBe("Newink 还原型辅酶q10 软胶囊");
    expect(keywords).toContain("纽维可 还原型辅酶q10 软胶囊");
    expect(keywords).toContain("Newink 纽维可 还原型辅酶q10");
    expect(keywords).toContain("辅酶q10 软胶囊");
  });

  it("requires Taobao titles to contain the core product name", () => {
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

  it("keeps Swisse milk thistle supply candidates relevant", () => {
    const title = "澳洲Swisse/斯维诗二代护旰片胆碱女性男奶蓟草熬夜水飞蓟120粒";
    const keyword = "Swisse 奶蓟草 片";

    expect(coreProductMatched(title, keyword)).toBe(true);
    expect(relevanceScore(title, keyword)).toBeGreaterThanOrEqual(2);
  });

  it("accepts Swisse milk thistle variants as the same product family", () => {
    const review = assessSameProductMatch(
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

    expect(review.matched).toBe(true);
    expect(review.reason).toContain("同品类");
  });

  it("rejects a JD lung-support product matched to a Taobao vitamin C product", () => {
    const review = assessSameProductMatch(
      {
        platform: "jd",
        title: "Swisse养肺片 草本复合维生素VC 呼吸健康 60片",
        skuText: "60片"
      },
      {
        platform: "taobao",
        title: "Swisse斯维诗 维生素C锌泡腾片 VC补充 60片",
        skuText: "60片"
      },
      "Swisse 养肺片"
    );

    expect(review.matched).toBe(false);
    expect(review.reason).toContain("品类不一致");
  });

  it("rejects JD propolis when Taobao returns fish oil under a generic softgel query", () => {
    const review = assessSameProductMatch(
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

    expect(review.matched).toBe(false);
    expect(review.reason).toContain("品类不一致");
  });

  it("parses Taobao sales without merging the price into payer count", () => {
    expect(parseSalesCount("¥96.2 1人付款 北京")).toBe(1);
    expect(parseSalesCount("¥183.87 补贴后 100+人付款")).toBe(100);
    expect(parseSalesCount("49人付款 山东 青岛 48小时内发 包邮")).toBe(49);
  });

  it("parses short JD detail comment counts", () => {
    expect(parseCommentCount("3")).toBe(3);
    expect(parseCommentCount("100+")).toBe(100);
    expect(parseCommentCount("1万+")).toBe(10000);
  });

  it("sends JD buyer-store search cards to detail pages before comment filtering", () => {
    const products = [
      { productId: "self", price: 99, isBuyerStore: false, commentCount: 100 },
      { productId: "buyer-low", price: 101, isBuyerStore: true, commentCount: 0 },
      { productId: "buyer-high", price: 120, isBuyerStore: true, commentCount: 0 }
    ];

    expect(selectJdCardsForDetailProbe(products, { maxJdCandidates: 1 }).map((item) => item.productId))
      .toEqual(["buyer-low", "buyer-high"]);
  });

  it("keeps buyer-store signal from JD search card after detail hydration", () => {
    const merged = mergeJdSearchCardWithDetail(
      { title: "搜索标题", isBuyerStore: true, shopName: "全球营养买手店", price: 101, mainImageUrl: "search.jpg" },
      { title: "Swisse斯维诗 详情标题 护肝片 奶蓟草 120粒", isBuyerStore: false, shopName: "", price: 102, commentCount: 6, mainImageUrl: "detail.jpg" }
    );

    expect(merged.isBuyerStore).toBe(true);
    expect(merged.commentCount).toBe(6);
    expect(merged.shopName).toBe("全球营养买手店");
    expect(merged.title).toBe("Swisse斯维诗 详情标题 护肝片 奶蓟草 120粒");
  });

  it("does not let JD installment text replace the search result title", () => {
    const merged = mergeJdSearchCardWithDetail(
      {
        title: "Swisse斯维诗 胆碱护肝片 奶蓟草片姜黄 熬夜职场高压养肝解酒",
        isBuyerStore: true,
        shopName: "全球营养买手店",
        price: 101,
        mainImageUrl: "search.jpg"
      },
      {
        title: "不分期",
        isBuyerStore: true,
        price: 102,
        commentCount: 6,
        mainImageUrl: "detail.jpg"
      }
    );

    expect(merged.title).toContain("Swisse斯维诗");
    expect(merged.commentCount).toBe(6);
  });

  it("applies rate-based profit assessment with 35%-60% range", () => {
    const result = assessProfit({
      jdTotalPrice: 395.4,
      jdUnitPrice: 197.7,
      taobaoUnitPrice: 140
    });

    expect(result.rule).toBe("rate");
    expect(result.qualified).toBe(true);
    expect(result.profitRate).toBeGreaterThan(0.35);
    expect(result.profitRate).toBeLessThanOrEqual(0.60);
    expect(result.profitAmount).toBe(57.7);

    const tooLow = assessProfit({ jdUnitPrice: 100, taobaoUnitPrice: 90 });
    expect(tooLow.qualified).toBe(false);
    expect(tooLow.reason).toContain("不足 35%");

    const tooHigh = assessProfit({ jdUnitPrice: 200, taobaoUnitPrice: 100 });
    expect(tooHigh.qualified).toBe(false);
    expect(tooHigh.reason).toContain("超过 60%");
  });

  it("exports candidates when a run has no matched supply", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
    tempDirs.push(dataDir);
    const db = openSourcingDb({ dataDir });
    try {
      const runId = db.startRun({
        keyword: "辅酶Q10",
        strategyProfileId: "conservative",
        strategy: { jdPages: 1, maxJdCandidates: 1 }
      });
      db.appendRunTaobaoKeyword(runId, {
        jdProductId: "jd-1",
        jdTitle: "京东候选",
        keyword: "品牌 核心品名"
      });
      db.saveCandidate(runId, {
        platform: "jd",
        productId: "jd-1",
        title: "京东候选",
        url: "https://item.jd.com/1.html",
        price: 398,
        unitPrice: 199,
        skuText: "2瓶",
        shopName: "买手店",
        mainImageUrl: "",
        sourceAccountId: "jd-account"
      }, "passed", "京东候选通过");
      db.saveCandidate(runId, {
        platform: "taobao",
        productId: "tb-1",
        title: "淘宝淘汰候选",
        url: "https://item.taobao.com/item.htm?id=1",
        price: 99,
        unitPrice: 99,
        skuText: "1瓶",
        shopName: "",
        mainImageUrl: "",
        sourceAccountId: "taobao-account"
      }, "rejected", "淘宝标题与京东商品不匹配");
      db.saveArtifact(runId, {
        platform: "jd",
        productId: "jd-1",
        artifactType: "product_image",
        label: "京东主图",
        filePath: join(dataDir, "assets", "jd-1.jpg"),
        sourceUrl: "https://example.com/jd-1.jpg"
      });

      const exported = exportMatchesCsv({ dataDir }, db, runId);

      expect(exported.mode).toBe("candidates");
      expect(exported.rows).toBe(2);
      expect(exported.metadata?.strategyProfileId).toBe("conservative");
      expect(exported.metadata?.taobaoKeywords).toContain("品牌 核心品名");
      expect(exported.metadata?.artifactCount).toBe(1);
      expect(db.listArtifacts(runId)).toHaveLength(1);
      const csv = readFileSync(exported.filePath, "utf8");
      const taobaoRow = csv.split("\n").find((line) => line.includes("淘宝淘汰候选"));
      expect(taobaoRow).toBeDefined();
      expect(taobaoRow).not.toContain("assets/jd-1.jpg");
    } finally {
      db.close();
    }
  });

  it("generates a markdown report with candidates, reasons and artifacts", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
    tempDirs.push(dataDir);
    const db = openSourcingDb({ dataDir });
    try {
      const runId = db.startRun({
        keyword: "辅酶Q10",
        strategyProfileId: "conservative",
        strategy: { jdPages: 1, maxJdCandidates: 1 }
      });
      db.appendRunTaobaoKeyword(runId, {
        jdProductId: "jd-1",
        jdTitle: "京东候选",
        keyword: "品牌 核心品名"
      });
      db.saveCandidate(runId, {
        platform: "jd",
        productId: "jd-1",
        title: "京东候选",
        url: "https://item.jd.com/1.html",
        price: 398,
        unitPrice: 199,
        skuText: "2瓶",
        shopName: "买手店",
        mainImageUrl: "",
        sourceAccountId: "jd-account"
      }, "passed", "京东候选通过");
      db.saveCandidate(runId, {
        platform: "taobao",
        productId: "tb-1",
        title: "淘宝淘汰候选",
        url: "https://item.taobao.com/item.htm?id=1",
        price: 99,
        unitPrice: 99,
        skuText: "1瓶",
        shopName: "",
        mainImageUrl: "",
        sourceAccountId: "taobao-account"
      }, "rejected", "淘宝标题与京东商品不匹配");
      db.saveArtifact(runId, {
        platform: "jd",
        productId: "jd-1",
        artifactType: "page_screenshot",
        label: "京东截图",
        filePath: join(dataDir, "artifacts", "jd.png"),
        sourceUrl: "https://item.jd.com/1.html"
      });
      db.updateRun(runId, {
        status: "completed",
        jdRawCount: 1,
        jdFilteredCount: 1,
        taobaoRawCount: 1,
        taobaoFilteredCount: 0,
        eligibleCount: 0,
        completedAt: new Date().toISOString()
      });

      const report = buildSelectionReport({ dataDir }, db, runId);
      const markdown = readFileSync(report.filePath, "utf8");

      expect(report.summary.runId).toBe(runId);
      expect(report.summary.artifactCount).toBe(1);
      expect(markdown).toContain("# 电商选品任务报告");
      expect(markdown).toContain("淘宝淘汰候选");
      expect(markdown).toContain("淘宝标题与京东商品不匹配");
      expect(markdown).toContain("jd.png");
      expect(markdown).toContain("下一步");
    } finally {
      db.close();
    }
  });

  it("resolves a reusable strategy preset with explicit overrides", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
    tempDirs.push(dataDir);
    const db = openSourcingDb({ dataDir });
    try {
      const resolved = resolveStrategyProfile(db, {
        strategyPreset: "health-products",
        strategy: { jdPages: 1, maxTaobaoSearches: 1 }
      });

      expect(resolved.profile.id).toBe("health-products");
      expect(resolved.strategy.maxJdCandidates).toBe(5);
      expect(resolved.strategy.jdPages).toBe(1);
      expect(resolved.strategy.maxTaobaoSearches).toBe(1);
      expect(resolved.strategy.maxTaobaoKeywordAttempts).toBe(2);
      expect(resolved.strategy.minTaobaoSales).toBe(10);
    } finally {
      db.close();
    }
  });

  it("defaults to health-products strategy and conservative fallback", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
    tempDirs.push(dataDir);
    const db = openSourcingDb({ dataDir });
    try {
      const resolved = resolveStrategyProfile(db, {});

      expect(resolved.profile.id).toBe("health-products");
      expect(resolved.strategy.jdPages).toBe(3);
      expect(resolved.strategy.maxJdCandidates).toBe(5);
      expect(resolved.strategy.maxTaobaoSearches).toBe(3);
      expect(resolved.strategy.maxTaobaoKeywordAttempts).toBe(2);
    } finally {
      db.close();
    }
  });

  it("ignores blank config values when resolving strategy profiles", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ecommerce-sourcing-test-"));
    tempDirs.push(dataDir);
    const db = openSourcingDb({ dataDir });
    try {
      const resolved = resolveStrategyProfile(db, {}, {
        requireDomesticShipping: "",
        requireFastShippingHours: "",
        minTaobaoSales: ""
      });

      expect(resolved.strategy.requireDomesticShipping).toBe(true);
      expect(resolved.strategy.requireFastShippingHours).toBe(48);
      expect(resolved.strategy.minTaobaoSales).toBe(10);
    } finally {
      db.close();
    }
  });

  it("detects stale Taobao search pages before extracting product cards", () => {
    const keyword = "纽维可 还原型辅酶q10 软胶囊";

    expect(searchPageReflectsKeyword(
      "taobao",
      "https://www.taobao.com/",
      "广州地址挂靠执照",
      keyword
    )).toBe(false);
    expect(searchPageReflectsKeyword(
      "taobao",
      "https://s.taobao.com/search?q=%E7%BA%BD%E7%BB%B4%E5%8F%AF%20%E8%BF%98%E5%8E%9F%E5%9E%8B%E8%BE%85%E9%85%B6q10%20%E8%BD%AF%E8%83%B6%E5%9B%8A",
      "广州地址挂靠执照",
      keyword
    )).toBe(true);
  });

  it("builds conservative search result fallback URLs", () => {
    expect(buildSearchResultUrl("taobao", "纽维可 还原型辅酶q10 软胶囊"))
      .toBe("https://s.taobao.com/search?q=%E7%BA%BD%E7%BB%B4%E5%8F%AF%20%E8%BF%98%E5%8E%9F%E5%9E%8B%E8%BE%85%E9%85%B6q10%20%E8%BD%AF%E8%83%B6%E5%9B%8A");
    expect(buildSearchResultUrl("jd", "辅酶Q10"))
      .toBe("https://search.jd.com/Search?keyword=%E8%BE%85%E9%85%B6Q10&enc=utf-8");
  });

  it("builds non-fixed lightweight browsing plans inside the viewport", () => {
    const planA = buildBrowseLightlyPlan({
      viewport: { width: 1280, height: 720 },
      random: sequenceRandom([0.1, 0.2, 0.3, 0.4, 0.5])
    });
    const planB = buildBrowseLightlyPlan({
      viewport: { width: 1280, height: 720 },
      random: sequenceRandom([0.8, 0.7, 0.6, 0.5, 0.4])
    });

    expect(planA).not.toEqual(planB);
    expect(planA.filter((step) => step.type === "wheel").length).toBeGreaterThanOrEqual(2);
    for (const step of planA.filter((item) => item.type === "move")) {
      expect(step.x).toBeGreaterThanOrEqual(20);
      expect(step.x).toBeLessThanOrEqual(1260);
      expect(step.y).toBeGreaterThanOrEqual(20);
      expect(step.y).toBeLessThanOrEqual(700);
    }
  });

  it("keeps selection browser windows open by default while allowing explicit close", () => {
    expect(buildSelectionBrowserSessionOptions({})).toEqual({
      keepAlive: true,
      closeOtherPages: false,
      newPage: true
    });
    expect(buildSelectionBrowserSessionOptions({ keepBrowserOpen: false, openTaskTab: false })).toEqual({
      keepAlive: false,
      closeOtherPages: false,
      newPage: false
    });
    expect(normalizeChromeSessionOptions(buildSelectionBrowserSessionOptions({})).keepAlive).toBe(true);
  });
});

function sequenceRandom(values: number[]) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}
