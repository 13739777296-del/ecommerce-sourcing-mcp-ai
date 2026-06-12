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
import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLarkChannel, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";

const BASE = "https://open.feishu.cn/open-apis";
const AUTH_BASE = "https://accounts.feishu.cn";

// ---- 凭证 ----
function credPath(dataDir) { mkdirSync(dataDir, { recursive: true }); return join(dataDir, "feishu-cred.json"); }
function loadCred(dataDir) { try { return JSON.parse(readFileSync(credPath(dataDir), "utf8")); } catch { return null; } }
function saveCred(dataDir, cred) {
  const target = credPath(dataDir);
  writeFileSync(target, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch {}
}

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
      const text = typeof msg?.content === "string" ? msg.content : (msg?.content?.text || msg?.text || "");
      if (!text) { console.log("[飞书] 收到空消息,raw:", JSON.stringify(msg).slice(0,100)); return; }
      console.log(`[飞书] ← ${msg.senderName || msg.senderId || "?"}: ${text}`);
      inboundMsgs.push({
        from: msg.senderName || msg.senderId || "unknown",
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
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(buf); parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

export async function exportToFeishu(db, dataDir) {
  try {
    const cred = loadCred(dataDir);
    if (!cred) return { ok: false, needBind: true, message: "飞书未绑定" };

    const rawDb = db.db || db;
    const token = await getTenantToken(cred.app_id, cred.app_secret);
    const h = (ct) => ({ "Authorization": `Bearer ${token}`, "Content-Type": ct || "application/json" });

    // 1. 建表
    const tData = await feishuJson(`${BASE}/bitable/v1/apps`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ name: `选品结果 ${new Date().toLocaleDateString("zh-CN")}` })
    }, "创建多维表格");
    const { app_token: appToken, default_table_id: tableId } = tData.data.app;

    // 1.5 主字段不能删除，初始化为"序号"，用于消除默认"文本"字段的观感。
    const fieldsData = await feishuJson(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { headers: h() }, "读取字段");
    const firstField = fieldsData.data?.items?.[0];
    const primaryField = await initializePrimaryField(appToken, tableId, firstField, token);
    const primaryFieldName = primaryField.name;
    const primaryFieldType = primaryField.type;

    // 2. 加字段（类型: 1=文本 2=数字 15=超链接 17=附件）
    const fieldDefs = [
      ["京东截图",17],["京东价格",2],["京东单价",2],
      ["淘宝截图",17],["淘宝价格",2],["淘宝单价",2],
      ["利润率",1],["利润金额",2],["是否最佳",1],
      ["京东SKU",1],["京东标题",1],["淘宝标题",1],
      ["京东店铺",1],["淘宝店铺",1],["发货地",1],
      ["京东商品ID",1],["京东链接",15],["淘宝链接",15],["创建时间",1]
    ];
    for (const [name, type] of fieldDefs) {
      await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        method: "POST", headers: h(), body: JSON.stringify({ field_name: name, type })
      }).then(r => r.json()).then((data) => {
        if (data.code !== 0 && !/duplicated|duplicate|已存在/i.test(data.msg || "")) {
          console.warn(`[飞书] 字段创建失败 ${name}: ${data.msg}`);
        }
      });
    }

    // 2.5 删除飞书默认生成的多余字段。主字段通常不可删除，保留为序号列。
    const expectedFieldNames = new Set([primaryFieldName, ...fieldDefs.map(([name]) => name)]);
    const beforeCleanupFields = await feishuJson(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { headers: h() }, "确认字段");
    for (const field of beforeCleanupFields.data?.items || []) {
      const name = field.field_name;
      if (!field.field_id || expectedFieldNames.has(name) || name === primaryFieldName) continue;
      await deleteFeishuField(appToken, tableId, field, token);
    }

    // 2.6 读回字段列表确认清理完成
    const actualFields = await feishuJson(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { headers: h() }, "确认字段");
    const fieldNames = new Set((actualFields.data?.items || []).map(f => f.field_name));
    console.log("[飞书] 实际字段:", [...fieldNames].slice(0, 8).join(", "), "...");

    // 2.7 飞书新表可能自带几条空记录，写入前统一清空。
    await clearDefaultRecords(appToken, tableId, token);

    // 3. 读数据 + 上传截图到多维表格（附件字段写入 file_token）
    const rows = rawDb.prepare(`
      SELECT p.jd_product_id, p.jd_title, p.jd_price, p.jd_unit_price, p.jd_sku_info, p.jd_shop, p.jd_url, p.jd_screenshot_path,
        t2.taobao_price, t2.taobao_unit_price, t2.profit_amount, t2.profit_rate, t2.taobao_title, t2.taobao_shop,
        t2.taobao_ship_from, t2.taobao_url, t2.taobao_screenshot_path, t2.is_best, p.created_at
      FROM sourcing_products p
      LEFT JOIN sourcing_taobao_matches t2 ON p.jd_product_id = t2.jd_product_id
      ORDER BY t2.profit_rate DESC, p.updated_at DESC
    `).all();

    const imgCache = new Map();
    for (const r of rows) {
      for (const p of [r.jd_screenshot_path, r.taobao_screenshot_path]) {
        if (p && !imgCache.has(p) && existsSync(p)) {
          try {
            const { body, boundary } = buildMultipart({ file_name: "screenshot.png", parent_type: "bitable_file", parent_node: appToken, size: String(readFileSync(p).length) }, p);
            const id = await feishuJson(`${BASE}/drive/v1/medias/upload_all`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
              body
            }, "上传附件");
            if (id.data?.file_token) imgCache.set(p, id.data.file_token);
          } catch (error) {
            console.warn(`[飞书] 上传截图失败 ${p}: ${error.message}`);
          }
        }
      }
    }

    // 4. 逐行插入
    let count = 0;
    for (const r of rows) {
      const jdImg = r.jd_screenshot_path && imgCache.get(r.jd_screenshot_path);
      const tbImg = r.taobao_screenshot_path && imgCache.get(r.taobao_screenshot_path);
      const rowNumber = count + 1;
      const fields = {
        [primaryFieldName]: primaryFieldType === 2 ? rowNumber : String(rowNumber),
        "京东商品ID": r.jd_product_id || "",
        "京东店铺": r.jd_shop || "",
        "京东标题": r.jd_title || "",
        "京东价格": Number(r.jd_price) || 0,
        "京东单价": Number(r.jd_unit_price) || 0,
        "京东SKU": r.jd_sku_info || "",
        "京东截图": jdImg ? [{ file_token: jdImg }] : [],
        "淘宝价格": Number(r.taobao_price) || 0,
        "淘宝单价": Number(r.taobao_unit_price) || 0,
        "利润金额": Number(r.profit_amount) || 0,
        "利润率": r.profit_rate == null ? "" : (Number(r.profit_rate) * 100).toFixed(1) + "%",
        "淘宝标题": r.taobao_title || "",
        "淘宝店铺": r.taobao_shop || "",
        "发货地": r.taobao_ship_from || "",
        "淘宝截图": tbImg ? [{ file_token: tbImg }] : [],
        "京东链接": r.jd_url ? { text: "打开京东", link: r.jd_url } : null,
        "淘宝链接": r.taobao_url ? { text: "打开淘宝", link: r.taobao_url } : null,
        "是否最佳": r.is_best ? "是" : "",
        "创建时间": r.created_at || ""
      };

      // 只保留表里真实存在的字段
      const validFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (fieldNames.has(k) && v !== null) validFields[k] = v;
      }
      if (Object.keys(validFields).length === 0) continue;

      await feishuJson(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ fields: validFields })
      }, "写入记录");
      count++;
    }

    return { ok: true, count, url: `${cred.domain === "lark" ? "https://base.larksuite.com" : "https://feishu.cn"}/base/${appToken}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function feishuJson(url, options, label) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`${label}失败: ${data.msg || data.message || res.statusText || res.status}`);
  }
  return data;
}

async function deleteFeishuField(appToken, tableId, field, token) {
  const res = await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${field.field_id}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    console.warn(`[飞书] 默认字段删除失败 ${field.field_name}: ${data.msg || data.message || res.statusText || res.status}`);
    return false;
  }
  console.log(`[飞书] 已删除默认字段: ${field.field_name}`);
  return true;
}

async function initializePrimaryField(appToken, tableId, firstField, token) {
  if (!firstField?.field_id) return { name: "文本", type: 1 };
  const updateUrl = `${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${firstField.field_id}`;
  const attempts = [
    {
      label: "数字序号",
      body: { field_name: "序号", type: 2, property: { formatter: "0" } }
    },
    {
      label: "文本序号",
      body: { field_name: "序号", type: 1 }
    }
  ];

  for (const attempt of attempts) {
    const res = await fetch(updateUrl, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(attempt.body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.code === 0) {
      const field = data.data?.field || {};
      console.log(`[飞书] 主字段已改为${attempt.label}: ${field.field_name || "序号"}`);
      return {
        name: field.field_name || "序号",
        type: field.type || attempt.body.type
      };
    }
    console.warn(`[飞书] 主字段改为${attempt.label}失败: ${data.msg || data.message || res.statusText || res.status}`);
  }

  console.warn(`[飞书] 保留默认主字段「${firstField.field_name || "文本"}」，写入序号值。`);
  return {
    name: firstField.field_name || "文本",
    type: firstField.type || 1
  };
}

async function clearDefaultRecords(appToken, tableId, token) {
  const ids = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`);
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await feishuJson(url.toString(), {
      headers: { "Authorization": `Bearer ${token}` }
    }, "读取默认记录");
    ids.push(...(data.data?.items || []).map((item) => item.record_id).filter(Boolean));
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);

  if (!ids.length) return 0;

  let deleted = 0;
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500);
    await feishuJson(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch })
    }, "删除默认记录");
    deleted += batch.length;
  }
  console.log(`[飞书] 已删除默认空记录: ${deleted}`);
  return deleted;
}
