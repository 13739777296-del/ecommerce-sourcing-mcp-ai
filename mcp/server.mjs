#!/usr/bin/env node

import { handleJsonRpcMessage, jsonRpcErrorResponse, log } from "./runtime.mjs";

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  log("error", `未捕获异常：${error?.stack || error}`);
});

process.on("unhandledRejection", (error) => {
  log("error", `未处理 Promise 拒绝：${error?.stack || error}`);
});

function drainInput() {
  while (inputBuffer.length > 0) {
    const framed = tryReadFramedMessage();
    if (framed === null) {
      if (looksLikePartialFrame()) return;
      const line = tryReadLineMessage();
      if (line === null) return;
      void handleRawMessage(line);
      continue;
    }
    void handleRawMessage(framed);
  }
}

function tryReadFramedMessage() {
  const headerEnd = inputBuffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;

  const headerText = inputBuffer.subarray(0, headerEnd).toString("utf8");
  const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
  if (!lengthMatch) {
    inputBuffer = inputBuffer.subarray(headerEnd + 4);
    return null;
  }

  const length = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (inputBuffer.length < bodyEnd) return null;

  const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
  inputBuffer = inputBuffer.subarray(bodyEnd);
  return body;
}

function looksLikePartialFrame() {
  const preview = inputBuffer.subarray(0, Math.min(inputBuffer.length, 64)).toString("utf8");
  return /^content-length:/i.test(preview) && inputBuffer.indexOf("\r\n\r\n") < 0;
}

function tryReadLineMessage() {
  const newline = inputBuffer.indexOf(10);
  if (newline < 0) return null;

  const line = inputBuffer.subarray(0, newline).toString("utf8").trim();
  inputBuffer = inputBuffer.subarray(newline + 1);
  return line || null;
}

async function handleRawMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    sendMessage(jsonRpcErrorResponse(null, -32700, "JSON 解析失败", error instanceof Error ? error.message : String(error)));
    return;
  }

  const response = await handleJsonRpcMessage(message);
  if (response) sendMessage(response);
}

function sendMessage(message) {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header + body);
}
