/**
 * 数据库结构设计
 *
 * 表1: sourcing_products (选品结果主表)
 * 表2: sourcing_taobao_matches (淘宝匹配明细表，一对多)
 */

export function initSourcingTables(db) {
  // 主表：选品结果
  db.exec(`
    CREATE TABLE IF NOT EXISTS sourcing_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- 京东商品信息
      jd_product_id TEXT NOT NULL,
      jd_title TEXT,
      jd_price REAL,
      jd_unit_price REAL,
      jd_unit TEXT,
      jd_sales TEXT,
      jd_comments TEXT,
      jd_shop TEXT,
      jd_shop_type TEXT,
      jd_brand TEXT,
      jd_sku_info TEXT,
      jd_url TEXT,
      jd_screenshot_path TEXT,

      -- 最佳淘宝匹配（冗余，方便查询）
      best_taobao_id TEXT,
      best_taobao_price REAL,
      best_taobao_unit_price REAL,

      -- 利润信息
      profit_amount REAL,
      profit_rate REAL,

      -- 状态
      status TEXT DEFAULT 'pending',  -- pending/approved/rejected
      strategy_id TEXT,

      -- 时间戳
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(jd_product_id)
    )
  `);

  // 明细表：淘宝匹配商品（一个京东品可能匹配多个淘宝）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sourcing_taobao_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- 关联京东商品
      jd_product_id TEXT NOT NULL,

      -- 淘宝商品信息
      taobao_product_id TEXT NOT NULL,
      taobao_title TEXT,
      taobao_price REAL,
      taobao_unit_price REAL,
      taobao_unit TEXT,
      taobao_sales TEXT,
      taobao_shop TEXT,
      taobao_ship_from TEXT,
      taobao_is_domestic INTEGER,  -- 0/1
      taobao_ship_hours INTEGER,
      taobao_url TEXT,
      taobao_screenshot_path TEXT,

      -- 利润
      profit_amount REAL,
      profit_rate REAL,

      -- 是否最佳匹配
      is_best INTEGER DEFAULT 0,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (jd_product_id) REFERENCES sourcing_products(jd_product_id),
      UNIQUE(jd_product_id, taobao_product_id)
    )
  `);

  // 索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sourcing_products_status ON sourcing_products(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sourcing_products_strategy ON sourcing_products(strategy_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_taobao_matches_jd ON sourcing_taobao_matches(jd_product_id)`);
}

/**
 * 保存选品结果
 */
export function saveSourcingResult(db, jdProduct, taobaoMatches, bestMatch, strategy) {
  // 容错：未指定bestMatch(或没带productId)时，自动取利润率最高的match当best。
  // 否则best_taobao_id为空，导出CSV时淘宝列会JOIN不上而全空。
  if (!bestMatch?.taobao?.productId && Array.isArray(taobaoMatches) && taobaoMatches.length) {
    bestMatch = [...taobaoMatches]
      .filter((m) => m?.taobao?.productId)
      .sort((a, b) => (b?.profit?.profitRate || 0) - (a?.profit?.profitRate || 0))[0] || bestMatch;
  }

  // 1. 保存京东商品
  const stmt1 = db.prepare(`
    INSERT OR REPLACE INTO sourcing_products (
      jd_product_id, jd_title, jd_price, jd_unit_price, jd_unit,
      jd_sales, jd_comments, jd_shop, jd_shop_type, jd_brand,
      jd_sku_info, jd_url, jd_screenshot_path,
      best_taobao_id, best_taobao_price, best_taobao_unit_price,
      profit_amount, profit_rate, strategy_id, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
  `);

  stmt1.run(
    jdProduct.productId,
    jdProduct.title,
    jdProduct.price,
    jdProduct.unitPrice,
    jdProduct.unit,
    jdProduct.sales,
    jdProduct.comments,
    jdProduct.shop,
    jdProduct.shopType,
    jdProduct.brand,
    jdProduct.skuInfo,
    jdProduct.url,
    jdProduct.screenshotPath || null,
    bestMatch?.taobao.productId || null,
    bestMatch?.taobao.price || null,
    bestMatch?.taobao.unitPrice || null,
    bestMatch?.profit.profitAmount || null,
    bestMatch?.profit.profitRate || null,
    strategy?.id || null
  );

  // 2. 保存所有淘宝匹配
  const stmt2 = db.prepare(`
    INSERT OR REPLACE INTO sourcing_taobao_matches (
      jd_product_id, taobao_product_id, taobao_title, taobao_price,
      taobao_unit_price, taobao_unit, taobao_sales, taobao_shop,
      taobao_ship_from, taobao_is_domestic, taobao_ship_hours,
      taobao_url, taobao_screenshot_path,
      profit_amount, profit_rate, is_best
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const match of taobaoMatches) {
    const isBest = match.taobao.productId === bestMatch?.taobao.productId ? 1 : 0;
    stmt2.run(
      jdProduct.productId,
      match.taobao.productId,
      match.taobao.title,
      match.taobao.price,
      match.taobao.unitPrice,
      match.taobao.unit,
      match.taobao.sales,
      match.taobao.shop,
      match.taobao.shipFrom,
      match.taobao.isDomestic ? 1 : 0,
      match.taobao.shipHours,
      match.taobao.url,
      match.taobao.screenshotPath || null,
      match.profit?.profitAmount || null,
      match.profit?.profitRate || null,
      isBest
    );
  }

  return jdProduct.productId;
}

/**
 * 导出为Excel（CSV格式）
 */
export function exportToExcel(db, outputPath) {
  // 一对多：每个京东品 × 每个匹配的淘宝货源 = 多行
  const results = db.prepare(`
    SELECT
      p.jd_product_id,
      p.jd_title,
      p.jd_price,
      p.jd_unit_price,
      p.jd_unit,
      p.jd_sales,
      p.jd_comments,
      p.jd_shop,
      p.jd_url,
      p.jd_screenshot_path,
      t.taobao_price,
      t.taobao_unit_price,
      t.profit_amount,
      t.profit_rate,
      t.taobao_title,
      t.taobao_shop,
      t.taobao_ship_from,
      t.taobao_url,
      t.taobao_screenshot_path,
      t.is_best,
      p.created_at
    FROM sourcing_products p
    JOIN sourcing_taobao_matches t ON p.jd_product_id = t.jd_product_id
    ORDER BY p.jd_product_id, t.profit_rate DESC
  `).all();

  // 生成CSV
  const headers = [
    '京东商品ID', '京东标题', '京东价格', '京东单价', '单位',
    '京东销量', '京东评论', '京东店铺', '京东链接', '京东截图',
    '淘宝价格', '淘宝单价', '利润金额', '利润率',
    '淘宝标题', '淘宝店铺', '发货地', '淘宝链接', '淘宝截图', '是否最佳', '创建时间'
  ];

  const rows = results.map(r => [
    r.jd_product_id,
    r.jd_title,
    r.jd_price,
    r.jd_unit_price,
    r.jd_unit,
    r.jd_sales,
    r.jd_comments,
    r.jd_shop,
    r.jd_url,
    r.jd_screenshot_path,
    r.taobao_price,
    r.taobao_unit_price,
    r.profit_amount,
    (r.profit_rate * 100).toFixed(2) + '%',
    r.taobao_title,
    r.taobao_shop,
    r.taobao_ship_from,
    r.taobao_url,
    r.taobao_screenshot_path,
    r.is_best ? '★最佳' : '',
    r.taobao_screenshot_path,
    r.created_at
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  require('fs').writeFileSync(outputPath, '﻿' + csv, 'utf8');  // UTF-8 BOM for Excel

  return { path: outputPath, count: results.length };
}
