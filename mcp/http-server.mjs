#!/usr/bin/env node

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchRequest, handleJsonRpcMessage, jsonRpcErrorResponse, log, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "./runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(__dirname);
const host = process.env.ECOMMERCE_SOURCING_HTTP_HOST || "127.0.0.1";
const port = Number(process.env.ECOMMERCE_SOURCING_HTTP_PORT || 7331);
const apiKey = process.env.ECOMMERCE_SOURCING_API_KEY || "";
const executionMode = process.env.ECOMMERCE_SOURCING_EXECUTION_MODE || "direct";
const workerKey = process.env.ECOMMERCE_SOURCING_WORKER_KEY || "";
const users = loadUsers();
const workerJobTimeoutMs = Number(process.env.ECOMMERCE_SOURCING_WORKER_JOB_TIMEOUT_MS || 30 * 60 * 1000);
const workerPickupTimeoutMs = Number(process.env.ECOMMERCE_SOURCING_WORKER_PICKUP_TIMEOUT_MS || 30 * 1000);
const allowedOrigins = (process.env.ECOMMERCE_SOURCING_ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const supportedProtocolVersions = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const pendingJobs = new Map();
const queuedJobs = [];
const waitingPolls = [];
const lastWorkerSeenAtByUser = new Map();

if (host !== "127.0.0.1" && host !== "localhost" && users.length === 0) {
  log("error", "HTTP MCP 监听非本机地址时必须设置 ECOMMERCE_SOURCING_API_KEY。");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      const healthUser = authorizeClient(req);
      sendJson(res, 200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        ok: true,
        auth: users.length > 0 ? "required" : "disabled-local",
        executionMode,
        worker: executionMode === "worker"
          ? workerHealthSummary(healthUser)
          : undefined
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/users") {
      const user = authorizeClient(req);
      if (!user) {
        sendJson(res, 401, { error: "missing_or_invalid_api_key" });
        return;
      }
      sendJson(res, 200, {
        currentUser: user.id,
        worker: workerHealthSummary(user),
        configuredUsers: users.length
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/install.sh") {
      const script = readFileSync(join(pluginRoot, "scripts", "install-worker.sh"), "utf8");
      sendText(res, 200, script, "text/x-shellscript; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/install.ps1") {
      const script = readFileSync(join(pluginRoot, "scripts", "install-worker.ps1"), "utf8");
      sendText(res, 200, script, "text/plain; charset=utf-8");
      return;
    }

    if (url.pathname === "/worker/poll" || url.pathname === "/worker/result") {
      await handleWorkerRequest(req, res, url);
      return;
    }

    if (!isOriginAllowed(req)) {
      sendJson(res, 403, { error: "origin_not_allowed" });
      return;
    }

    const clientUser = authorizeClient(req);
    if (!clientUser) {
      sendJson(res, 401, { error: "missing_or_invalid_api_key" });
      return;
    }

    if (!isProtocolVersionSupported(req)) {
      sendJson(res, 400, { error: "unsupported_mcp_protocol_version" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/tools") {
      sendJson(res, 200, await dispatchRequest("tools/list", {}));
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method === "GET" || req.method === "DELETE") {
        sendJson(res, 405, { error: req.method === "GET" ? "sse_stream_not_supported" : "session_delete_not_supported" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      const body = await readJson(req);
      if (Array.isArray(body)) {
        sendJson(res, 400, jsonRpcErrorResponse(null, -32600, "Streamable HTTP MCP 每次 POST 只接受一个 JSON-RPC 消息"));
        return;
      }

      const response = await handleMcpHttpMessage(body, clientUser);
      if (!response) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    log("error", `HTTP MCP 请求失败：${error?.stack || error}`);
    sendJson(res, 500, jsonRpcErrorResponse(null, -32603, error?.message || "HTTP MCP 请求失败"));
  }
});

server.listen(port, host, () => {
  log("info", `HTTP MCP server listening on http://${host}:${port}/mcp`);
});

function authorizeClient(req) {
  if (users.length === 0) return { id: "local" };
  const auth = req.headers.authorization || "";
  const headerKey = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const directKey = String(req.headers["x-api-key"] || "");
  return users.find((user) => user.apiKey && (user.apiKey === headerKey || user.apiKey === directKey)) || null;
}

async function handleMcpHttpMessage(message, clientUser) {
  if (executionMode === "worker" && message?.id !== undefined && message?.method === "tools/call") {
    const result = await enqueueWorkerToolCall(message.params || {}, clientUser);
    return { jsonrpc: "2.0", id: message.id, result };
  }
  return handleJsonRpcMessage(message);
}

async function enqueueWorkerToolCall(params, clientUser) {
  if (!clientUser?.workerKey) {
    return workerErrorResult("服务器已启用本机 worker 模式，但没有配置 ECOMMERCE_SOURCING_WORKER_KEY。");
  }

  const job = {
    id: randomUUID(),
    kind: "tools/call",
    userId: clientUser.id,
    params,
    createdAt: Date.now()
  };

  return new Promise((resolve) => {
    const jobTimer = setTimeout(() => {
      pendingJobs.delete(job.id);
      removeQueuedJob(job.id);
      resolve(workerErrorResult("本机 worker 执行超时，请确认用户电脑上的 local-worker 是否仍在运行。"));
    }, workerJobTimeoutMs);

    const pickupTimer = setTimeout(() => {
      const record = pendingJobs.get(job.id);
      if (!record || record.dispatched) return;
      pendingJobs.delete(job.id);
      removeQueuedJob(job.id);
      resolve(workerErrorResult("还没有可用的本机 worker。请先在用户电脑运行 local-worker，再重试。"));
    }, workerPickupTimeoutMs);

    pendingJobs.set(job.id, {
      job,
      resolve,
      jobTimer,
      pickupTimer,
      dispatched: false
    });

    dispatchOrQueueJob(job);
  });
}

function dispatchOrQueueJob(job) {
  removeClosedPolls();
  const waiterIndex = waitingPolls.findIndex((item) => item.userId === job.userId);
  const waiter = waiterIndex >= 0 ? waitingPolls.splice(waiterIndex, 1)[0] : null;
  while (waiter && isPollClosed(waiter)) {
    clearTimeout(waiter.timer);
    return dispatchOrQueueJob(job);
  }

  if (!waiter) {
    queuedJobs.push(job);
    return;
  }

  clearTimeout(waiter.timer);
  markJobDispatched(job.id);
  sendJson(waiter.res, 200, job);
}

function markJobDispatched(jobId) {
  const record = pendingJobs.get(jobId);
  if (!record) return;
  record.dispatched = true;
  clearTimeout(record.pickupTimer);
}

function removeQueuedJob(jobId) {
  const index = queuedJobs.findIndex((job) => job.id === jobId);
  if (index >= 0) queuedJobs.splice(index, 1);
}

async function handleWorkerRequest(req, res, url) {
  if (executionMode !== "worker") {
    sendJson(res, 404, { error: "worker_mode_disabled" });
    return;
  }
  const workerUser = authorizeWorker(req);
  if (!workerUser) {
    sendJson(res, 401, { error: "missing_or_invalid_worker_key" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (url.pathname === "/worker/poll") {
    await handleWorkerPoll(req, res, workerUser);
    return;
  }
  if (url.pathname === "/worker/result") {
    await handleWorkerResult(req, res, workerUser);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function handleWorkerPoll(req, res, workerUser) {
  await readJson(req).catch(() => ({}));
  lastWorkerSeenAtByUser.set(workerUser.id, Date.now());

  const jobIndex = queuedJobs.findIndex((item) => item.userId === workerUser.id);
  const job = jobIndex >= 0 ? queuedJobs.splice(jobIndex, 1)[0] : null;
  if (job) {
    markJobDispatched(job.id);
    sendJson(res, 200, job);
    return;
  }

  const timer = setTimeout(() => {
    removeWaitingPoll(waiter);
    res.writeHead(204);
    res.end();
  }, 25000);
  const waiter = { userId: workerUser.id, res, timer };
  const closeHandler = () => {
    removeWaitingPoll(waiter);
    clearTimeout(timer);
  };
  res.once("close", closeHandler);
  waitingPolls.push(waiter);
}

async function handleWorkerResult(req, res, workerUser) {
  const body = await readJson(req);
  lastWorkerSeenAtByUser.set(workerUser.id, Date.now());
  const record = pendingJobs.get(body?.jobId);
  if (!record) {
    sendJson(res, 404, { error: "job_not_found_or_expired" });
    return;
  }

  if (record.job.userId !== workerUser.id) {
    sendJson(res, 403, { error: "worker_user_mismatch" });
    return;
  }

  pendingJobs.delete(body.jobId);
  clearTimeout(record.jobTimer);
  clearTimeout(record.pickupTimer);

  if (body.error) {
    record.resolve(workerErrorResult(String(body.error)));
  } else {
    record.resolve(body.result || workerErrorResult("本机 worker 没有返回结果。"));
  }
  sendJson(res, 200, { ok: true });
}

function authorizeWorker(req) {
  if (users.length === 0) return null;
  const auth = req.headers.authorization || "";
  const headerKey = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const directKey = String(req.headers["x-worker-key"] || "");
  return users.find((user) => user.workerKey && (user.workerKey === headerKey || user.workerKey === directKey)) || null;
}

function isPollClosed(waiter) {
  return waiter.res.destroyed || waiter.res.writableEnded;
}

function removeWaitingPoll(waiter) {
  const index = waitingPolls.indexOf(waiter);
  if (index >= 0) waitingPolls.splice(index, 1);
}

function removeClosedPolls() {
  for (let index = waitingPolls.length - 1; index >= 0; index -= 1) {
    if (!isPollClosed(waitingPolls[index])) continue;
    clearTimeout(waitingPolls[index].timer);
    waitingPolls.splice(index, 1);
  }
}

function workerHealthSummary(user) {
  if (executionMode !== "worker") return undefined;
  const userId = user?.id || null;
  const seenTimes = userId ? [lastWorkerSeenAtByUser.get(userId) || 0] : [...lastWorkerSeenAtByUser.values()];
  const connected = seenTimes.some((time) => time && Date.now() - time < 60000);
  return {
    connected,
    ...(userId ? { userId } : { connectedUsers: seenTimes.filter((time) => time && Date.now() - time < 60000).length }),
    lastSeenAt: userId ? (lastWorkerSeenAtByUser.get(userId) || null) : null,
    queuedJobs: userId ? queuedJobs.filter((job) => job.userId === userId).length : queuedJobs.length,
    pendingJobs: userId ? [...pendingJobs.values()].filter((record) => record.job.userId === userId).length : pendingJobs.size
  };
}

function loadUsers() {
  const configured = String(process.env.ECOMMERCE_SOURCING_USERS || "").trim();
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((item, index) => ({
        id: String(item.id || item.userId || `user-${index + 1}`),
        apiKey: String(item.apiKey || ""),
        workerKey: String(item.workerKey || "")
      })).filter((item) => item.apiKey && (executionMode !== "worker" || item.workerKey));
    } catch (error) {
      log("error", `ECOMMERCE_SOURCING_USERS 解析失败：${error?.message || error}`);
      process.exit(1);
    }
  }
  if (apiKey && (executionMode !== "worker" || workerKey)) {
    return [{
      id: process.env.ECOMMERCE_SOURCING_DEFAULT_USER_ID || "default",
      apiKey,
      workerKey
    }];
  }
  return [];
}

function workerErrorResult(message) {
  return {
    content: [{ type: "text", text: `本机 worker 未完成执行：${message}` }],
    isError: true
  };
}

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return true;
  return isLocalHost(host) && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

function isProtocolVersionSupported(req) {
  const version = req.headers["mcp-protocol-version"];
  if (!version) return true;
  return typeof version === "string" && supportedProtocolVersions.has(version);
}

function isLocalHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Content-Length": Buffer.byteLength(body, "utf8")
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body, "utf8")
  });
  res.end(body);
}
