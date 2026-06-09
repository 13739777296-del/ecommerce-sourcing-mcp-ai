import { openSourcingDb } from "../lib/db.js";
import { startJdSearch, clickJdDetail, startTaobaoSearch, clickTaobaoDetail, goBack, scrollPage, takeSnapshot, saveMatch, endSession } from "../lib/agent-collect.js";

export const name = "agent-collect";
export const description = "AI Agent 驱动的选品采集工具（默认推荐）。每一步由 AI 看截图+DOM 数据决定下一步操作。模拟真人慢速操作浏览器，防止风控。适用于保健品等品类的京东→淘宝选品。这是首选工具，run-selection 仅作为备选。";
export const promptGuidelines = [
  "这是默认推荐的选品工具，每一步都要调用一次，AI 看截图后决定下一步。",
  "慢速操作：每次调用后等待返回，看截图和数据后再决定。",
  "京东筛选：买手店 + 评论 >= 2。",
  "淘宝筛选：国内发货 + 48 小时内发货 + 已售 >= 10。",
  "关键数据（价格、评论数、销量）用 DOM + 截图交叉验证。",
  "遇到验证码、风控、登录失效立即暂停。",
  "用完浏览器后必须调用 end_session 彻底关闭。",
  "输入关键词后必须点击搜索按钮，不能只输入不搜索。"
];
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "start_jd_search",
        "jd_click_detail",
        "start_taobao_search",
        "taobao_click_detail",
        "go_back",
        "scroll",
        "snapshot",
        "save_match",
        "end_session"
      ],
      description: "要执行的浏览器操作。详见每个 action 的说明。"
    },
    accountId: { type: "string", description: "可选，指定账号 ID。不填用平台第一个可用账号。" },
    keyword: { type: "string", description: "搜索关键词。start_jd_search 和 start_taobao_search 必填。" },
    productId: { type: "string", description: "商品 ID/SKU。jd_click_detail 和 taobao_click_detail 用。" },
    url: { type: "string", description: "商品详情页 URL。jd_click_detail 和 taobao_click_detail 可选（默认用 productId 构建）。" },
    platform: { type: "string", enum: ["jd", "taobao"], description: "go_back、scroll、snapshot 用，指定操作哪个平台。" },
    delta: { type: "number", description: "scroll 时的滚动距离像素，默认随机 200-600。" },
    runId: { type: "string", description: "任务 ID。save_match 必填，其他可选（用于记录日志）。" },
    jdProductId: { type: "string", description: "save_match 必填：京东商品 ID。" },
    taobaoProductId: { type: "string", description: "save_match 必填：淘宝商品 ID。" },
    jdPrice: { type: "number", description: "save_match：京东价格。" },
    taobaoPrice: { type: "number", description: "save_match：淘宝供货价格。" },
    profitAmount: { type: "number", description: "save_match：利润金额。" },
    profitRate: { type: "number", description: "save_match：利润率。" },
    jdProduct: { type: "object", description: "save_match：京东商品完整数据对象（可选）。" },
    taobaoProduct: { type: "object", description: "save_match：淘宝商品完整数据对象（可选）。" },
    reason: { type: "string", description: "save_match：匹配原因（可选）。" }
  },
  required: ["action"]
};

export async function execute(input = {}, ctx) {
  const db = openSourcingDb(ctx);
  try {
    let result;
    switch (input.action) {
      case "start_jd_search":
        result = await startJdSearch(ctx, db, input);
        break;
      case "jd_click_detail":
        result = await clickJdDetail(ctx, db, input);
        break;
      case "start_taobao_search":
        result = await startTaobaoSearch(ctx, db, input);
        break;
      case "taobao_click_detail":
        result = await clickTaobaoDetail(ctx, db, input);
        break;
      case "go_back":
        result = await goBack(ctx, db, input);
        break;
      case "scroll":
        result = await scrollPage(ctx, db, input);
        break;
      case "snapshot":
        result = await takeSnapshot(ctx, db, input);
        break;
      case "save_match":
        result = await saveMatch(ctx, db, input);
        break;
      case "end_session":
        result = await endSession(ctx, db, input);
        break;
      default:
        throw new Error(`未知 action：${input.action}`);
    }
    // 附加最新进度日志
    const progressLogs = input.runId ? db.listLogs(5, input.runId) : [];
    result.progressLogs = progressLogs.map((l) => `[${l.level}] ${l.message}`);
    return formatResult(result);
  } finally {
    db.close();
  }
}

function formatResult(res) {
  const lines = [];
  if (res.ok) {
    lines.push(`状态：${res.step || res.status || "ok"}`);
    if (res.instruction) lines.push(`\n下一步指引：${res.instruction}`);
    if (res.keyword) lines.push(`关键词：${res.keyword}`);
    if (res.pageTitle) lines.push(`页面标题：${res.pageTitle}`);
    if (res.pageUrl) lines.push(`页面地址：${res.pageUrl}`);
    if (res.productCount !== undefined) lines.push(`商品数量：${res.productCount}`);
    if (res.products?.length > 0) {
      lines.push(`\n提取到的商品（${res.products.length} 个）：`);
      for (const p of res.products.slice(0, 15)) {
        const parts = [`[${p.productId}]`, p.url];
        if (p.price) parts.push(`¥${p.price}`);
        if (p.salesCount) parts.push(`已售${p.salesCount}`);
        if (p.commentCount) parts.push(`${p.commentCount}条评价`);
        if (p.isBuyerStore !== undefined) parts.push(p.isBuyerStore ? "买手店" : "非买手店");
        lines.push(`  ${parts.join(" | ")}`);
      }
    }
    if (res.detail) {
      const d = res.detail;
      lines.push(`\n商品详情：`);
      if (d.title) lines.push(`  标题：${d.title}`);
      if (d.price) lines.push(`  价格：¥${d.price}`);
      if (d.commentCount !== undefined) lines.push(`  评论数：${d.commentCount}`);
      if (d.salesCount !== undefined) lines.push(`  销量：${d.salesCount}`);
      if (d.shopName) lines.push(`  店铺：${d.shopName}`);
      if (d.isBuyerStore !== undefined) lines.push(`  买手店：${d.isBuyerStore ? "是" : "否"}`);
      if (d.domesticShipping !== undefined) lines.push(`  国内发货：${d.domesticShipping ? "是" : "否"}`);
      if (d.shippingHours !== undefined) lines.push(`  发货时效：${d.shippingHours}小时`);
      if (d.url) lines.push(`  链接：${d.url}`);
    }
    if (res.match) {
      const m = res.match;
      lines.push(`\n匹配结果：利润 ¥${m.profitAmount?.toFixed(2)} (${(m.profitRate * 100).toFixed(1)}%)`);
    }
    if (res.message) lines.push(`\n${res.message}`);
  } else {
    lines.push(`状态：${res.status || "error"}`);
    lines.push(`说明：${res.message}`);
    if (res.status === "platform_risk") lines.push("请人工处理风控后重试。");
    if (res.status === "login_required") lines.push("请登录账号后重试。");
  }

  // 显示最近进度日志
  if (res.progressLogs?.length > 0) {
    lines.push(`\n最近进度：`);
    for (const log of res.progressLogs) {
      lines.push(`  ${log}`);
    }
  }

  const content = [{ type: "text", text: lines.join("\n") }];
  if (res.image) content.push(res.image);

  return { content, details: res };
}
