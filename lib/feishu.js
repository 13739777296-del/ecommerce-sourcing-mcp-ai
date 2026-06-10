/**
 * 飞书集成：扫码即完成（设备授权流，零配置）
 *
 * 绑定（扫码即可）：
 *   调 bind_feishu → 终端打印扫码链接 → 手机飞书扫码授权 → 完成
 *   之后调 export_feishu 直接导出，凭证自动保存。
 *
 * 原理：使用飞书设备授权流 (OAuth device flow)，
 *   飞书自动创建「个人代理」应用并返回 app_id + app_secret，
 *   用户无需提前去开放平台创建应用。
 *
 * 参考: DeepSeek-GUI / OpenClaw 的飞书接入方式
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://open.feishu.cn/open-apis";
const AUTH_BASE = "https://accounts.feishu.cn";

// ---- 凭证存储 ----
function credPath(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "feishu-cred.json");
}
function loadCred(dataDir) {
  try { return JSON.parse(readFileSync(credPath(dataDir), "utf8")); } catch { return null; }
}
function saveCred(dataDir, cred) {
  writeFileSync(credPath(dataDir), JSON.stringify(cred));
}

// ---- Token 管理 ----
function tokenPath(dataDir) {
  return join(dataDir, "feishu-token.json");
}
function loadToken(dataDir) {
  try { return JSON.parse(readFileSync(tokenPath(dataDir), "utf8")); } catch { return null; }
}
function saveToken(dataDir, t) {
  writeFileSync(tokenPath(dataDir), JSON.stringify(t));
}

async function getTenantToken(appId, appSecret) {
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg}`);
  return data.tenant_access_token;
}

// ---- 设备授权流 ----
async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function bindFeishu(dataDir) {
  // 1. 初始化设备授权
  await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, { action: "init" });
  const data = await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id"
  });
  const url = data.verification_uri_complete;
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  if (!url || !deviceCode) {
    const msg = data.error_description || data.message || "飞书返回不完整";
    return { ok: false, message: msg };
  }

  console.log(`\n[飞书绑定] 请打开链接,用飞书扫码授权:\n  ${url}\n  用户码: ${userCode}\n  有效期: ${Math.round((data.expires_in || 300) / 60)} 分钟\n`);

  // 2. 轮询等待用户授权（最多5分钟）
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (data.interval || 5) * 1000));
    const poll = await postForm(`${AUTH_BASE}/oauth/v1/app/registration`, {
      action: "poll",
      device_code: deviceCode
    });
    if (poll.error === "authorization_pending" || poll.error === "slow_down") continue;
    if (poll.error) {
      return { ok: false, message: `授权失败: ${poll.error_description || poll.error}` };
    }
    if (poll.client_id && poll.client_secret) {
      const cred = {
        app_id: poll.client_id,
        app_secret: poll.client_secret,
        domain: poll.user_info?.tenant_brand === "lark" ? "lark" : "feishu",
        open_id: poll.user_info?.open_id || "",
        created_at: new Date().toISOString()
      };
      saveCred(dataDir, cred);
      console.log("[飞书绑定] ✅ 授权成功! 应用已自动创建");
      return { ok: true, message: "飞书已绑定，应用自动创建完成" };
    }
  }
  return { ok: false, message: "授权超时，请重新扫码" };
}

// ---- 导出到飞书多维表格 ----
function buildMultipart(fields, filePath) {
  const boundary = "----Boundary" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (filePath) {
    const buf = readFileSync(filePath);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

export async function exportToFeishu(db, dataDir) {
  const cred = loadCred(dataDir);
  if (!cred) {
    return { ok: false, needBind: true, message: "飞书未绑定，请先调 bind_feishu 扫码授权" };
  }
  const token = await getTenantToken(cred.app_id, cred.app_secret);
  const h = () => ({ "Authorization": `Bearer ${token}`, "Content-Type": "application/json" });

  // 1. 建多维表格
  const tRes = await fetch(`${BASE}/bitable/v1/apps`, {
    method: "POST", headers: h(),
    body: JSON.stringify({ name: `选品结果 ${new Date().toLocaleDateString("zh-CN")}` })
  });
  const tData = await tRes.json();
  if (tData.code !== 0) throw new Error(`建表失败: ${tData.msg}`);
  const { app_token: appToken, table_id: tableId } = tData.data.app;

  // 2. 加字段
  const fields = ["京东标题", "京东价格", "京东店铺", "京东截图", "淘宝价格", "利润金额", "利润率", "淘宝标题", "淘宝店铺", "发货地", "淘宝截图", "京东链接", "淘宝链接"];
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/batch_create`, {
    method: "POST", headers: h(),
    body: JSON.stringify({ fields: fields.map(f => ({ field_name: f, type: 1 })) })
  }).then(r => r.json());

  // 3. 读数据 + 上传图片
  const rows = db.prepare(`
    SELECT p.jd_title, p.jd_price, p.jd_shop, p.jd_url, p.jd_screenshot_path,
           t2.taobao_price, t2.profit_amount, t2.profit_rate, t2.taobao_title,
           t2.taobao_shop, t2.taobao_ship_from, t2.taobao_url, t2.taobao_screenshot_path
    FROM sourcing_products p
    JOIN sourcing_taobao_matches t2 ON p.jd_product_id = t2.jd_product_id
    ORDER BY t2.profit_rate DESC LIMIT 200
  `).all();

  const imgCache = new Map();
  for (const r of rows) {
    for (const p of [r.jd_screenshot_path, r.taobao_screenshot_path]) {
      if (p && !imgCache.has(p) && existsSync(p)) {
        try {
          const { body, boundary } = buildMultipart({ image_type: "message" }, p);
          const imgRes = await fetch(`${BASE}/im/v1/images`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body
          });
          const imgData = await imgRes.json();
          if (imgData.code === 0) imgCache.set(p, imgData.data.image_key);
        } catch (e) {}
      }
    }
  }

  // 4. 插行
  const records = rows.map(r => {
    const jdImg = r.jd_screenshot_path && imgCache.get(r.jd_screenshot_path);
    const tbImg = r.taobao_screenshot_path && imgCache.get(r.taobao_screenshot_path);
    return { fields: {
      "京东标题": r.jd_title || "", "京东价格": String(r.jd_price || ""),
      "京东店铺": r.jd_shop || "", "京东链接": r.jd_url || "",
      "京东截图": jdImg ? [{ image_key: jdImg, width: 300, height: 400 }] : [],
      "淘宝价格": String(r.taobao_price || ""), "利润金额": String(r.profit_amount || ""),
      "利润率": r.profit_rate ? (r.profit_rate * 100).toFixed(1) + "%" : "",
      "淘宝标题": r.taobao_title || "", "淘宝店铺": r.taobao_shop || "",
      "发货地": r.taobao_ship_from || "", "淘宝链接": r.taobao_url || "",
      "淘宝截图": tbImg ? [{ image_key: tbImg, width: 300, height: 400 }] : []
    }};
  });
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
    method: "POST", headers: h(), body: JSON.stringify({ records })
  }).then(r => r.json());

  return { ok: true, count: rows.length, url: `https://bytedance.feishu.cn/base/${appToken}` };
}

// ---- 发送消息给用户（Agent 主动通知）----
export async function sendFeishuMsg(dataDir, content) {
  const cred = loadCred(dataDir);
  if (!cred || !cred.open_id) {
    return { ok: false, message: "飞书未绑定或无 open_id，请先 bind_feishu" };
  }
  try {
    const token = await getTenantToken(cred.app_id, cred.app_secret);
    const body = {
      receive_id: cred.open_id,
      msg_type: "text",
      content: JSON.stringify({ text: content })
    };
    const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg);
    return { ok: true, message: "已发送" };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
