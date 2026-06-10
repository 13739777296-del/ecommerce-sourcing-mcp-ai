/**
 * 飞书集成：扫码授权 + 多维表格导出
 *
 * 绑定（一次性）：
 *   1. 去 https://open.feishu.cn/app 创建应用，拿到 App ID + App Secret
 *   2. 设置 MCP 环境变量: FEISHU_APP_ID / FEISHU_APP_SECRET
 *   3. 调 bind_feishu → 终端打印扫码链接 → 浏览器打开授权 → 完成
 *
 *   之后所有 Agent 调 export_feishu 直接导出，不需要重复绑定。
 *
 * 原理：
 *   - 本地临时 HTTP 服务器接收飞书回调 (code)
 *   - 拿 code 换 user_access_token + refresh_token
 *   - token 存到 dataDir/feishu-token.json，下次自动刷新
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";

// Node.js multipart form-data 构造（兼容旧版Node）
function buildMultipart(fields, filePath) {
  const boundary = "----FormBoundary" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (filePath) {
    const buf = readFileSync(filePath);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from(`\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

const BASE = "https://open.feishu.cn/open-apis";

// ---- token 管理 ----
function tokenPath(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "feishu-token.json");
}

function loadToken(dataDir) {
  try { return JSON.parse(readFileSync(tokenPath(dataDir), "utf8")); } catch { return null; }
}
function saveToken(dataDir, t) {
  writeFileSync(tokenPath(dataDir), JSON.stringify(t));
}

// ---- 获取有效 token（过期自动刷新）----
async function getAccessToken(appId, appSecret, dataDir) {
  const saved = loadToken(dataDir);
  // user_access_token 未过期直接复用
  if (saved?.user_token && saved.user_expires_at && Date.now() < saved.user_expires_at - 120000) {
    return saved.user_token;
  }
  // 有 refresh_token，刷新
  if (saved?.refresh_token) {
    const res = await fetch(`${BASE}/authen/v1/refresh_access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: saved.refresh_token,
        app_id: appId, app_secret: appSecret
      })
    });
    const data = await res.json();
    if (data.code === 0) {
      saved.user_token = data.data.access_token;
      saved.refresh_token = data.data.refresh_token;
      saved.user_expires_at = Date.now() + data.data.expires_in * 1000;
      saveToken(dataDir, saved);
      return saved.user_token;
    }
  }
  return null;
}

// ---- OAuth 扫码授权（本地服务器等回调）----
export async function bindFeishu(appId, appSecret, dataDir) {
  return new Promise((resolve, reject) => {
    const port = 8888 + randomInt(0, 1000);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=feishu-mcp&response_type=code&scope=bitable:app+im:image+doc:document`;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (!code) {
          res.end("授权失败：缺少 code");
          server.close();
          return reject(new Error("授权回调缺少 code"));
        }
        // 拿 code 换 token
        const tokenRes = await fetch(`${BASE}/authen/v1/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code, app_id: appId, app_secret: appSecret })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.code !== 0) {
          res.end(`换 token 失败: ${tokenData.msg}`);
          server.close();
          return reject(new Error(`换 token 失败: ${tokenData.msg}`));
        }
        const t = {
          user_token: tokenData.data.access_token,
          refresh_token: tokenData.data.refresh_token,
          user_expires_at: Date.now() + tokenData.data.expires_in * 1000
        };
        saveToken(dataDir, t);
        res.end(`<h2>✅ 授权成功！</h2><p>飞书已绑定，可以关闭此页面。token 有效期 ${(tokenData.data.expires_in / 3600).toFixed(1)} 小时，到期自动刷新。</p>`);
        server.close();
        resolve({ ok: true, message: "飞书已绑定，token 已保存" });
      } else {
        res.end("ok");
      }
    });

    server.listen(port, () => {
      console.log(`\n[飞书绑定] 请打开以下链接授权：\n  ${authUrl}\n`);
      console.log(`[飞书绑定] 等待扫码授权...（本地端口 ${port})`);
    });
    setTimeout(() => { server.close(); reject(new Error("授权超时（5分钟）")); }, 5 * 60 * 1000);
  });
}

// ---- 导出的鉴权入口 ----
function getAuth(dataDir) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return { needConfig: true };
  return { appId, appSecret, dataDir };
}

// ---- 导出到飞书多维表格 ----
export async function exportToFeishu(db, dataDir) {
  const auth = getAuth(dataDir);
  if (auth.needConfig) {
    return { ok: false, needConfig: true, guide: SETUP_GUIDE };
  }
  const { appId, appSecret } = auth;

  const token = await getAccessToken(appId, appSecret, dataDir);
  if (!token) {
    return { ok: false, needBind: true, message: "飞书未绑定，请先调 bind_feishu 扫码授权" };
  }

  const h = (t) => ({ "Authorization": `Bearer ${t}`, "Content-Type": "application/json" });

  // 1. 建表
  const tRes = await fetch(`${BASE}/bitable/v1/apps`, {
    method: "POST", headers: h(token),
    body: JSON.stringify({ name: `选品结果 ${new Date().toLocaleDateString("zh-CN")}` })
  });
  const tData = await tRes.json();
  if (tData.code !== 0) throw new Error(`建表失败: ${tData.msg}`);
  const { app_token: appToken, table_id: tableId } = tData.data.app;

  // 2. 加字段 (type: 1=文本)
  const fields = ["京东标题", "京东价格", "京东店铺", "京东截图", "淘宝价格", "利润金额", "利润率", "淘宝标题", "淘宝店铺", "发货地", "淘宝截图", "京东链接", "淘宝链接"];
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/batch_create`, {
    method: "POST", headers: h(token),
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
        } catch (e) { /* 单张失败不阻塞 */ }
      }
    }
  }

  // 4. 批量插行
  const records = rows.map((r) => {
    const jdImg = r.jd_screenshot_path && imgCache.get(r.jd_screenshot_path);
    const tbImg = r.taobao_screenshot_path && imgCache.get(r.taobao_screenshot_path);
    return {
      fields: {
        "京东标题": r.jd_title || "", "京东价格": String(r.jd_price || ""),
        "京东店铺": r.jd_shop || "", "京东链接": r.jd_url || "",
        "京东截图": jdImg ? [{ image_key: jdImg, width: 300, height: 400 }] : [],
        "淘宝价格": String(r.taobao_price || ""), "利润金额": String(r.profit_amount || ""),
        "利润率": r.profit_rate ? (r.profit_rate * 100).toFixed(1) + "%" : "",
        "淘宝标题": r.taobao_title || "", "淘宝店铺": r.taobao_shop || "",
        "发货地": r.taobao_ship_from || "", "淘宝链接": r.taobao_url || "",
        "淘宝截图": tbImg ? [{ image_key: tbImg, width: 300, height: 400 }] : []
      }
    };
  });
  await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
    method: "POST", headers: h(token),
    body: JSON.stringify({ records })
  }).then(r => r.json());

  return { ok: true, count: rows.length, url: `https://bytedance.feishu.cn/base/${appToken}` };
}

// ---- 配置引导 ----
const SETUP_GUIDE = {
  title: "飞书配置（1分钟）",
  steps: [
    "1. 去 https://open.feishu.cn/app 创建企业自建应用",
    "2. 安全设置 → 添加重定向 URL: http://127.0.0.1:8888/callback",
    "3. 权限管理 → 开通: 多维表格(bitable:app)、图片(im:image)、云文档(doc:document)",
    "4. 发布应用，复制 App ID 和 App Secret",
    "5. 配置环境变量: FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx",
    "6. 调 bind_feishu → 浏览器打开链接授权 → 完成"
  ],
  note: "只需配置一次。之后所有 Agent 直接调 export_feishu 导出，token 自动刷新。"
};
