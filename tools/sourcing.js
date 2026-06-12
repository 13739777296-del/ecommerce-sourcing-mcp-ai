/**
 * MCP工具：电商选品（All-in-One）
 *
 * 一个MCP工具，多个action，覆盖所有场景：
 * - 策略库管理
 * - 单步操作（搜索/提取/详情）
 * - 分段 Agent 选品
 */

import { openAiSessionWithAccount, openAiSession, aiJdSearch, aiExtractJdProducts, aiClickProduct, aiExtractJdDetail, aiJdHarvest, aiTaobaoHarvest, aiTaobaoSearchByImage, aiTaobaoSearch, aiExtractTaobaoProducts } from "../lib/ai-controller.js";
import { profileSummary, createAccount, removeAccount, setAccountStatus, accountLoginUrl, probeAccountLoginStatus } from "../lib/accounts.js";
import { evaluateJdProductByStrategy, evaluateTaobaoProductByStrategy, DEFAULT_STRATEGIES, findBannedBrandMatch } from "../lib/strategy-engine.js";
import { buildTaobaoSearchKeywords, extractBrand, resolveBrandForTaobao } from "../lib/logic.js";
import { calculateUnitPrice } from "../lib/unit-price.js";
import { buildAiReviewTask, dbRowToJdProduct } from "../lib/ai-review-task.js";

import { openSourcingDb } from "../lib/db.js";
import { join as pathJoin, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { exportToFeishu, bindFeishu, sendFeishuMsg, startFeishuChannel, readFeishuMsgs } from "../lib/feishu.js";
import { buildBootstrapGuide, buildWorkerInstallCommand, installScriptUrl } from "../lib/bootstrap-guide.js";

export const description = "电商选品All-in-One工具。支持：账号池、策略库、京东候选入库、淘宝供货采集、结果保存、日志和导出。推荐由 Agent 分段执行。";

/**
 * MCP入口：runtime 调用的是 execute(args, ctx)。
 * 这里开 db，再转交给 handler(ctx, db, input)。
 */
export async function execute(args, ctx) {
  const db = openSourcingDb(ctx);
  try {
    return await handler(ctx, db, args || {});
  } finally {
    db.close();
  }
}

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "strategy_list", "strategy_get", "strategy_save", "strategy_templates", "usage_guide", "batch_guide", "bootstrap",
        "warmup",
        "jd_search", "jd_extract", "jd_detail", "jd_search_filter", "jd_harvest",
        "taobao_search", "taobao_search_image", "taobao_extract", "taobao_harvest",
        "account_list", "account_add", "account_login", "account_check", "account_remove",
        "sourcing_list", "logs", "export_results", "export_feishu", "ai_review_task", "save_sourcing", "bind_feishu", "start_feishu_channel", "check_feishu_msgs", "notify_user",
        "close"
      ],
      description: `操作类型：
        策略库: strategy_list/get/save/templates
        京东单步: jd_search/extract/detail/search_filter
        京东选品(推荐): jd_harvest —— 搜"品牌+买手店"收集买手店名→只搜店名→进详情拿评价→筛评价>=策略门槛
        淘宝单步: taobao_search/search_image/extract
        数据: ai_review_task/save_sourcing/sourcing_list/logs/export_results/export_feishu
        批量: batch_guide 查看批量选品脚本和断点续跑方式
        关闭: close`
    },
    keyword: {
      type: "string",
      description: "搜索关键词"
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "批量关键词"
    },
    platform: {
      type: "string",
      enum: ["jd", "taobao"],
      default: "jd"
    },
    mode: {
      type: "string",
      enum: ["guide", "command"],
      default: "guide",
      description: "bootstrap 用：guide 返回完整初始化说明，command 只返回一条安装命令"
    },
    accountId: {
      type: "string",
      description: "账号管理和采集执行用：account_login/check/remove 指定账号ID；jd_harvest/taobao_harvest/单步搜索可指定使用某个已登录账号"
    },
    displayName: {
      type: "string",
      description: "账号管理用：account_add 新账号的显示名(如'京东账号一')"
    },
    maxCount: {
      type: "number",
      default: 10
    },
    limit: {
      type: "number",
      default: 50,
      description: "logs / sourcing_list 用：最多返回多少条"
    },
    productIndex: {
      type: "number",
      default: 0
    },
    strategyId: {
      type: "string",
      default: "no-source-arbitrage"
    },
    strategy: {
      type: "object",
      description: "自定义策略对象"
    },
    imageUrl: {
      type: "string",
      description: "淘宝以图搜图的图片URL"
    },
    maxJdCandidates: {
      type: "number",
      default: 10
    },
    maxTaobaoCandidatesPerJd: {
      type: "number",
      default: 10
    },
    brand: {
      type: "string",
      description: "jd_harvest用：品牌词(如GNC)，内部拼成\"品牌 买手店\"搜索"
    },
    allowedBrands: {
      type: "array",
      items: { type: "string" },
      description: "jd_harvest用：可用品牌池。搜到买手店后，店铺页中匹配任一可用品牌的商品都可进入详情；不传则只保留当前brand。"
    },
    targetCount: {
      type: "number",
      default: 10,
      description: "jd_harvest用：目标去重商品数。建议小批量分段执行，先 3-10 个验证流程，再逐步增加。"
    },
    maxPagesPerShop: {
      type: "number",
      default: 3,
      description: "jd_harvest用：每个买手店最多翻几页(每页约60品)"
    },
    maxShopsPerBrand: {
      type: "number",
      default: 12,
      description: "jd_harvest用：每个品牌最多尝试多少个买手店，避免冷门品牌长时间空转"
    },
    maxDetailPerShop: {
      type: "number",
      default: 12,
      description: "jd_harvest用：每个买手店最多进入多少个商品详情，避免低质量店铺消耗账号操作次数"
    },
    maxConsecutiveCommentRejectsPerShop: {
      type: "number",
      default: 8,
      description: "jd_harvest用：同一买手店连续多少个详情评论不达标后跳过该店"
    },
    minSales: {
      type: "number",
      default: 10,
      description: "taobao_harvest用：最低已售(人付款)门槛"
    },
    requireDomestic: {
      type: "boolean",
      default: true,
      description: "taobao_harvest用：是否只要国内发货"
    },
    require48h: {
      type: "boolean",
      default: true,
      description: "taobao_harvest用：是否只要48小时内发货"
    },
    message: {
      type: "string",
      description: "notify_user用：发送给用户的消息内容"
    },
    jdProduct: {
      type: "object",
      description: "ai_review_task/save_sourcing用：京东品(需含productId/title/price/shop/shopType等)"
    },
    jdProductId: {
      type: "string",
      description: "ai_review_task用：从本地库读取已保存的京东候选"
    },
    taobaoCandidates: {
      type: "array",
      description: "ai_review_task用：taobao_harvest返回的淘宝候选数组，由Agent做同款/SKU/利润审核"
    },
    taobaoMatches: {
      type: "array",
      description: "save_sourcing用：匹配的淘宝品列表(每个需含taobao对象+profit对象)"
    }
  },
  required: ["action"]
};

// 工作前登录预检：遍历该平台所有账号，用第一个真正登录的。
// 全部不可用才报错(提示扫码)。这样掉登录的账号会被自动跳过，不卡工作。
async function openSessionChecked(ctx, db, platform, accountId = null) {
  if (accountId) {
    const account = db.getAccount(accountId);
    if (!account) {
      const err = new Error(`账号不存在：${accountId}`);
      err.code = "NOT_LOGGED_IN";
      err.accountId = accountId;
      throw err;
    }
    if (account.platform !== platform) {
      const expected = platform === "jd" ? "京东" : "淘宝";
      const actual = account.platform === "jd" ? "京东" : "淘宝";
      throw new Error(`账号平台不匹配：当前操作需要${expected}账号，但传入的是${actual}账号。`);
    }
    if (account.status === "available") {
      console.log(`[预检] 使用调用方指定账号「${account.displayName}」`);
      return await openAiSessionWithAccount(ctx, db, platform, "about:blank", account.id);
    }
    const probe = await probeAccountLoginStatus(account);
    setAccountStatus(db, account.id, probe.status, probe.event);
    if (probe.status === "available") {
      console.log(`[预检] 指定账号「${account.displayName}」已恢复可用，开始工作`);
      return await openAiSessionWithAccount(ctx, db, platform, "about:blank", account.id);
    }
    const err = new Error(`指定账号不可用：${account.displayName}（${probe.event}）`);
    err.code = "NOT_LOGGED_IN";
    err.accountId = account.id;
    throw err;
  }

  const accounts = db.listAccounts(platform);
  if (!accounts.length) {
    const err = new Error(`没有${platform === "jd" ? "京东" : "淘宝"}账号，请先 account_add 再 account_login。`);
    err.code = "NOT_LOGGED_IN";
    throw err;
  }
  // 优先用数据库里已知可用的账号（避免每次都开Chrome probe）
  const knownGood = accounts.find((a) => a.status === "available" && a.platform === platform);
  if (knownGood) {
    // 信任数据库状态（最近account_check验证过的），不开Chrome重查
    console.log(`[预检] 账号「${knownGood.displayName}」状态可用，直接使用`);
    return await openAiSessionWithAccount(ctx, db, platform, "about:blank", knownGood.id);
  }
  // 没有已知可用的，逐个probe
  const tried = [];
  for (const acct of accounts) {
    const probe = await probeAccountLoginStatus(acct);
    setAccountStatus(db, acct.id, probe.status, probe.event);
    if (probe.status === "available") {
      console.log(`[预检] 账号「${acct.displayName}」已登录，开始工作`);
      return await openAiSessionWithAccount(ctx, db, platform, "about:blank", acct.id);
    }
    tried.push(`${acct.displayName}(${probe.event})`);
  }
  // 全部不可用
  const err = new Error(
    `${platform === "jd" ? "京东" : "淘宝"}没有已登录的账号。已检查：${tried.join("、")}。` +
    `请先 account_login 扫码登录任一账号再重试。`
  );
  err.code = "NOT_LOGGED_IN";
  throw err;
}

// 从策略引擎/数据库策略库读默认值，调用方可覆盖。
function loadStrategyDefaults(db, strategyId) {
  const s = getStrategyById(db, strategyId) || DEFAULT_STRATEGIES["no-source-arbitrage"];
  const base = DEFAULT_STRATEGIES["no-source-arbitrage"];
  const normalized = {
    id: s.id,
    name: s.name,
    jd: {
      searchSuffix: s.platforms?.jd?.searchSuffix || "",
      collectShopNames: s.platforms?.jd?.collectShopNames !== false,
      shopTypes: s.platforms?.jd?.shopTypes || { include: ["buyer"], exclude: [] },
      minComments: s.platforms?.jd?.minComments ?? 2,
      priceRange: s.platforms?.jd?.priceRange || [80, 999999]
    },
    taobao: {
      shipFrom: s.platforms?.taobao?.shipFrom || "domestic",
      shipWithinHours: s.platforms?.taobao?.shipWithinHours ?? 48,
      minSales: s.platforms?.taobao?.minSales ?? 10,
      priceRange: s.platforms?.taobao?.priceRange || [80, 999999]
    },
    profit: {
      minRate: s.profit?.minRate ?? 0.35,
      maxRate: s.profit?.maxRate ?? 0.60,
      minAmount: s.profit?.minAmount ?? 20
    },
    riskControl: {
      retryAfterHours: s.riskControl?.retryAfterHours ?? base.riskControl?.retryAfterHours ?? 5,
      notifyOnDetection: s.riskControl?.notifyOnDetection ?? base.riskControl?.notifyOnDetection ?? true,
      maxRetries: s.riskControl?.maxRetries ?? base.riskControl?.maxRetries ?? 3,
      bannedBrands: Array.isArray(s.riskControl?.bannedBrands)
        ? s.riskControl.bannedBrands
        : (base.riskControl?.bannedBrands || [])
    }
  };
  return {
    ...normalized,
    strategy: {
      id: normalized.id,
      name: normalized.name,
      platforms: {
        jd: normalized.jd,
        taobao: normalized.taobao
      },
      profit: normalized.profit,
      riskControl: normalized.riskControl
    }
  };
}

function enrichJdCandidateForStorage(candidate) {
  const unitPriceResult = calculateUnitPrice(candidate.price, candidate.title, candidate.skuInfo || "");
  return {
    ...candidate,
    unitPrice: candidate.unitPrice ?? unitPriceResult.unitPrice,
    unit: candidate.unit || unitPriceResult.unit || "",
    spec: candidate.spec || unitPriceResult.spec || null,
    unitPriceFormula: unitPriceResult.formula || ""
  };
}

function saveJdCandidate(db, candidate, strategy) {
  db.saveSourcing({
    productId: candidate.productId,
    title: candidate.title,
    price: candidate.price,
    unitPrice: candidate.unitPrice,
    unit: candidate.unit,
    shop: candidate.shop,
    shopType: candidate.shopType || "buyer",
    comments: String(candidate.commentsNum || candidate.comments || ""),
    skuInfo: candidate.skuInfo || "",
    brand: resolveBrandForTaobao(candidate) || candidate.brand || extractBrand(candidate.title),
    url: candidate.url,
    screenshotPath: candidate.screenshotPath || ""
  }, [], null, { id: strategy.id });
}

function keywordBannedByStrategy(keyword, strategy) {
  const banned = findBannedBrandMatch({ title: keyword, brand: keyword }, strategy);
  if (!banned) return null;
  return {
    ok: false,
    code: "BANNED_BRAND",
    bannedBrand: banned.name,
    message: `关键词命中策略禁售品牌「${banned.name}」，已停止执行。请先换品牌或修改策略库。`
  };
}

function normalizeAllowedBrands(allowedBrands, strategy) {
  if (!Array.isArray(allowedBrands)) return [];
  const seen = new Set();
  const result = [];
  for (const item of allowedBrands) {
    const brand = String(item || "").trim();
    if (!brand) continue;
    if (keywordBannedByStrategy(brand, strategy)) continue;
    const key = brand.toLowerCase().replace(/\s+/g, "");
    if (key.length < 2 || seen.has(key) || isGenericAllowedBrand(brand)) continue;
    seen.add(key);
    result.push(brand);
  }
  return result;
}

function isGenericAllowedBrand(brand) {
  const key = String(brand || "").toLowerCase().replace(/[\s/_-]+/g, "");
  return /^(?:other|others|unknown|misc|nobrand|generic|其他|其它|无品牌)$/.test(key);
}

function getStrategyById(db, strategyId) {
  const id = strategyId || "no-source-arbitrage";
  if (DEFAULT_STRATEGIES[id]) return DEFAULT_STRATEGIES[id];
  const profile = db?.getStrategyProfile?.(id);
  if (!profile?.strategy) return null;
  return strategyProfileToStrategy(profile);
}

function strategyProfileToStrategy(profile) {
  return {
    id: profile.id,
    name: profile.name || profile.id,
    description: profile.description || "",
    ...(profile.strategy || {})
  };
}

export async function handler(ctx, db, input) {
  const action = input.action;
  const platform = input.platform || "jd";
  profileSummary(ctx, db);

  try {
    // ===== 预热：检查已有浏览器和登录状态（不开关浏览器）=====
    if (action === "warmup") {
      const platforms = input.platform ? [input.platform] : ["jd", "taobao"];
      const report = {};
      for (const p of platforms) {
        report[p] = [];
        const accounts = db.listAccounts(p);
        if (accounts.length === 0) {
          report[p].push({ displayName: "(无账号)", status: "none", ready: false, event: `请先 account_add 添加${p==="jd"?"京东":"淘宝"}账号` });
          continue;
        }
        // 只读数据库状态，不 probe（探测要开Chrome，会打断已有窗口）
        for (const acct of accounts) {
          report[p].push({
            displayName: acct.displayName,
            status: acct.status,
            lastEvent: acct.lastEvent,
            ready: acct.status === "available",
            note: acct.status === "available" ? "可工作" : "需 account_login 扫码登录"
          });
        }
      }
      const readyCount = Object.values(report).flat().filter(a => a.ready).length;
      const totalCount = Object.values(report).flat().length;
      return {
        ok: true, action, report, readyCount, totalCount,
        allReady: readyCount === totalCount,
        message: `${readyCount}/${totalCount} 个账号就绪` +
          (readyCount < totalCount ? "。未就绪的: " + Object.values(report).flat().filter(a=>!a.ready).map(a=>a.displayName).join("、") + "，请 account_login" : "，可以开始工作"),
      };
    }

    // ===== 使用指南（Agent接此MCP后先看这里）=====
    if (action === "usage_guide") {
      return {
        ok: true,
        action,
        guide: {
          name: "电商选品MCP",
          description: "一套通用AI驱动选品引擎。京东找买手店候选 → 淘宝比价 → 筛选利润 → 导出表格。策略可配，引擎通用。",
          workflow: "jd_harvest(京东候选先入库) → Agent从标题提取品牌+核心品名 → taobao_harvest(以此为keyword) → ai_review_task生成审核包 → Agent/多模态模型亲自做同款+SKU换算+利润判断 → save_sourcing写入淘宝匹配 → sourcing_list确认 → 导出",
          actions: {
            core: [
              { name: "jd_harvest", desc: "京东选品：搜品牌+买手店找买手店名→只搜店名→进详情→评价>=策略门槛", params: "brand, accountId(可选指定账号), targetCount(默认10), maxPagesPerShop(默认3), maxShopsPerBrand(默认12), maxDetailPerShop(默认12), maxConsecutiveCommentRejectsPerShop(默认8)" },
              { name: "taobao_harvest", desc: "淘宝比价：搜关键词→筛国内+48h+已售→进详情→SKU+截图", params: "keyword, accountId(可选指定账号), minSales(默认10), requireDomestic, require48h" },
            ],
            data: [
              { name: "ai_review_task", desc: "生成AI审核任务包：只给证据、策略和输出格式，不由脚本裁决同款、SKU单位价或利润", params: "jdProduct或jdProductId, taobaoCandidates, keyword, strategyId" },
              { name: "save_sourcing", desc: "Agent匹配后存库：京东品+淘宝匹配列表→入库，供导出用", params: "jdProduct, taobaoMatches, strategyId" },
              { name: "sourcing_list", desc: "查看当前已入库的京东候选和淘宝匹配数量，适合断点续跑或导出前确认", params: "limit" },
              { name: "logs", desc: "查看最近 MCP 操作日志，排查哪一步失败或是否已经入库", params: "limit" },
              { name: "export_results", desc: "导出CSV到本地，表格含京东+淘宝+利润+链接；导出前会按同款商品最终去重" },
              { name: "export_feishu", desc: "导出飞书多维表格，截图嵌单元格在线看；导出前会按同款商品最终去重。需先bind_feishu绑定" },
              { name: "batch_guide", desc: "返回批量选品脚本用法，适合目标100个可用品这种长任务" },
            ],
            feishu: [
              { name: "bind_feishu", desc: "扫码绑定飞书（一次就行，零配置）" },
              { name: "notify_user", desc: "通过飞书发通知给用户（仅通知，不是聊天）", note: "飞书是单向通知渠道。如需双向对话，用Hermes/OpenClaw等工具接入本MCP" },
            ],
            accounts: [
              { name: "account_list", desc: "列出所有账号及状态" },
              { name: "account_login", desc: "打开浏览器扫码登录账号" },
              { name: "account_check", desc: "探测账号真实登录态" },
            ],
            strategy: [
              { name: "strategy_templates", desc: "查看内置策略模板" },
              { name: "strategy_get", desc: "查看策略详情(strategyId)" },
            ]
          },
          tips: [
            "京东第一段搜'品牌+买手店'(如GNC 买手店)找买手店名；第二段只搜买手店名，不拼产品名。批量脚本会传入allowedBrands，买手店页里命中任一可用品牌的商品都可进入详情。",
            "多个账号可用时，调用方可在 jd_harvest / taobao_harvest / 单步搜索里传 accountId，明确指定本次使用哪个账号；账号平台不匹配会直接拒绝，不会打开浏览器。",
            "禁售品牌在策略库 riskControl.bannedBrands 里配置，命中后不启动采集、不入库。",
            "jd_harvest会先保存京东候选；返回后，Agent必须从标题提取'品牌+核心品名'（别带规格），再调用taobao_harvest。",
            "taobao_harvest只返回通过基础规则的淘宝候选；如果 selectedSkuRejectReason 不为空，该候选会进入 rejected，Agent不要拿它入库",
            "taobao_harvest之后建议先调用ai_review_task生成审核包。最终同款复核、SKU单位价和利润计算必须由Agent/AI根据标题、SKU、截图和页面字段完成，脚本字段只能当提示。",
            "Agent完成同款复核、单位价和利润计算后，必须调用save_sourcing把匹配结果写回库",
            "导出前建议调用sourcing_list确认 taobaoMatchCount 是否大于0；如果全是0，说明还只存了京东候选，没完成淘宝匹配入库",
            "Agent负责清洗: 算最小规格单价、同款去重、按策略利润筛选(默认35%-60%且最低20元)。代码不会替Agent做最终裁决。",
            "最终CSV/飞书导出会再次按品牌+核心品名+剂量做同款去重，导出count就是最终去重后的商品数；如果没达标，Agent继续跑下一批即可。",
            "筛选逻辑从策略引擎读取(loadStrategyDefaults)，改策略文件即生效",
            "浏览器永不关闭(避免风控)，账号存本机(用户隔离)",
            "CSV表格嵌不了图，飞书表格可以嵌图在线看"
          ]
        },
        message: "使用指南已返回，请按 guide.actions 查看可用操作"
      };
    }

    if (action === "batch_guide") {
      return {
        ok: true,
        action,
        guide: {
          purpose: "批量采集选品候选，适合为“最终找满100个不重复可用品”持续生成待AI审核任务包。脚本调用同一个 MCP 工具入口，仍然使用本机正式 Chrome 和账号池；最终同款/SKU/利润由调用方Agent审核。",
          command: "npm run batch:sourcing -- --target=100 --maxPendingReviews=30 --brands=$HOME/.ecommerce-sourcing-agent/brand-queue.json --maxShopsPerBrand=8 --maxDetailPerShop=12 --maxConsecutiveCommentRejectsPerShop=8 --exportFeishu=true",
          brandQueueFormat: [
            "JSON 数组: [\"GNC\", \"Nature Made\"]",
            "或对象: { \"brands\": [\"GNC\", \"Nature Made\"] }"
          ],
          dedupe: [
            "最终计数不是简单京东ID计数，而是按品牌+核心品名+剂量生成商品指纹。",
            "CSV 和飞书导出也使用同一套最终去重逻辑。",
            "批量脚本只生成 review-task JSON，不会自动写入淘宝匹配；如果 export_results/export_feishu 返回的 count 小于目标数，Agent 应审核更多任务包并继续执行下一批品牌。",
            "真正通过/淘汰、单位价、利润仍由调用方Agent审核后save_sourcing。"
          ],
          reviewTasks: [
            "任务包默认保存到 $HOME/.ecommerce-sourcing-agent/review-tasks。",
            "每个任务包包含一个京东候选、淘宝候选、截图路径、策略阈值和输出格式。",
            "Agent读取任务包后亲自做同款判断、SKU换算和利润计算，确认后调用save_sourcing。",
            "--target 表示真正已经save_sourcing入库且利润达标的去重可用品数量；待AI审核任务不计入target。",
            "--maxPendingReviews 控制未审核任务包上限，达到后暂停采集，避免积压大量未审核候选。"
          ],
          safeRun: [
            "遇到验证码、安全验证、访问频繁、登录失效会停止，由 Agent 通知用户处理。",
            "每个买手店默认最多进 12 个详情，连续 8 个评论不达标会跳过该店，避免低质量店铺消耗账号操作次数。",
            "浏览器会话默认保持打开，不主动清空 profile。",
            "排查问题先调用 logs；jd_harvest 会记录店铺命中/跳过摘要，taobao_harvest 会记录基础规则筛选和淘汰原因摘要。"
          ]
        },
        message: "已返回批量选品脚本用法和最终去重规则"
      };
    }

    if (action === "bootstrap") {
      const command = buildWorkerInstallCommand();
      const mode = input.mode || "guide";
      return {
        ok: true,
        action,
        mode,
        installScriptUrl: installScriptUrl(),
        installCommand: command,
        guide: mode === "command" ? null : buildBootstrapGuide(),
        message: mode === "command"
          ? `请在需要操作 Chrome 的用户电脑运行：${command}`
          : "已返回本机 worker 初始化说明。服务器 MCP 只排队转发，真正打开 Chrome 的是用户电脑 local-worker。"
      };
    }

    // ===== 策略库管理 =====
    if (action === "strategy_templates") {
      return {
        ok: true,
        action,
        templates: Object.values(DEFAULT_STRATEGIES),
        message: `${Object.keys(DEFAULT_STRATEGIES).length} 个策略模板`
      };
    }

    if (action === "strategy_list") {
      const customProfiles = db.listStrategyProfiles().filter((profile) => !DEFAULT_STRATEGIES[profile.id]);
      return {
        ok: true,
        action,
        strategies: [...Object.values(DEFAULT_STRATEGIES), ...customProfiles.map(strategyProfileToStrategy)],
        message: `${Object.keys(DEFAULT_STRATEGIES).length + customProfiles.length} 个策略`
      };
    }

    if (action === "strategy_get") {
      const strategy = getStrategyById(db, input.strategyId);
      if (!strategy) return { ok: false, message: `策略不存在: ${input.strategyId}` };
      return { ok: true, action, strategy };
    }

    if (action === "strategy_save") {
      const strategy = input.strategy;
      if (!strategy || typeof strategy !== "object") return { ok: false, action, message: "缺少 strategy 对象" };
      if (!strategy.id) return { ok: false, action, message: "strategy.id 必填" };
      if (DEFAULT_STRATEGIES[strategy.id]) return { ok: false, action, message: "内置策略不可覆盖，请换一个 strategy.id" };
      db.upsertStrategyProfile({
        id: String(strategy.id),
        name: String(strategy.name || strategy.id),
        description: String(strategy.description || ""),
        strategy,
        builtin: false
      });
      return { ok: true, action, strategy, message: `策略已保存：${strategy.id}` };
    }

    // ===== 账号池管理（每个用户管自己的账号，存本机，隔离）=====
    if (action === "account_list") {
      const accounts = db.listAccounts(input.platform || null).map((a) => ({
        id: a.id,
        platform: a.platform,
        displayName: a.displayName,
        status: a.status,
        lastEvent: a.lastEvent
      }));
      return {
        ok: true,
        action,
        count: accounts.length,
        accounts,
        message: `共 ${accounts.length} 个账号（status: available可用 / login_required需登录 / paused风控暂停）`
      };
    }

    if (action === "account_add") {
      const account = createAccount(ctx, db, {
        platform: input.platform || "jd",
        displayName: input.displayName
      });
      return {
        ok: true,
        action,
        account: { id: account.id, platform: account.platform, displayName: account.displayName, status: account.status },
        loginUrl: accountLoginUrl(account.platform),
        nextStep: `账号已创建。下一步调 account_login(accountId:"${account.id}") 打开浏览器扫码登录。`,
        message: "账号已创建，待登录"
      };
    }

    if (action === "account_login") {
      if (!input.accountId) return { ok: false, message: "缺少 accountId" };
      const account = db.getAccount(input.accountId);
      if (!account) return { ok: false, message: `账号不存在：${input.accountId}` };
      // 打开本机Chrome到登录页，用户扫码后Cookie存进该账号的Profile
      const loginUrl = accountLoginUrl(account.platform);
      const session = await openAiSession(account.profileDir, loginUrl);
      return {
        ok: true,
        action,
        accountId: account.id,
        loginUrl,
        message: `已打开${account.platform === "jd" ? "京东" : "淘宝"}登录页，请在弹出的浏览器里扫码登录。登录完成后调 account_check 确认状态。浏览器会话保持打开。`,
        _sessionOpen: true
      };
    }

    if (action === "account_check") {
      if (!input.accountId) return { ok: false, message: "缺少 accountId" };
      const account = db.getAccount(input.accountId);
      if (!account) return { ok: false, message: `账号不存在：${input.accountId}` };
      const probe = await probeAccountLoginStatus(account);
      setAccountStatus(db, account.id, probe.status, probe.event);
      return {
        ok: true,
        action,
        accountId: account.id,
        status: probe.status,
        event: probe.event,
        message: probe.status === "available" ? "账号已登录可用" : `账号状态：${probe.status}（${probe.event}）`
      };
    }

    if (action === "account_remove") {
      if (!input.accountId) return { ok: false, message: "缺少 accountId" };
      const removed = removeAccount(db, input.accountId);
      return {
        ok: true,
        action,
        removed: { id: removed.id, displayName: removed.displayName },
        message: `账号已删除：${removed.displayName}`
      };
    }

    // ===== 关闭（不真关浏览器，避免反复开闭触发风控）=====
    if (action === "close") {
      return { ok: true, action, message: "浏览器保持打开（不关闭以避免风控）" };
    }

    // ===== 生成AI审核任务包：代码只给证据，不替Agent裁决同款/SKU/利润 =====
    if (action === "ai_review_task") {
      const st = loadStrategyDefaults(db, input.strategyId);
      let jd = input.jdProduct || null;
      if (!jd && input.jdProductId) {
        const row = db.getSourcingResult(input.jdProductId);
        if (!row) return { ok: false, action, message: `本地库没有这个京东候选：${input.jdProductId}` };
        jd = dbRowToJdProduct(row);
      }
      if (!jd?.productId && !jd?.jdProductId) return { ok: false, action, message: "缺少 jdProduct 或 jdProductId" };
      const task = buildAiReviewTask({
        jdProduct: jd,
        taobaoCandidates: input.taobaoCandidates || [],
        keyword: input.keyword || "",
        strategy: st.strategy
      });
      safeAddLog(db, "info", `ai_review_task 已生成：jd=${task.jdProduct.productId}，淘宝候选 ${task.taobaoCandidates.length} 条，等待Agent审核`);
      return {
        ok: true,
        action,
        task,
        message: `已生成AI审核任务包：京东1个，淘宝候选${task.taobaoCandidates.length}个。下一步由Agent/多模态模型换算SKU和利润，再调用save_sourcing。`
      };
    }

    // ===== Agent匹配后存库（京东品+淘宝匹配列表→入库）=====
    if (action === "save_sourcing") {
      const jd = input.jdProduct;
      const matches = input.taobaoMatches || [];
      if (!jd || !jd.productId) return { ok: false, action, message: "缺少 jdProduct.productId" };
      const st = loadStrategyDefaults(db, input.strategyId);
      const jdEvaluation = evaluateJdProductByStrategy(jd, st.strategy);
      if (!jdEvaluation.passed) {
        safeAddLog(db, "warn", `save_sourcing 拦截京东品：${jd.productId} ${jdEvaluation.reason}`);
        return { ok: false, action, code: "STRATEGY_REJECTED", message: jdEvaluation.reason };
      }
      const rejectedMatches = [];
      const allowedMatches = matches.filter((match) => {
        const taobao = match?.taobao || match;
        const evaluated = evaluateTaobaoProductByStrategy(taobao, st.strategy);
        if (evaluated.passed) return true;
        rejectedMatches.push({ productId: taobao?.productId || "", reason: evaluated.reason });
        return false;
      });
      db.saveSourcing(jd, allowedMatches, null, { id: st.id });
      safeAddLog(db, "info", `save_sourcing 已入库：${jd.productId}，淘宝匹配 ${allowedMatches.length} 条，策略淘汰 ${rejectedMatches.length} 条`);
      return {
        ok: true,
        action,
        saved: allowedMatches.length,
        rejectedMatches,
        message: `已存库: 1个京东品 + ${allowedMatches.length}个淘宝匹配`
      };
    }

    if (action === "sourcing_list") {
      const limit = clampLimit(input.limit, 50);
      const st = loadStrategyDefaults(db, input.strategyId);
      const items = db.listSourcingResults(limit);
      const dedupedQualifiedItems = db.listDedupedQualifiedResults(st.profit);
      return {
        ok: true,
        action,
        count: items.length,
        dedupedQualifiedCount: dedupedQualifiedItems.length,
        items,
        message: `已返回最近 ${items.length} 条入库选品结果；最终去重达标 ${dedupedQualifiedItems.length} 个`
      };
    }

    if (action === "logs") {
      const limit = clampLimit(input.limit, 50);
      const logs = db.listLogs(limit);
      return {
        ok: true,
        action,
        count: logs.length,
        logs,
        message: `已返回最近 ${logs.length} 条日志`
      };
    }

    // ===== 导出选品结果为CSV表格（存本地，可下载）=====
    if (action === "export_results") {
      const outPath = input.outputPath || pathJoin(ctx?.dataDir || ".", "exports", `选品结果_${Date.now()}.csv`);
      mkdirSync(dirname(outPath), { recursive: true });
      const ret = db.exportSourcing(outPath);
      const count = typeof ret === "number" ? ret : (ret?.count ?? ret?.rows ?? 0);
      safeAddLog(db, "info", `export_results 已导出 ${count} 条到 ${outPath}`);
      return {
        ok: true,
        action,
        outputPath: outPath,
        count,
        message: `已导出 ${count} 条选品结果到：${outPath}（CSV可用Excel打开）`
      };
    }

    // ===== 导出到飞书多维表格（图片嵌单元格，扫码绑定后即可用）=====
    if (action === "export_feishu") {
      const result = await exportToFeishu(db, ctx?.dataDir || ".");
      if (result.needBind) {
        return { ok: false, action, needBind: true, message: result.message + "，请先调 bind_feishu" };
      }
      if (!result.ok) {
        return { ok: false, action, message: result.message };
      }
      safeAddLog(db, "info", `export_feishu 已导出 ${result.count} 条到 ${result.url}`);
      return {
        ok: true,
        action,
        count: result.count,
        url: result.url,
        message: result.message || `已导出到飞书多维表格`
      };
    }

    // ===== 绑定飞书（扫码即可，飞书自动创建应用）=====
    if (action === "bind_feishu") {
      const result = await bindFeishu(ctx?.dataDir || ".");
      return { ok: result.ok, action, message: result.message };
    }


    // ===== 飞书双向通道（WebSocket长连接）=====
    if (action === "start_feishu_channel") {
      const result = await startFeishuChannel(ctx?.dataDir || ".");
      return { ok: result.ok, action, message: result.message };
    }

    if (action === "check_feishu_msgs") {
      const result = readFeishuMsgs();
      return { ok: true, action, count: result.count, messages: result.messages, message: result.count > 0 ? `有 ${result.count} 条新消息` : "无新消息" };
    }
    // ===== 通过飞书通知用户（Agent主动发消息）=====
    if (action === "notify_user") {
      if (!input.message) return { ok: false, message: "缺少 message（消息内容）" };
      const result = await sendFeishuMsg(ctx?.dataDir || ".", input.message);
      return { ok: result.ok, action, message: result.message };
    }
    // ===== 京东单步操作 =====
    if (action === "jd_search") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const session = await openAiSessionWithAccount(ctx, db, "jd", "about:blank", input.accountId || null);
      const result = await aiJdSearch(session.page, input.keyword, { platform: "jd", account: session.account });
      return {
        ok: true,
        action,
        keyword: input.keyword,
        url: result.url,
        title: result.title,
        message: "京东搜索完成"
      };
    }

    if (action === "jd_extract") {
      const session = await openAiSessionWithAccount(ctx, db, "jd", "about:blank", input.accountId || null);
      const products = await aiExtractJdProducts(session.page, input.maxCount || 10);
      return {
        ok: true,
        action,
        count: products.length,
        products,
        message: `提取 ${products.length} 个京东商品`
      };
    }

    if (action === "jd_detail") {
      const session = await openAiSessionWithAccount(ctx, db, "jd", "about:blank", input.accountId || null);
      const click = await aiClickProduct(session.page, input.productIndex || 0);
      const detail = await aiExtractJdDetail(click.page);
      return {
        ok: true,
        action,
        url: click.url,
        detail,
        message: "京东详情提取完成"
      };
    }

    if (action === "jd_search_filter") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const strategy = input.strategy || DEFAULT_STRATEGIES[input.strategyId] || DEFAULT_STRATEGIES["no-source-arbitrage"];
      const bannedKeyword = keywordBannedByStrategy(input.keyword, strategy);
      if (bannedKeyword) return { ...bannedKeyword, action };
      const session = await openAiSessionWithAccount(ctx, db, "jd", "about:blank", input.accountId || null);
      await aiJdSearch(session.page, input.keyword, { platform: "jd", account: session.account });
      const products = await aiExtractJdProducts(session.page, input.maxCount || 30);
      const evaluated = products.map(p => {
        const result = evaluateJdProductByStrategy(p, strategy);
        return { ...p, passed: result.passed, rejectReason: result.reason };
      });
      const passed = evaluated.filter(p => p.passed);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        strategy: { id: strategy.id, name: strategy.name },
        total: evaluated.length,
        passed: passed.length,
        passedProducts: passed,
        message: `策略筛选: ${passed.length}/${evaluated.length} 通过`
      };
    }

    // ===== 京东选品（用策略引擎默认值）=====
    if (action === "jd_harvest") {
      const brand = input.brand || input.keyword;
      if (!brand) return { ok: false, message: "缺少 brand（品牌词，如 GNC）" };
      const st = loadStrategyDefaults(db, input.strategyId);
      const bannedKeyword = keywordBannedByStrategy(brand, st.strategy);
      if (bannedKeyword) {
        safeAddLog(db, "warn", `jd_harvest 拦截禁售品牌：${brand} => ${bannedKeyword.bannedBrand}`);
        return { ...bannedKeyword, action, brand };
      }
      safeAddLog(db, "info", `jd_harvest 开始：brand=${brand} target=${input.targetCount || 10}`);

      const session = await openSessionChecked(ctx, db, "jd", input.accountId || null);
      let result;
      const savedIds = new Set();
      const saveErrors = [];
      let savedCount = 0;
      try {
        result = await aiJdHarvest(session.page, brand, {
          account: session.account,
          targetCount: input.targetCount || 10,
          maxPagesPerShop: input.maxPagesPerShop || 3,
          maxShopsPerBrand: input.maxShopsPerBrand || 12,
          maxDetailPerShop: input.maxDetailPerShop || 12,
          maxConsecutiveCommentRejectsPerShop: input.maxConsecutiveCommentRejectsPerShop || 8,
          minComments: input.minComments ?? st.jd.minComments,
          priceRange: st.jd.priceRange,
          searchSuffix: st.jd.searchSuffix,
          collectShopNames: st.jd.collectShopNames,
          allowedBrands: normalizeAllowedBrands(input.allowedBrands, st.strategy),
          screenshotDir: pathJoin(ctx?.dataDir || ".", "shots", "jd"),
          onCandidate: async (candidate) => {
            if (!candidate?.productId || savedIds.has(candidate.productId)) return;
            const enriched = enrichJdCandidateForStorage(candidate);
            const evaluated = evaluateJdProductByStrategy(enriched, st.strategy);
            if (!evaluated.passed) {
              safeAddLog(db, "warn", `jd_harvest 候选未入库：${enriched.productId} ${evaluated.reason}`);
              return;
            }
            try {
              saveJdCandidate(db, enriched, st);
              savedIds.add(enriched.productId);
              savedCount += 1;
              safeAddLog(db, "info", `jd_harvest 即时入库：${enriched.productId} ${String(enriched.title || "").slice(0, 30)}`);
            } catch (e) {
              saveErrors.push({ productId: enriched.productId, message: e instanceof Error ? e.message : String(e) });
            }
          }
        });
      } finally { /* 浏览器不关 */ }

      // 自动存库：京东候选先入库，再把品牌/核心品名清洗交还给调用方 Agent。
      const strategyRejected = [];
      const candidates = [];
      for (const c of result.candidates.map(enrichJdCandidateForStorage)) {
        const evaluated = evaluateJdProductByStrategy(c, st.strategy);
        if (!evaluated.passed) {
          strategyRejected.push({ ...c, reason: evaluated.reason });
          continue;
        }
        candidates.push(c);
        if (savedIds.has(c.productId)) continue;
        try {
          saveJdCandidate(db, c, st);
          savedIds.add(c.productId);
          savedCount += 1;
        } catch (e) {
          saveErrors.push({ productId: c.productId, message: e instanceof Error ? e.message : String(e) });
        }
      }
      const rejected = [...(result.rejected || []), ...strategyRejected];
      safeAddLog(db, saveErrors.length ? "warn" : "info", `jd_harvest 完成：合格候选 ${candidates.length}，淘汰 ${rejected.length}，入库 ${savedCount}，失败 ${saveErrors.length}`);
      const jdStatsSummary = summarizeJdHarvestStats(result.stats);
      if (jdStatsSummary) safeAddLog(db, "info", `jd_harvest 店铺筛选摘要：${jdStatsSummary}`);
      const jdRejectSummary = summarizeRejectReasons(rejected);
      if (jdRejectSummary) safeAddLog(db, "info", `jd_harvest 淘汰原因汇总：${jdRejectSummary}`);
      const suggestedTaobaoTasks = candidates.map((candidate) => {
        const brandName = resolveBrandForTaobao(candidate);
        return {
          jdProductId: candidate.productId,
          jdTitle: candidate.title,
          brandCandidate: brandName,
          searchKeywordCandidates: buildTaobaoSearchKeywords({ brand: brandName, title: candidate.title }),
          instruction: "请调用方 Agent 先从 jdTitle 提取品牌名和核心品名，去掉规格/装量/营销词，再用品牌+核心品名调用 taobao_harvest。"
        };
      });

      return {
        ok: true,
        action,
        brand,
        stats: result.stats,
        candidateCount: candidates.length,
        candidates,
        rejectedCount: rejected.length,
        rejected,
        database: {
          savedCount,
          saveErrors
        },
        agentNextActions: [
          "读取 candidates 或 suggestedTaobaoTasks。",
          "对每个京东候选提取品牌名 + 核心品名，去掉规格、瓶数、营销词。",
          "逐个调用 ecommerce_sourcing({ action:'taobao_harvest', keyword:'品牌 核心品名' })。",
          "调用 ecommerce_sourcing({ action:'ai_review_task', jdProduct, taobaoCandidates }) 生成审核包。",
          "由Agent/多模态模型亲自做同款复核、SKU单位价换算、利润筛选，再调用 save_sourcing 入库。"
        ],
        suggestedTaobaoTasks,
        agentInstructions: buildJdCleaningInstructions(candidates.length, st),
        message: `京东选品完成：${candidates.length}个评价>=${st.jd.minComments}的候选品，已入库 ${savedCount} 个。下一步请 Agent 提取品牌+核心品名后逐个淘宝比价。`
      };
    }


    // ===== 淘宝选品（用策略引擎默认值）=====
    if (action === "taobao_harvest") {
      if (!input.keyword) return { ok: false, message: "缺少 keyword(用京东品的品牌+品名)" };
      const st = loadStrategyDefaults(db, input.strategyId);
      const bannedKeyword = keywordBannedByStrategy(input.keyword, st.strategy);
      if (bannedKeyword) {
        safeAddLog(db, "warn", `taobao_harvest 拦截禁售品牌：${input.keyword} => ${bannedKeyword.bannedBrand}`);
        return { ...bannedKeyword, action, keyword: input.keyword };
      }
      safeAddLog(db, "info", `taobao_harvest 开始：keyword=${input.keyword}`);
      const session = await openSessionChecked(ctx, db, "taobao", input.accountId || null);
      let result;
      try {
        result = await aiTaobaoHarvest(session.page, input.keyword, {
          maxList: input.maxCount || 40,
          maxDetail: input.maxDetail || 10,
          minSales: input.minSales ?? st.taobao.minSales,
          requireDomestic: input.requireDomestic ?? (st.taobao.shipFrom === "domestic"),
          require48h: input.require48h ?? (st.taobao.shipWithinHours === 48),
          priceRange: st.taobao.priceRange,
          screenshotDir: pathJoin(ctx?.dataDir || ".", "shots", "taobao")
        });
      } finally { /* 浏览器不关 */ }
      const taobaoStrategyRejected = [];
      const candidates = result.candidates.map((candidate) => {
        const unitPriceResult = calculateUnitPrice(candidate.price, candidate.title, candidate.skuInfo || "");
        return {
          ...candidate,
          unitPrice: candidate.unitPrice ?? unitPriceResult.unitPrice,
          unit: candidate.unit || unitPriceResult.unit || "",
          spec: candidate.spec || unitPriceResult.spec || null,
          unitPriceFormula: unitPriceResult.formula || ""
        };
      }).filter((candidate) => {
        const evaluated = evaluateTaobaoProductByStrategy(candidate, st.strategy);
        if (evaluated.passed) return true;
        taobaoStrategyRejected.push({ ...candidate, reason: evaluated.reason });
        return false;
      });
      const rejected = [...(result.rejected || []), ...taobaoStrategyRejected];
      safeAddLog(db, "info", `taobao_harvest 完成：keyword=${input.keyword}，候选 ${candidates.length}，淘汰 ${rejected.length}`);
      const taobaoStatsSummary = summarizeTaobaoHarvestStats(result.stats);
      if (taobaoStatsSummary) safeAddLog(db, "info", `taobao_harvest 列表筛选摘要：${taobaoStatsSummary}`);
      const taobaoRejectSummary = summarizeRejectReasons(rejected);
      if (taobaoRejectSummary) safeAddLog(db, "info", `taobao_harvest 淘汰原因汇总：${taobaoRejectSummary}`);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        stats: result.stats,
        candidateCount: candidates.length,
        candidates,
        rejectedCount: rejected.length,
        rejected,
        agentNextActions: [
          "把本次 taobao_harvest 的 candidates 与对应京东候选做同款复核。",
          "优先使用 title + skuInfo + screenshotPath 交叉判断，不要只按标题相似。",
          "建议先调用 ai_review_task 生成标准审核包。",
          "由Agent/多模态模型按最小规格单位价计算利润，达标后调用 save_sourcing 写入京东品和淘宝匹配。",
          "如没有同款，回到京东候选列表换下一个品。"
        ],
        agentInstructions: buildTaobaoCleaningInstructions(result.candidates.length, st),
        message: `淘宝选品完成：${result.candidates.length}个符合(国内+48h+已售达标)的货源，请按 agentInstructions 比价`
      };
    }

    if (action === "taobao_search") {
      if (!input.keyword) return { ok: false, message: "缺少关键词" };
      const session = await openAiSessionWithAccount(ctx, db, "taobao", "about:blank", input.accountId || null);
      const result = await aiTaobaoSearch(session.page, input.keyword);
      return {
        ok: true,
        action,
        keyword: input.keyword,
        url: result.url,
        message: "淘宝搜索完成"
      };
    }

    if (action === "taobao_search_image") {
      if (!input.imageUrl) return { ok: false, message: "缺少图片URL" };
      const session = await openAiSessionWithAccount(ctx, db, "taobao", "about:blank", input.accountId || null);
      const result = await aiTaobaoSearchByImage(session.page, input.imageUrl);
      return {
        ok: true,
        action,
        imageUrl: input.imageUrl,
        url: result.url,
        message: "淘宝以图搜图完成"
      };
    }

    if (action === "taobao_extract") {
      const session = await openAiSessionWithAccount(ctx, db, "taobao", "about:blank", input.accountId || null);
      const products = await aiExtractTaobaoProducts(session.page, input.maxCount || 10);
      return {
        ok: true,
        action,
        count: products.length,
        products,
        message: `提取 ${products.length} 个淘宝商品`
      };
    }
    return { ok: false, message: `未知操作: ${action}` };

  } catch (error) {
    safeAddLog(db, "error", `${action || "unknown"} 失败：${error.message || String(error)}`);
    if (error.code === "RISK_CONTROL") {
      const event = `风控暂停：${error.message || "检测到风控"}${error.signal ? `（${error.signal}）` : ""}`;
      if (error.accountId) {
        try {
          setAccountStatus(db, error.accountId, "paused", event);
          safeAddLog(db, "warn", `账号已暂停：${error.accountName || error.accountId} ${event}`);
        } catch (e) {
          safeAddLog(db, "error", `账号暂停失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return {
        ok: false,
        action,
        risk: true,
        accountId: error.accountId,
        accountName: error.accountName,
        screenshotPath: error.screenshotPath,
        message: event
      };
    }
    if (error.code === "NOT_LOGGED_IN") {
      return {
        ok: false,
        action,
        needLogin: true,
        accountId: error.accountId,
        message: error.message
      };
    }
    return {
      ok: false,
      action,
      error: error.message,
      message: `操作失败: ${error.message}`
    };
  }
}

function safeAddLog(db, level, message) {
  try {
    db.addLog(null, level, message);
  } catch {
    // 日志失败不能影响主流程。
  }
}

function clampLimit(value, fallback) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function summarizeJdHarvestStats(stats) {
  const shopStats = Array.isArray(stats?.shopStats) ? stats.shopStats : [];
  if (!shopStats.length) return "";
  const shopStops = Array.isArray(stats?.shopStops) ? stats.shopStops : [];
  const total = shopStats.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const matched = shopStats.reduce((sum, item) => sum + Number(item.matched || 0), 0);
  const skipped = sumSkipped(shopStats);
  const byShop = new Map();
  for (const item of shopStats) {
    const key = item.shopName || "未知店铺";
    const current = byShop.get(key) || { pages: 0, total: 0, matched: 0, skipped: {} };
    current.pages += 1;
    current.total += Number(item.total || 0);
    current.matched += Number(item.matched || 0);
    current.skipped = addSkipped(current.skipped, item.skipped || {});
    byShop.set(key, current);
  }
  const shopBrief = [...byShop.entries()]
    .slice(0, 5)
    .map(([shop, item]) => `${shop}: ${item.pages}页/${item.total}原始/${item.matched}命中/跳过${formatSkipObject(item.skipped)}`)
    .join("；");
  const stopBrief = shopStops.length
    ? `；提前跳过 ${shopStops.slice(0, 5).map((item) => `${item.shopName}: ${item.reason}`).join("；")}`
    : "";
  return `收集店铺${stats?.shopsCollected ?? "-"}个，尝试${stats?.shopsTried ?? byShop.size}个；列表原始${total}个，命中${matched}个，跳过${formatSkipObject(skipped)}；明细 ${shopBrief}${stopBrief}`;
}

function summarizeTaobaoHarvestStats(stats) {
  const pageStats = Array.isArray(stats?.pageStats) ? stats.pageStats : [];
  if (!pageStats.length) return "";
  const total = pageStats.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const matched = pageStats.reduce((sum, item) => sum + Number(item.matched || 0), 0);
  const skipped = sumSkipped(pageStats);
  const pageBrief = pageStats
    .slice(0, 5)
    .map((item) => `第${item.page}页 ${item.total}原始/${item.matched}命中/跳过${formatSkipObject(item.skipped || {})}`)
    .join("；");
  return `翻看${pageStats.length}页，列表原始${total}个，基础规则命中${matched}个，跳过${formatSkipObject(skipped)}；明细 ${pageBrief}`;
}

function summarizeRejectReasons(items) {
  if (!Array.isArray(items) || !items.length) return "";
  const counts = new Map();
  for (const item of items) {
    const reason = normalizeReason(item?.reason || item?.rejectReason || item?.selectedSkuRejectReason || item?.message || "未知原因");
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => `${reason}×${count}`)
    .join("；");
}

function sumSkipped(items) {
  return items.reduce((acc, item) => addSkipped(acc, item.skipped || {}), {});
}

function addSkipped(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    merged[key] = (merged[key] || 0) + Number(value || 0);
  }
  return merged;
}

function formatSkipObject(skipped) {
  const entries = Object.entries(skipped || {}).filter(([, value]) => Number(value || 0) > 0);
  if (!entries.length) return "0";
  return entries
    .map(([key, value]) => `${translateSkipKey(key)}${value}`)
    .join("、");
}

function translateSkipKey(key) {
  const names = {
    noProductId: "缺ID",
    duplicate: "重复",
    shopMismatch: "非本店",
    brandMismatch: "非可用品牌",
    nonDomestic: "非国内",
    slowShipping: "非48小时",
    lowSales: "销量不足",
    overseasPlatform: "海外平台",
    priceOutOfRange: "价格不符"
  };
  return names[key] || key;
}

function normalizeReason(reason) {
  const text = String(reason || "未知原因").replace(/\s+/g, " ").trim();
  if (!text) return "未知原因";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

/**
 * 生成给调用方Agent的清洗指令。
 * 设计原则：脚本只负责拉脏数据，去重和算最小规格单价这种需要"理解力"的活，
 * 交给调用本MCP的Agent(大模型)做。指令必须整洁、清晰、可执行。
 */
function buildJdCleaningInstructions(candidateCount, strategy) {
  const p = strategy?.profit || {};
  const rateRange = `${((p.minRate ?? 0.35) * 100).toFixed(0)}%-${((p.maxRate ?? 0.60) * 100).toFixed(0)}%`;
  return {
    summary: `已拉取 ${candidateCount} 个京东买手店候选品(评价均已达到策略门槛)。请你对 candidates 数组做以下清洗，得到干净的京东品清单。`,
    steps: [
      {
        step: 1,
        name: "算最小规格单价",
        detail: `从每个品的 title 和 skuInfo 解析规格，换算成最小规格单价。规则：粒/片→每粒；g/kg→每克(kg×1000)；ml/L→每毫升(L×1000)。例：60粒¥120→¥2/粒。`,
        output: "给每个品补 unitPrice(数字) 和 unit(粒/g/ml等) 两个字段"
      },
      {
        step: 2,
        name: "识别同款并去重",
        detail: "同一款产品可能有多个链接(不同店铺、不同SKU装量)。依据 title 的品牌+品名+核心规格判断是否同款(忽略装量差异，如『1瓶』vs『3瓶』算同款)。同款只保留『最小规格单价最低』的那一个。",
        output: "去重后的京东品清单，每个同款只剩1条(最小规格单价最低的)"
      },
      {
        step: 3,
        name: "输出",
        detail: "输出清洗后的清单，每条含：title, price, unitPrice, unit, comments, shop, url。这是后续去淘宝比价的京东基准品。",
        output: "干净的京东基准品清单"
      }
    ],
    note: `后续比价时，利润率需在 ${rateRange} 区间内，最低利润金额 ¥${p.minAmount ?? 20}。`
  };
}

/**
 * 生成给调用方Agent的淘宝比价指令。
 * 核心：①淘宝同一链接不同SKU价格差距大，必须按SKU比；
 *       ②一个京东品可匹配多个淘宝链接，符合的都保留；
 *       ③用最小规格单价做统一比价标尺。
 */
function buildTaobaoCleaningInstructions(candidateCount, strategy) {
  const p = strategy?.profit || {};
  const rateRange = `${((p.minRate ?? 0.35) * 100).toFixed(0)}%-${((p.maxRate ?? 0.60) * 100).toFixed(0)}%`;
  return {
    summary: `已拉取 ${candidateCount} 个淘宝货源(均已通过 国内发货+48h内发+已售达标 三道筛)。利润区间 ${rateRange}，最低 ¥${p.minAmount ?? 20}。请你完成与京东品的比价。`,
    steps: [
      {
        step: 1,
        name: "按SKU算最小规格单价（关键）",
        detail: "淘宝同一链接里不同SKU(如60粒/200粒、1瓶/5瓶)价格差距很大，不能只用一个价。优先使用 selectedSkuOptions 和 skuInfo 中的当前选中SKU；如果 selectedSkuRejectReason 不为空，说明当前选中SKU明显不是搜索目标，不要入库。请从每个货源的 title 和 skuInfo 找出规格与价格，换算成最小规格单价(每粒/每g/每ml)。规格换算：粒/片按个；g/kg→克(kg×1000)；ml/L→毫升(L×1000)。",
        output: "每个货源标注：各SKU的『规格→价格→最小规格单价』，并取其中最低的最小规格单价作为该货源的比价基准"
      },
      {
        step: 2,
        name: "与京东品匹配（一对多）",
        detail: "把这些淘宝货源与对应的京东品按『同款』匹配(品牌+品名+核心规格)。一个京东品可以匹配多个淘宝链接，只要符合规则都保留——这是正常的，给后续挑选留空间。",
        output: "每个京东品下挂一个或多个匹配的淘宝货源"
      },
      {
        step: 3,
        name: "算利润、按策略卡阈值",
        detail: `利润率=(京东单价-淘宝单价)/京东单价。保留 ${rateRange} 区间内且利润≥¥${p.minAmount ?? 20} 的。`,
        output: "最终可用品清单：京东品 + 匹配的淘宝货源(可多个) + 各自最小规格单价 + 利润率"
      }
    ],
    note: "最小规格单价是京东↔淘宝唯一可比的标尺。务必按SKU拆价，否则同链接不同装量会让比价完全失真。"
  };
}
