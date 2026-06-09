import { buildAgentGuide } from "../lib/agent-guide.js";

export const name = "usage-guide";
export const description = "返回电商选品 MCP 的 Agent 使用手册，说明账号池、AI 浏览器、选品、导出和安全边界，供接入的 Agent 像读取 skill 一样理解怎么使用。";
export const parameters = {
  type: "object",
  properties: {}
};

export async function execute() {
  return {
    content: [{ type: "text", text: buildAgentGuide() }],
    details: {
      guideName: "ecommerce_sourcing_agent_guide",
      recommendedFirstTool: "ecommerce_sourcing_status"
    }
  };
}
