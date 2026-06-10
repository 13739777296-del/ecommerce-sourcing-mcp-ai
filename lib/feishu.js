/**
 * 飞书集成：扫码绑定 + 双向通信
 *
 * 绑定：bind_feishu → 飞书设备授权 → 扫码 → 完成
 * 发消息：notify_user → Agent通过飞书通知用户
 * 收消息：check_feishu_msgs → Agent读取用户发来的指令
 *
 * 双向基于飞书WebSocket长连接，不需要公网URL。
 * 参考 DeepSeek-GUI / OpenClaw 的实现。
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLarkChannel, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";

const BASE = "https://open.feishu.cn/open-apis";
const AUTH_BASE = "https://accounts.feishu.cn";

// ---- 凭证 ----
function credPath(dataDir) { mkdirSync(dataDir, { recursive: true }); return join(dataDir, "feishu-cred.json"); }
function loadCred(dataDir) { try { return JSON.parse(readFileSync(credPath(dataDir), "utf8")); } catch { return null; } }
function saveCred(dataDir, cred) { writeFileSync(credPath(dataDir), JSON.stringify(cred)); }

// ---- Tenant Token ----
async function getTenantToken(appId, appSecret) {
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg);
  return data.tenant_access_token;
}

// ---- 设备授权流 ----
async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function bindFeishu(dataDir) {
  await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, { action: "init" });
  const data = await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, {
    action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id"
  });
  const { verification_uri_complete: url, device_code: deviceCode, user_code: userCode } = data;
  if (!url || !deviceCode) return { ok: false, message: data.error_description || "飞书返回不完整" };

  console.log(`\n[飞书] 请扫码授权:\n  ${url}\n  用户码: ${userCode}`);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (data.interval || 5) * 1000));
    const poll = await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, { action: "poll", device_code: deviceCode });
    if (poll.error === "authorization_pending" || poll.error === "slow_down") continue;
    if (poll.error) return { ok: false, message: poll.error_description || poll.error };
    if (poll.client_id && poll.client_secret) {
      const cred = {
        app_id: poll.client_id, app_secret: poll.client_secret,
        open_id: poll.user_info?.open_id || "",
        domain: poll.user_info?.tenant_brand === "lark" ? "lark" : "feishu",
        created_at: new Date().toISOString()
      };
      saveCred(dataDir, cred);
      return { ok: true, message: "飞书已绑定" };
    }
  }
  return { ok: false, message: "授权超时" };
}

// ====== WebSocket 双向通道 ======
let wsChannel = null;
let wsCred = null;
const inboundMsgs = []; // 用户发来的消息队列
const MAX_QUEUE = 200;

export function stopFeishuChannel() {
  if (wsChannel) { try { wsChannel.disconnect(); } catch {} wsChannel = null; }
  wsCred = null;
}

export async function startFeishuChannel(dataDir) {
  const cred = loadCred(dataDir);
  if (!cred || !cred.app_id) return { ok: false, message: "飞书未绑定，请先 bind_feishu" };

  // 已在运行且凭证未变
  if (wsChannel && wsCred?.app_id === cred.app_id) return { ok: true, message: "通道已运行中" };

  stopFeishuChannel();
  wsCred = cred;

  try {
    const domain = cred.domain === "lark" ? Domain.Lark : Domain.Feishu;
    const bridge = createLarkChannel({
      appId: cred.app_id, appSecret: cred.app_secret, domain,
      loggerLevel: LoggerLevel.warn, transport: "websocket",
      policy: { dmMode: "open", requireMention: true, respondToMentionAll: true }
    });

    bridge.on("message", async (msg) => {
      const text = msg?.content?.text || msg?.text || "";
      if (!text) return;
      inboundMsgs.push({
        from: msg.sender?.name || msg.open_id || "unknown",
        text, time: new Date().toISOString()
      });
      if (inboundMsgs.length > MAX_QUEUE) inboundMsgs.shift();
    });

    bridge.on("error", (e) => console.error("[飞书] 通道错误:", e.message));
    bridge.on("reconnecting", () => console.log("[飞书] 重连中..."));
    bridge.on("reconnected", () => console.log("[飞书] 已重连"));

    await bridge.connect();
    wsChannel = bridge;
    console.log("[飞书] WebSocket 通道已建立");
    return { ok: true, message: "飞书双向通道已启动" };
  } catch (e) {
    stopFeishuChannel();
    return { ok: false, message: `启动失败: ${e.message}` };
  }
}

export function readFeishuMsgs() {
  const msgs = inboundMsgs.splice(0);
  return { ok: true, count: msgs.length, messages: msgs };
}

// ====== 发送消息 ======
export async function sendFeishuMsg(dataDir, content) {
  const cred = loadCred(dataDir);
  if (!cred?.open_id) return { ok: false, message: "飞书未绑定" };
  try {
    const token = await getTenantToken(cred.app_id, cred.app_secret);
    const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: cred.open_id, msg_type: "text", content: JSON.stringify({ text: content }) })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg);
    return { ok: true, message: "已发送" };
  } catch (e) { return { ok: false, message: e.message }; }
}

// ====== 多维表格导出 ======
function buildMultipart(fields, filePath) {
  const boundary = "----Boundary" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (filePath) {
    const buf = readFileSync(filePath);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(buf); parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

export async function exportToFeishu(db, dataDir) {
  const cred = loadCred(dataDir);
  if (!cred) return { ok: false, needBind: true, message: "飞书未绑定" };

  const token = await getTenantToken(cred.app_id, cred.app_secret);
  const h = () => ({ "Authorization": `Bearer ${token}`, "Content-Type": "application/json" });

  const tRes = await fetch(`${BASE}/bitable/v1/apps`, { method: "POST", headers: h(), body: JSON.stringify({ name: `选品结果 ${new Date().toLocaleDateString("zh-CN")}` }) });
  const tData = await tRes.json();
  if (tData.code !== 0) throw new Error(`建表失败: ${tData.msg}`);
  const { app_token: appToken, table_id: tableId } = tData.data.app;

  const fields = ["京东标题","京东价格","京东店铺","京东截图","淘宝价格","利润金额","利润率","淘宝标题","淘宝店铺","发货地","淘宝截图","京东链接","淘宝链接"];
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/batch_create`, {
    method: "POST", headers: h(), body: JSON.stringify({ fields: fields.map(f => ({ field_name: f, type: 1 })) })
  }).then(r => r.json());

  const rows = db.prepare(`SELECT p.jd_title, p.jd_price, p.jd_shop, p.jd_url, p.jd_screenshot_path, t2.taobao_price, t2.profit_amount, t2.profit_rate, t2.taobao_title, t2.taobao_shop, t2.taobao_ship_from, t2.taobao_url, t2.taobao_screenshot_path FROM sourcing_products p JOIN sourcing_taobao_matches t2 ON p.jd_product_id = t2.jd_product_id ORDER BY t2.profit_rate DESC LIMIT 200`).all();

  const imgCache = new Map();
  for (const r of rows) {
    for (const p of [r.jd_screenshot_path, r.taobao_screenshot_path]) {
      if (p && !imgCache.has(p) && existsSync(p)) {
        try {
          const { body, boundary } = buildMultipart({ image_type: "message" }, p);
          const ir = await fetch(`${BASE}/im/v1/images`, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
          const id = await ir.json();
          if (id.code === 0) imgCache.set(p, id.data.image_key);
        } catch {}
      }
    }
  }

  const records = rows.map(r => ({ fields: {
    "京东标题": r.jd_title||"", "京东价格": String(r.jd_price||""), "京东店铺": r.jd_shop||"", "京东链接": r.jd_url||"",
    "京东截图": (r.jd_screenshot_path && imgCache.get(r.jd_screenshot_path)) ? [{ image_key: imgCache.get(r.jd_screenshot_path), width: 300, height: 400 }] : [],
    "淘宝价格": String(r.taobao_price||""), "利润金额": String(r.profit_amount||""), "利润率": r.profit_rate ? (r.profit_rate*100).toFixed(1)+"%" : "",
    "淘宝标题": r.taobao_title||"", "淘宝店铺": r.taobao_shop||"", "发货地": r.taobao_ship_from||"", "淘宝链接": r.taobao_url||"",
    "淘宝截图": (r.taobao_screenshot_path && imgCache.get(r.taobao_screenshot_path)) ? [{ image_key: imgCache.get(r.taobao_screenshot_path), width: 300, height: 400 }] : []
  }}));
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, { method: "POST", headers: h(), body: JSON.stringify({ records }) }).then(r => r.json());

  return { ok: true, count: rows.length, url: `https://bytedance.feishu.cn/base/${appToken}` };
}
