import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GUIDE_NAME, buildAgentGuide } from "../lib/agent-guide.js";

export const SERVER_NAME = "ecommerce-sourcing-mcp";
export const SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSION = "2025-06-18";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(__dirname);

const toolSpecs = [
  {
    mcpName: "ecommerce_sourcing_bootstrap",
    modulePath: "../tools/bootstrap.js"
  },
  {
    mcpName: "ecommerce_sourcing_usage_guide",
    modulePath: "../tools/usage-guide.js"
  },
  {
    mcpName: "ecommerce_sourcing_accounts",
    modulePath: "../tools/accounts.js"
  },
  {
    mcpName: "ecommerce_sourcing_ai_select",
    modulePath: "../tools/ai-select.js"
  },
  {
    mcpName: "ecommerce_sourcing_strategy",
    modulePath: "../tools/strategy.js"
  },
  {
    mcpName: "ecommerce_sourcing_agent_collect",
    modulePath: "../tools/agent-collect.js"
  },
  {
    mcpName: "ecommerce_sourcing_ai_browser",
    modulePath: "../tools/ai-browser.js"
  },
  {
    mcpName: "ecommerce_sourcing_run_selection",
    modulePath: "../tools/run-selection.js"
  },
  {
    mcpName: "ecommerce_sourcing_status",
    modulePath: "../tools/status.js"
  },
  {
    mcpName: "ecommerce_sourcing_selection_report",
    modulePath: "../tools/selection-report.js"
  },
  {
    mcpName: "ecommerce_sourcing_export_results",
    modulePath: "../tools/export-results.js"
  },
  {
    mcpName: "ecommerce_sourcing_check_accounts",
    modulePath: "../tools/check-accounts.js"
  },
  {
    mcpName: "ecommerce_sourcing_strategy_library",
    modulePath: "../tools/strategy-library.js"
  }
];

const configEnvMap = new Map([
  ["legacyProfileRoot", "ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT"],
  ["jdPages", "ECOMMERCE_SOURCING_JD_PAGES"],
  ["minJdComments", "ECOMMERCE_SOURCING_MIN_JD_COMMENTS"],
  ["minTaobaoSales", "ECOMMERCE_SOURCING_MIN_TAOBAO_SALES"],
  ["requireDomesticShipping", "ECOMMERCE_SOURCING_REQUIRE_DOMESTIC_SHIPPING"],
  ["requireFastShippingHours", "ECOMMERCE_SOURCING_REQUIRE_FAST_SHIPPING_HOURS"]
]);

const toolCache = new Map();

export async function handleJsonRpcMessage(message) {
  if (!message || typeof message !== "object") {
    return jsonRpcErrorResponse(null, -32600, "无效 JSON-RPC 消息");
  }

  if (message.id === undefined) {
    await handleNotification(message).catch((error) => {
      log("warn", `通知处理失败：${error?.message || error}`);
    });
    return null;
  }

  try {
    const result = await dispatchRequest(message.method, message.params);
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : -32603;
    return jsonRpcErrorResponse(message.id, code, error?.message || "MCP 请求执行失败", error?.data);
  }
}

export async function dispatchRequest(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        prompts: {}
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION
      }
    };
  }

  if (method === "ping") return {};

  if (method === "tools/list") {
    const tools = await loadTools();
    return {
      tools: tools.map(({ mcpName, mod }) => ({
        name: mcpName,
        description: mod.description || mcpName,
        inputSchema: normalizeSchema(mod.parameters)
      }))
    };
  }

  if (method === "tools/call") {
    return callTool(params);
  }

  if (method === "prompts/list") {
    return {
      prompts: [
        {
          name: AGENT_GUIDE_NAME,
          description: "电商选品 MCP 使用手册：账号池、AI 浏览器、选品流程、导出和安全边界。",
          arguments: []
        }
      ]
    };
  }

  if (method === "prompts/get") {
    if (params?.name && params.name !== AGENT_GUIDE_NAME) {
      throw jsonRpcError(-32602, `未知 prompt：${params.name}`);
    }
    return {
      description: "电商选品 MCP 使用手册",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildAgentGuide()
          }
        }
      ]
    };
  }

  throw jsonRpcError(-32601, `不支持的 MCP 方法：${method}`);
}

export async function executeMcpTool(name, args = {}) {
  if (!name || typeof name !== "string") {
    throw jsonRpcError(-32602, "tools/call 缺少工具名称");
  }

  const tools = await loadTools();
  const selected = tools.find((tool) => tool.mcpName === name);
  if (!selected) {
    throw jsonRpcError(-32602, `未知工具：${name}`);
  }

  try {
    const result = await selected.mod.execute(args || {}, createContext());
    return normalizeToolResult(result);
  } catch (error) {
    log("error", `工具 ${name} 执行失败：${error?.stack || error}`);
    return {
      content: [
        {
          type: "text",
          text: `工具执行失败：${error?.message || String(error)}`
        }
      ],
      isError: true
    };
  }
}

export function jsonRpcErrorResponse(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

export function createContext() {
  const dataDir = process.env.ECOMMERCE_SOURCING_DATA_DIR
    || join(homedir(), ".ecommerce-sourcing-agent");
  mkdirSync(dataDir, { recursive: true });

  return {
    dataDir,
    pluginId: "ecommerce-sourcing",
    pluginRoot,
    config: {
      get(key) {
        const envKey = configEnvMap.get(key);
        if (!envKey) return "";
        return process.env[envKey] ?? "";
      }
    },
    log: {
      debug: (...args) => log("debug", ...args),
      info: (...args) => log("info", ...args),
      warn: (...args) => log("warn", ...args),
      error: (...args) => log("error", ...args)
    },
    async stageFile(filePath) {
      return filePath;
    }
  };
}

export function log(level, ...args) {
  const text = args.map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(" ");
  process.stderr.write(`[${SERVER_NAME}] [${level}] ${text}\n`);
}

async function handleNotification(message) {
  if (message.method === "notifications/initialized") return;
  log("debug", `忽略通知：${message.method || "unknown"}`);
}

async function callTool(params) {
  return executeMcpTool(params?.name, params?.arguments || {});
}

async function loadTools() {
  if (toolCache.size === toolSpecs.length) {
    return toolSpecs.map((spec) => ({ ...spec, mod: toolCache.get(spec.mcpName) }));
  }

  for (const spec of toolSpecs) {
    if (toolCache.has(spec.mcpName)) continue;
    const mod = await import(new URL(spec.modulePath, import.meta.url));
    toolCache.set(spec.mcpName, mod);
  }

  return toolSpecs.map((spec) => ({ ...spec, mod: toolCache.get(spec.mcpName) }));
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return {
    type: "object",
    properties: schema.properties || {},
    required: schema.required || [],
    additionalProperties: schema.additionalProperties ?? false
  };
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) && result.content.length > 0
    ? result.content.map(normalizeContentItem)
    : [{ type: "text", text: result == null ? "工具执行完成。" : JSON.stringify(result, null, 2) }];

  const response = { content };
  if (result?.details && typeof result.details === "object") {
    response.structuredContent = result.details;
  }
  if (result?.isError) response.isError = true;
  return response;
}

function normalizeContentItem(item) {
  if (item?.type === "image" && item.data && item.mimeType) {
    return {
      type: "image",
      data: String(item.data),
      mimeType: String(item.mimeType)
    };
  }
  return {
    type: "text",
    text: String(item?.text ?? "")
  };
}

function jsonRpcError(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}
