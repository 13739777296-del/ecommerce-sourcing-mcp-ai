import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
let server: McpTestClient | null = null;
const httpServers: ChildProcessWithoutNullStreams[] = [];
const workerProcesses: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const child of [...workerProcesses.splice(0), ...httpServers.splice(0)]) {
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 1000);
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ecommerce sourcing MCP server", () => {
  it("rejects an explicit harvest account when the platform does not match", async () => {
    const dataDir = tempDir("ecommerce-sourcing-account-route-");
    const { execute } = await import("../tools/sourcing.js");
    const ctx = {
      dataDir,
      config: { get: () => join(dataDir, "legacy-profiles") },
      log: console
    };

    const added = await execute({
      action: "account_add",
      platform: "taobao",
      displayName: "淘宝测试账号"
    }, ctx);

    const result = await execute({
      action: "jd_harvest",
      brand: "GNC",
      accountId: added.account.id,
      targetCount: 1
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("账号平台不匹配");
  });

  it("initializes, lists the all-in-one tool, and calls safe actions over stdio", async () => {
    const dataDir = tempDir("ecommerce-sourcing-mcp-");
    server = new McpTestClient(dataDir);

    const initialized = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" }
    });

    expect(initialized.serverInfo.name).toBe("ecommerce-sourcing-mcp");
    expect(initialized.capabilities.tools).toEqual({});
    expect(initialized.capabilities.prompts).toEqual({});

    const listed = await server.request("tools/list", {});
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(["ecommerce_sourcing"]);
    const actionEnum = listed.tools[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain("jd_harvest");
    expect(actionEnum).toContain("taobao_harvest");
    expect(actionEnum).toContain("ai_review_task");
    expect(actionEnum).toContain("save_sourcing");
    expect(actionEnum).toContain("sourcing_list");
    expect(actionEnum).toContain("logs");
    expect(actionEnum).not.toContain("full_selection");
    expect(actionEnum).not.toContain("batch_selection");

    const prompts = await server.request("prompts/list", {});
    expect(prompts.prompts.map((prompt: { name: string }) => prompt.name)).toContain("ecommerce_sourcing_agent_guide");

    const guidePrompt = await server.request("prompts/get", { name: "ecommerce_sourcing_agent_guide" });
    expect(guidePrompt.messages[0].content.text).toContain("只暴露一个 MCP 工具");
    expect(guidePrompt.messages[0].content.text).toContain("同款判断、SKU单位价换算、利润筛选必须由调用方 Agent");
    expect(guidePrompt.messages[0].content.text).toContain("save_sourcing");
    expect(guidePrompt.messages[0].content.text).toContain("sourcing_list");

    const guideTool = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "usage_guide" }
    });
    expect(toolJson(guideTool).guide.workflow).toContain("jd_harvest");
    expect(toolJson(guideTool).guide.workflow).toContain("ai_review_task");
    expect(toolJson(guideTool).guide.workflow).toContain("save_sourcing");
    expect(toolJson(guideTool).guide.workflow).toContain("sourcing_list");

    const bootstrap = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "bootstrap", mode: "command" }
    });
    expect(toolJson(bootstrap).installCommand).toContain("curl -fsSL");
    expect(toolJson(bootstrap).installScriptUrl).toContain("/install.sh");

    const bootstrapGuide = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "bootstrap", mode: "guide" }
    });
    expect(toolJson(bootstrapGuide).guide).toContain("save_sourcing");
    expect(toolJson(bootstrapGuide).guide).toContain("sourcing_list");

    const added = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: {
        action: "account_add",
        platform: "jd",
        displayName: "京东测试账号"
      }
    });
    const accountId = toolJson(added).account.id;
    expect(toolJson(added).account.status).toBe("login_required");

    const listedAccounts = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "account_list" }
    });
    expect(toolJson(listedAccounts).accounts.some((account: { id: string }) => account.id === accountId)).toBe(true);

    const removed = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "account_remove", accountId }
    });
    expect(toolJson(removed).removed.displayName).toBe("京东测试账号");

    const warmup = await server.request("tools/call", {
      name: "ecommerce_sourcing",
      arguments: { action: "warmup" }
    });
    expect(toolJson(warmup).message).toContain("个账号就绪");
  });

  it("serves MCP JSON-RPC over HTTP with API key protection", async () => {
    const dataDir = tempDir("ecommerce-sourcing-http-");
    const port = await getFreePort();
    const apiKey = "test-api-key";
    const child = spawn("node", ["mcp/http-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_DATA_DIR: dataDir,
        ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT: join(dataDir, "legacy-profiles"),
        ECOMMERCE_SOURCING_HTTP_PORT: String(port),
        ECOMMERCE_SOURCING_API_KEY: apiKey
      }
    });
    httpServers.push(child);

    await waitForHealth(port);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/tools`);
    expect(unauthorized.status).toBe(401);

    const installScript = await fetch(`http://127.0.0.1:${port}/install.sh`);
    expect(installScript.status).toBe(200);
    const installScriptText = await installScript.text();
    expect(installScriptText).toContain("com.ecommerce-sourcing-mcp.worker");
    expect(installScriptText).toContain("ecommerce-sourcing-mcp-ai.git");
    expect(installScriptText).toContain("请输入电商选品 MCP worker 密钥");
    expect(installScriptText).not.toMatch(/WORKER_KEY="\$\{ECOMMERCE_SOURCING_WORKER_KEY:-[a-f0-9]{32,}\}"/);

    const listed = await postMcp(port, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ecommerce_sourcing"]);

    const guide = await postMcp(port, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ecommerce_sourcing",
        arguments: { action: "usage_guide" }
      }
    });
    expect(toolJson(guide.result).guide.name).toBe("电商选品MCP");

    const notification = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "MCP-Protocol-Version": "2025-06-18"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    });
    expect(notification.status).toBe(202);
  });

  it("can route safe all-in-one tool calls through a local worker", async () => {
    const serverDataDir = tempDir("ecommerce-sourcing-server-");
    const workerDataDir = tempDir("ecommerce-sourcing-worker-");
    const port = await getFreePort();
    const apiKey = "test-api-key";
    const workerKey = "test-worker-key";
    const child = spawn("node", ["mcp/http-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_DATA_DIR: serverDataDir,
        ECOMMERCE_SOURCING_HTTP_PORT: String(port),
        ECOMMERCE_SOURCING_API_KEY: apiKey,
        ECOMMERCE_SOURCING_EXECUTION_MODE: "worker",
        ECOMMERCE_SOURCING_WORKER_KEY: workerKey,
        ECOMMERCE_SOURCING_WORKER_PICKUP_TIMEOUT_MS: "3000"
      }
    });
    httpServers.push(child);
    await waitForHealth(port);

    const worker = spawn("node", ["mcp/local-worker.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
        ECOMMERCE_SOURCING_WORKER_KEY: workerKey,
        ECOMMERCE_SOURCING_DATA_DIR: workerDataDir,
        ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT: join(workerDataDir, "legacy-profiles"),
        ECOMMERCE_SOURCING_WORKER_POLL_INTERVAL_MS: "50"
      }
    });
    workerProcesses.push(worker);

    await waitForWorker(port);

    const warmup = await postMcp(port, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ecommerce_sourcing",
        arguments: { action: "warmup" }
      }
    });

    expect(toolJson(warmup.result).message).toContain("个账号就绪");
  });

  it("binds queued tool calls to the matching user worker key", async () => {
    const serverDataDir = tempDir("ecommerce-sourcing-server-");
    const bobWorkerDataDir = tempDir("ecommerce-sourcing-bob-worker-");
    const aliceWorkerDataDir = tempDir("ecommerce-sourcing-alice-worker-");
    const port = await getFreePort();
    const child = spawn("node", ["mcp/http-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_DATA_DIR: serverDataDir,
        ECOMMERCE_SOURCING_HTTP_PORT: String(port),
        ECOMMERCE_SOURCING_EXECUTION_MODE: "worker",
        ECOMMERCE_SOURCING_USERS: JSON.stringify([
          { id: "alice", apiKey: "alice-api-key", workerKey: "alice-worker-key" },
          { id: "bob", apiKey: "bob-api-key", workerKey: "bob-worker-key" }
        ]),
        ECOMMERCE_SOURCING_WORKER_PICKUP_TIMEOUT_MS: "300"
      }
    });
    httpServers.push(child);
    await waitForHealth(port);

    const bobWorker = spawn("node", ["mcp/local-worker.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
        ECOMMERCE_SOURCING_WORKER_KEY: "bob-worker-key",
        ECOMMERCE_SOURCING_DATA_DIR: bobWorkerDataDir,
        ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT: join(bobWorkerDataDir, "legacy-profiles"),
        ECOMMERCE_SOURCING_WORKER_POLL_INTERVAL_MS: "50"
      }
    });
    workerProcesses.push(bobWorker);
    await waitForWorker(port);

    const missingAliceWorker = await postMcp(port, "alice-api-key", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "ecommerce_sourcing",
        arguments: { action: "warmup" }
      }
    });
    expect(missingAliceWorker.result.isError).toBe(true);
    expect(missingAliceWorker.result.content[0].text).toContain("还没有可用的本机 worker");

    const aliceWorker = spawn("node", ["mcp/local-worker.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
        ECOMMERCE_SOURCING_WORKER_KEY: "alice-worker-key",
        ECOMMERCE_SOURCING_DATA_DIR: aliceWorkerDataDir,
        ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT: join(aliceWorkerDataDir, "legacy-profiles"),
        ECOMMERCE_SOURCING_WORKER_POLL_INTERVAL_MS: "50"
      }
    });
    workerProcesses.push(aliceWorker);
    await waitForWorker(port);

    const aliceWarmup = await postMcp(port, "alice-api-key", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "ecommerce_sourcing",
        arguments: { action: "warmup" }
      }
    });
    expect(toolJson(aliceWarmup.result).message).toContain("个账号就绪");
  });

  it("does not dispatch worker jobs to a closed long-poll connection", async () => {
    const serverDataDir = tempDir("ecommerce-sourcing-server-");
    const port = await getFreePort();
    const apiKey = "test-api-key";
    const workerKey = "test-worker-key";
    const child = spawn("node", ["mcp/http-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_DATA_DIR: serverDataDir,
        ECOMMERCE_SOURCING_HTTP_PORT: String(port),
        ECOMMERCE_SOURCING_API_KEY: apiKey,
        ECOMMERCE_SOURCING_EXECUTION_MODE: "worker",
        ECOMMERCE_SOURCING_WORKER_KEY: workerKey,
        ECOMMERCE_SOURCING_WORKER_JOB_TIMEOUT_MS: "1000",
        ECOMMERCE_SOURCING_WORKER_PICKUP_TIMEOUT_MS: "120"
      }
    });
    httpServers.push(child);
    await waitForHealth(port);

    const controller = new AbortController();
    const poll = fetch(`http://127.0.0.1:${port}/worker/poll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerKey}`
      },
      body: JSON.stringify({ workerId: "aborted-worker" }),
      signal: controller.signal
    }).catch(() => null);

    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const warmup = await postMcp(port, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ecommerce_sourcing",
        arguments: { action: "warmup" }
      }
    });

    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(warmup.result.isError).toBe(true);
    expect(warmup.result.content[0].text).toContain("还没有可用的本机 worker");
  });
});

class McpTestClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  constructor(dataDir: string) {
    this.child = spawn("node", ["mcp/server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ECOMMERCE_SOURCING_DATA_DIR: dataDir,
        ECOMMERCE_SOURCING_LEGACY_PROFILE_ROOT: join(dataDir, "legacy-profiles")
      }
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });

    this.child.stderr.on("data", () => {
      // MCP logs go to stderr so stdout stays protocol-only.
    });

    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server exited before response: ${code}`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 8000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill();
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(resolve, 1000);
    });
  }

  private drain() {
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1] || 0);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!length || this.buffer.length < bodyEnd) return;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      const response = JSON.parse(body);
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
  }
}

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "legacy-profiles"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function toolJson(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法获取可用端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the child server has finished booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("HTTP MCP server did not become ready");
}

async function waitForWorker(port: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const health = await response.json().catch(() => ({}));
    if (health.worker?.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local worker did not connect");
}

async function postMcp(port: number, apiKey: string, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  expect(response.ok).toBe(true);
  return response.json();
}
