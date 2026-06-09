/**
 * 完整选品流程
 *
 * 端到端流程：
 * 1. 京东搜索关键词
 * 2. 提取商品列表 + 按策略筛选
 * 3. 逐个进入详情页提取完整信息（SKU/评论/品牌/截图）
 * 4. 用商品图在淘宝以图搜图
 * 5. 提取淘宝供货列表 + 按策略筛选
 * 6. 计算最小规格单价 + 利润率
 * 7. 保存到数据库（含截图/SKU/匹配的淘宝链接）
 *
 * 最终输出：可直接使用的品（符合利润率、发货时效等要求）
 */

import {
  openAiSessionWithAccount,
  aiJdSearch,
  aiExtractJdProducts,
  aiClickProduct,
  aiExtractJdDetail,
  aiTaobaoSearchByImage,
  aiTaobaoSearch,
  aiExtractTaobaoProducts
} from "./ai-controller.js";
import { evaluateJdProductByStrategy, evaluateTaobaoProductByStrategy, evaluateProfitByStrategy, DEFAULT_STRATEGIES } from "./strategy-engine.js";
import { calculateUnitPrice, compareUnitPrice } from "./unit-price.js";
import { profileSummary } from "./accounts.js";

/**
 * 完整选品：单个关键词
 */
export async function fullSelectionFlow(ctx, db, keyword, options = {}) {
  const {
    strategyId = "no-source-arbitrage",
    maxJdCandidates = 10,
    maxTaobaoCandidatesPerJd = 10,
    saveScreenshots = true
  } = options;

  // 解析策略
  const strategy = DEFAULT_STRATEGIES[strategyId] || DEFAULT_STRATEGIES["no-source-arbitrage"];

  console.log(`\n========== 完整选品流程 ==========`);
  console.log(`关键词: ${keyword}`);
  console.log(`策略: ${strategy.name}`);
  console.log(`京东候选数: ${maxJdCandidates}`);
  console.log(`每个京东品搜淘宝数: ${maxTaobaoCandidatesPerJd}`);
  console.log(`=====================================\n`);

  const results = {
    keyword,
    strategy: { id: strategy.id, name: strategy.name },
    jd: { total: 0, passed: 0, rejected: 0, products: [] },
    taobao: { total: 0, passed: 0, rejected: 0, products: [] },
    matched: [],  // 最终可用的品
    startedAt: new Date().toISOString()
  };

  // ===== 阶段1: 京东搜索 + 筛选 =====
  console.log(`[阶段1] 京东搜索并筛选...`);
  const jdSession = await openAiSessionWithAccount(ctx, db, "jd");
  await aiJdSearch(jdSession.page, keyword);

  const jdProducts = await aiExtractJdProducts(jdSession.page, maxJdCandidates * 2);
  results.jd.total = jdProducts.length;

  // 按策略筛选
  const jdEvaluated = jdProducts.map(p => {
    const result = evaluateJdProductByStrategy(p, strategy);
    return { ...p, passed: result.passed, rejectReason: result.reason };
  });

  const jdPassed = jdEvaluated.filter(p => p.passed).slice(0, maxJdCandidates);
  results.jd.passed = jdPassed.length;
  results.jd.rejected = jdProducts.length - jdPassed.length;
  results.jd.products = jdEvaluated;

  console.log(`  京东: ${results.jd.total} 个 → 筛选后 ${results.jd.passed} 个通过\n`);

  if (jdPassed.length === 0) {
    console.log(`  ⚠️  没有符合策略的京东商品`);
    results.completedAt = new Date().toISOString();
    return results;
  }

  // ===== 阶段2: 逐个京东品进入详情页 =====
  console.log(`[阶段2] 提取京东品详情（SKU/评论/品牌）...`);

  for (let i = 0; i < jdPassed.length; i++) {
    const jdProduct = jdPassed[i];
    console.log(`\n  [${i + 1}/${jdPassed.length}] ${jdProduct.title.substring(0, 40)}...`);

    try {
      // 点击进入详情页（模拟人类）
      const clickResult = await aiClickProduct(jdSession.page, i);

      // 提取详情
      const detail = await aiExtractJdDetail(clickResult.page);

      // 合并详情到商品对象
      Object.assign(jdProduct, {
        detailUrl: detail.url,
        fullTitle: detail.title,
        comments: detail.comments,
        sales: detail.sales || jdProduct.sales,
        brand: detail.brand,
        skuInfo: detail.skuInfo,
        params: detail.params
      });

      // 计算最小规格单价
      const unitPriceResult = calculateUnitPrice(jdProduct.price, jdProduct.title, jdProduct.skuInfo);
      Object.assign(jdProduct, {
        unitPrice: unitPriceResult.unitPrice,
        unit: unitPriceResult.unit,
        spec: unitPriceResult.spec
      });

      console.log(`    ✅ 详情已提取: ${detail.comments}评论 | 单价 ¥${unitPriceResult.unitPrice?.toFixed(4) || '?'}/${unitPriceResult.unit || '?'}`);

      // TODO: 保存截图（如果需要）
      if (saveScreenshots) {
        // await clickResult.page.screenshot({ path: `screenshots/jd-${jdProduct.productId}.png` });
      }

      // 返回列表页（为下一个商品做准备）
      await jdSession.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await jdSession.page.waitForTimeout(1500);

    } catch (error) {
      console.log(`    ❌ 提取详情失败: ${error.message}`);
      jdProduct.detailError = error.message;
    }
  }

  // ===== 阶段3: 对每个京东品，去淘宝以图搜图 =====
  console.log(`\n[阶段3] 淘宝以图搜图并比价...`);
  const taobaoSession = await openAiSessionWithAccount(ctx, db, "taobao");

  for (let i = 0; i < jdPassed.length; i++) {
    const jdProduct = jdPassed[i];
    console.log(`\n  [${i + 1}/${jdPassed.length}] 淘宝搜图: ${jdProduct.title.substring(0, 40)}...`);

    try {
      // 用京东商品图搜淘宝
      if (jdProduct.imgSrc) {
        await aiTaobaoSearchByImage(taobaoSession.page, jdProduct.imgSrc);
      } else {
        // 没有图就用关键词
        await aiTaobaoSearch(taobaoSession.page, jdProduct.title.substring(0, 30));
      }

      // 提取淘宝商品
      const taobaoProducts = await aiExtractTaobaoProducts(taobaoSession.page, maxTaobaoCandidatesPerJd);
      results.taobao.total += taobaoProducts.length;

      // 按策略筛选淘宝商品
      const taobaoEvaluated = taobaoProducts.map(p => {
        const result = evaluateTaobaoProductByStrategy(p, strategy);
        return { ...p, passed: result.passed, rejectReason: result.reason };
      });

      const taobaoPassed = taobaoEvaluated.filter(p => p.passed);
      results.taobao.passed += taobaoPassed.length;
      results.taobao.rejected += taobaoProducts.length - taobaoPassed.length;
      results.taobao.products.push(...taobaoEvaluated);

      console.log(`    找到 ${taobaoProducts.length} 个淘宝商品 → ${taobaoPassed.length} 个通过策略`);

      // 对每个通过的淘宝商品，计算单价和利润
      for (const taobaoProduct of taobaoPassed) {
        // 计算淘宝单价
        const taobaoUnitPrice = calculateUnitPrice(taobaoProduct.price, taobaoProduct.title);
        Object.assign(taobaoProduct, {
          unitPrice: taobaoUnitPrice.unitPrice,
          unit: taobaoUnitPrice.unit,
          spec: taobaoUnitPrice.spec
        });

        // 比较单价
        const comparison = compareUnitPrice(jdProduct, taobaoProduct);

        if (comparison.canCompare && comparison.jd.unitPrice && comparison.taobao.unitPrice) {
          // 用策略评估利润
          const profitResult = evaluateProfitByStrategy(
            comparison.jd.unitPrice,
            comparison.taobao.unitPrice,
            strategy
          );

          if (profitResult.passed) {
            // 符合所有条件！
            results.matched.push({
              jd: jdProduct,
              taobao: taobaoProduct,
              comparison,
              profit: profitResult
            });

            console.log(`      ✅ 匹配成功！利润率 ${(profitResult.profitRate * 100).toFixed(1)}%`);
            console.log(`         京东: ¥${comparison.jd.unitPrice.toFixed(4)}/${comparison.jd.unit}`);
            console.log(`         淘宝: ¥${comparison.taobao.unitPrice.toFixed(4)}/${comparison.taobao.unit} (${taobaoProduct.shipFrom || '?'}发货)`);
          } else {
            console.log(`      ⚠️  利润不达标: ${profitResult.reason}`);
          }
        } else {
          console.log(`      ⚠️  无法比较: ${comparison.reason || '单位不同'}`);
        }
      }

    } catch (error) {
      console.log(`    ❌ 淘宝搜索失败: ${error.message}`);
    }
  }

  results.completedAt = new Date().toISOString();

  console.log(`\n========== 选品完成 ==========`);
  console.log(`关键词: ${keyword}`);
  console.log(`京东候选: ${results.jd.passed} 个`);
  console.log(`淘宝供货: ${results.taobao.passed} 个`);
  console.log(`最终匹配: ${results.matched.length} 个可用品`);
  console.log(`===================================\n`);

  return results;
}

/**
 * 批量选品：多个关键词
 */
export async function batchSelection(ctx, db, keywords, options = {}) {
  const allResults = [];

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    console.log(`\n【批量选品 ${i + 1}/${keywords.length}】`);

    try {
      const result = await fullSelectionFlow(ctx, db, keyword, options);
      allResults.push(result);

      // 统计
      const totalMatched = allResults.reduce((sum, r) => sum + r.matched.length, 0);
      console.log(`\n📊 当前进度: ${totalMatched} 个可用品 (目标 ${options.targetCount || 500})`);

      // 达到目标就停止
      if (options.targetCount && totalMatched >= options.targetCount) {
        console.log(`\n🎉 已达成目标 ${options.targetCount} 个品！`);
        break;
      }

    } catch (error) {
      console.error(`\n❌ 关键词 "${keyword}" 选品失败: ${error.message}`);
    }
  }

  return allResults;
}
