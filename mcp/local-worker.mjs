#!/usr/bin/env node

import { executeMcpTool, log } from "./runtime.mjs";

const serverUrl = normalizeServerUrl(process.env.ECOMMERCE_SOURCING_MCP_SERVER_URL || process.argv[2] || "");
const workerKey = process.env.ECOMMERCE_SOURCING_WORKER_KEY || process.argv[3] || "";
const workerId = process.env.ECOMMERCE_SOURCING_WORKER_ID || `worker-${process.pid}`;
const pollIntervalMs = Number(process.env.ECOMMERCE_SOURCING_WORKER_POLL_INTERVAL_MS || 1000);

if (!serverUrl || !workerKey) {
  process.stderr.write([
    "用法：",
    "  ECOMMERCE_SOURCING_MCP_SERVER_URL=http://服务器:7331/mcp \\",
    "  ECOMMERCE_SOURCING_WORKER_KEY=你的worker密钥 \\",
    "  node mcp/local-worker.mjs",
    "",
    "local-worker 必须运行在需要操作正式 Chrome 的用户电脑上。"
  ].join("\n") + "\n");
  process.exit(1);
}

log("info", `local worker started: ${workerId}, server=${serverUrl}`);

while (true) {
  try {
    const job = await pollJob();
    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }
    await handleJob(job);
  } catch (error) {
    log("warn", `worker loop failed: ${error?.message || error}`);
    await sleep(Math.max(1000, pollIntervalMs));
  }
}

async function pollJob() {
  const response = await fetch(workerEndpoint("/worker/poll"), {
    method: "POST",
    headers: workerHeaders(),
    body: JSON.stringify({ workerId })
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`poll failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function handleJob(job) {
  log("info", `received job ${job.id}: ${job.params?.name || "unknown"}`);
  try {
    const result = await executeMcpTool(job.params?.name, job.params?.arguments || {});
    await postResult(job.id, { result });
  } catch (error) {
    await postResult(job.id, { error: error?.message || String(error) });
  }
}

async function postResult(jobId, payload) {
  const response = await fetch(workerEndpoint("/worker/result"), {
    method: "POST",
    headers: workerHeaders(),
    body: JSON.stringify({ workerId, jobId, ...payload })
  });
  if (!response.ok) {
    throw new Error(`result post failed: ${response.status} ${await response.text()}`);
  }
}

function workerEndpoint(pathname) {
  const url = new URL(serverUrl);
  const basePath = url.pathname.endsWith("/mcp")
    ? url.pathname.slice(0, -"/mcp".length)
    : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${pathname}`;
  url.search = "";
  return url.toString();
}

function workerHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${workerKey}`
  };
}

function normalizeServerUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
