/**
 * 飞书集成：多维表格(Bitable)导出
 *
 * 用户准备（一次性）：
 * 1. 去 https://open.feishu.cn/app 创建企业自建应用
 * 2. 权限管理 → 开通：多维表格(bitable)、图片(im:image)、云文档(doc)
 * 3. 拿到 App ID 和 App Secret
 * 4. MCP 环境变量: FEISHU_APP_ID / FEISHU_APP_SECRET
 *
 * API文档: https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview
 */

import { readFileSync } from "node:fs";

const BASE = "https://open.feishu.cn/open-apis";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getTenantToken(appId, appSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg} (code=${data.code})`);
  cachedToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + data.expire * 1000;
  return cachedToken;
}

function header(token) {
  return { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
}

/** 创建多维表格 */
async function createBitable(token, name) {
  const res = await fetch(`${BASE}/bitable/v1/apps`, {
    method: "POST",
    headers: header(token),
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`创建表格失败: ${data.msg}`);
  return data.data.app; // { app_token, name, url }
}

/** 给表格加字段 */
async function addFields(token, appToken, tableId, fields) {
  const res = await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/batch_create`, {
    method: "POST",
    headers: header(token),
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`加字段失败: ${data.msg}`);
  return data.data.fields;
}

/** 上传图片到飞书 */
async function uploadImage(token, filePath) {
  const buf = readFileSync(filePath);
  const boundary = "----FormBoundary" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const res = await fetch(`${BASE}/im/v1/images`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`上传图片失败: ${data.msg}`);
  return data.data.image_key;
}

/** 批量插入行（含图片单元格） */
async function addRows(token, appToken, tableId, rows) {
  const records = rows.map((r, i) => ({
    fields: Object.fromEntries(
      Object.entries(r).map(([k, v]) => {
        // 图片字段：上传后拿到的 image_key，嵌为飞书图片单元格
        if (v && typeof v === "object" && v.image_key) {
          return [k, [{ image_key: v.image_key, width: 300, height: 400 }]];
        }
        return [k, String(v ?? "")];
      })
    )
  }));
  const res = await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
    method: "POST",
    headers: header(token),
    body: JSON.stringify({ records })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`插入行失败: ${data.msg}`);
  return data.data.records.length;
}

/** 主入口：导出选品结果到飞书多维表格 */
export async function exportToFeishu(db, outputDir) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    return { ok: false, needConfig: true, guide: buildFeishuSetupGuide() };
  }

  const token = await getTenantToken(appId, appSecret);

  // 1. 建表
  const table = await createBitable(token, `选品结果 ${new Date().toLocaleDateString("zh-CN")}`);
  const tableId = table.table_id; // 默认第一个表

  // 2. 加字段
  const fields = [
    { field_name: "京东标题", type: 1 },      // 1=文本
    { field_name: "京东价格", type: 1 },
    { field_name: "京东店铺", type: 1 },
    { field_name: "京东截图", type: 1 },      // 先文本，插入时覆为图片
    { field_name: "淘宝价格", type: 1 },
    { field_name: "利润金额", type: 1 },
    { field_name: "利润率", type: 1 },
    { field_name: "淘宝标题", type: 1 },
    { field_name: "淘宝店铺", type: 1 },
    { field_name: "发货地", type: 1 },
    { field_name: "淘宝截图", type: 1 },
    { field_name: "京东链接", type: 1 },      // 飞书单元格可放链接
    { field_name: "淘宝链接", type: 1 }
  ];
  await addFields(token, table.app_token, tableId, fields);

  // 3. 从数据库读取选品结果，上传截图，插入行
  const results = db.prepare(`
    SELECT
      p.jd_title, p.jd_price, p.jd_shop, p.jd_url, p.jd_screenshot_path,
      t.taobao_price, t.profit_amount, t.profit_rate, t.taobao_title,
      t.taobao_shop, t.taobao_ship_from, t.taobao_url, t.taobao_screenshot_path
    FROM sourcing_products p
    JOIN sourcing_taobao_matches t ON p.jd_product_id = t.jd_product_id
    ORDER BY t.profit_rate DESC
    LIMIT 100
  `).all();

  // 先上传所有图片
  const imageCache = new Map();
  for (const r of results) {
    for (const p of [r.jd_screenshot_path, r.taobao_screenshot_path]) {
      if (p && !imageCache.has(p)) {
        try {
          const key = await uploadImage(token, p);
          imageCache.set(p, key);
        } catch (e) { /* 个别图片失败不阻塞 */ }
      }
    }
  }

  // 组装行数据
  const rows = results.map((r) => ({
    "京东标题": r.jd_title,
    "京东价格": r.jd_price,
    "京东店铺": r.jd_shop,
    "京东截图": r.jd_screenshot_path && imageCache.has(r.jd_screenshot_path)
      ? { image_key: imageCache.get(r.jd_screenshot_path) } : "",
    "淘宝价格": r.taobao_price,
    "利润金额": r.profit_amount,
    "利润率": r.profit_rate ? (r.profit_rate * 100).toFixed(1) + "%" : "",
    "淘宝标题": r.taobao_title,
    "淘宝店铺": r.taobao_shop,
    "发货地": r.taobao_ship_from,
    "淘宝截图": r.taobao_screenshot_path && imageCache.has(r.taobao_screenshot_path)
      ? { image_key: imageCache.get(r.taobao_screenshot_path) } : "",
    "京东链接": r.jd_url,
    "淘宝链接": r.taobao_url
  }));

  const count = await addRows(token, table.app_token, tableId, rows);

  return {
    ok: true,
    count,
    url: table.url || `https://bytedance.feishu.cn/base/${table.app_token}`,
    message: `已导出 ${count} 行到飞书多维表格: ${table.url || table.app_token}`
  };
}

function buildFeishuSetupGuide() {
  return {
    title: "飞书集成配置指南",
    steps: [
      "1. 去 https://open.feishu.cn/app 创建企业自建应用",
      "2. 权限管理 → 开通: 多维表格(bitable)、图片(im:image)、云文档(doc)",
      "3. 发布应用(仅企业内部可用即可)",
      "4. 设置环境变量: FEISHU_APP_ID=cli_xxx  FEISHU_APP_SECRET=xxx"
    ],
    example: `claude mcp add ecommerce-sourcing \\
  -e FEISHU_APP_ID=cli_xxx \\
  -e FEISHU_APP_SECRET=xxx \\
  -- node /path/to/mcp/server.mjs`
  };
}
