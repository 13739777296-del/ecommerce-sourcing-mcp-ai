import { readFileSync } from "node:fs";
import { openSourcingDb } from "../lib/db.js";
import { runAiBrowserAction } from "../lib/ai-browser.js";

export const name = "ai-browser";
export const description = "AI 浏览器工具：让电商选品 Agent 使用正式 Chrome 账号会话打开、观察、搜索、点击、输入、按键、截图和关闭页面。除 close 外，每步都会返回截图图像和页面结构，要求多模态模型识图后再交叉验证。";
export const promptGuidelines = [
  "需要探索京东/淘宝页面、确认页面结构、根据截图和元素列表决定下一步时调用此工具。",
  "每一步都必须先看截图，再结合 observation.textSample、elements 和 URL 交叉验证。",
  "商品标题、SKU、最小规格单价、已售数量、发货时效等关键字段必须由多模态截图识别参与确认。",
  "不要用它绕过验证码、安全验证、访问频繁或平台风控；遇到这些情况要暂停并提醒用户人工处理。",
  "截图用于给模型复盘和判断，不要把完整页面当作商品主图；需要主图时优先调用选品任务里保存的局部裁剪素材。"
];

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: "动作：open、observe、search、click、type、press、screenshot、close。"
    },
    platform: {
      type: "string",
      description: "平台：jd 或 taobao。默认 jd。"
    },
    accountId: {
      type: "string",
      description: "可选账号 ID。不填时使用该平台第一个可用账号。"
    },
    url: {
      type: "string",
      description: "open 动作可传 URL。"
    },
    keyword: {
      type: "string",
      description: "search 动作使用的搜索词。"
    },
    selector: {
      type: "string",
      description: "click/type 动作使用的页面选择器。"
    },
    text: {
      type: "string",
      description: "click 动作用于按可见文字点击；type 动作用于输入内容。"
    },
    key: {
      type: "string",
      description: "press 动作的按键，例如 Enter、Escape、ArrowDown。"
    },
    label: {
      type: "string",
      description: "screenshot 动作的截图标签。"
    }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const result = await runAiBrowserAction(ctx, db, input || {});
    const observation = result.observation;
    const lines = [
      `AI 浏览器动作：${result.action}`,
      `结果：${result.ok ? "完成" : "失败/暂停"}`,
      `平台：${result.platform || "未知"}`,
      `账号：${result.accountId || "未知"}`,
      result.message ? `说明：${result.message}` : "",
      result.screenshotPath ? `截图：${result.screenshotPath}` : "",
      result.vision?.required ? `视觉复核：${result.vision.status === "ready" ? "已返回截图，请先识图再结合页面结构交叉验证" : result.vision.instruction}` : "",
      observation ? `页面：${observation.title || "无标题"}` : "",
      observation ? `地址：${observation.url}` : "",
      observation?.elements?.length ? `可交互元素：${observation.elements.slice(0, 12).map((item, index) => `${index + 1}. ${item.tag} ${item.text || item.selector}`).join(" / ")}` : ""
    ].filter(Boolean);
    const content = [{ type: "text", text: lines.join("\n") }];
    const image = imageContent(result.screenshotPath);
    if (image) content.push(image);
    return {
      content,
      details: result
    };
  } finally {
    db.close();
  }
}

function imageContent(filePath) {
  if (!filePath) return null;
  try {
    return {
      type: "image",
      data: readFileSync(filePath).toString("base64"),
      mimeType: "image/png"
    };
  } catch {
    return null;
  }
}
