import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { initSourcingTables, saveSourcingResult, exportToExcel, queryDedupedQualifiedRows } from "./sourcing-db.js";

export function openSourcingDb(ctx) {
  const dataDir = ctx?.dataDir || join(process.cwd(), ".ecommerce-sourcing-data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "ecommerce-sourcing.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return new SourcingDb(dbPath, db);
}

export class SourcingDb {
  constructor(dbPath, db) {
    this.dbPath = dbPath;
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // 选品结果：保存(京东品+一对多淘宝匹配+截图路径+比价利润)
  saveSourcing(jdProduct, taobaoMatches, bestMatch, strategy) {
    return saveSourcingResult(this.db, jdProduct, taobaoMatches || [], bestMatch || null, strategy || null);
  }

  // 选品结果：导出CSV表格
  exportSourcing(outputPath) {
    return exportToExcel(this.db, outputPath);
  }

  addLog(runId, level, message) {
    this.db.prepare("INSERT INTO task_logs (id, run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), runId || null, level, message, new Date().toISOString());
  }

  upsertAccount(account) {
    this.db.prepare(`
      INSERT INTO accounts (id, platform, display_name, profile_dir, status, last_event, updated_at)
      VALUES (@id, @platform, @displayName, @profileDir, @status, @lastEvent, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        display_name = excluded.display_name,
        profile_dir = excluded.profile_dir,
        status = CASE
          WHEN excluded.status = 'missing' THEN excluded.status
          WHEN accounts.status = 'paused' THEN accounts.status
          ELSE excluded.status
        END,
        updated_at = excluded.updated_at
    `).run({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      profileDir: account.profileDir,
      status: account.status || "available",
      lastEvent: account.lastEvent || "旧 profile 已发现",
      updatedAt: new Date().toISOString()
    });
  }

  updateAccount(id, status, event) {
    this.db.prepare("UPDATE accounts SET status = ?, last_event = ?, updated_at = ? WHERE id = ?")
      .run(status, event, new Date().toISOString(), id);
  }

  // 仅刷新 updated_at（轮换用：标记"刚用过"，不改 status/last_event）
  touchAccount(id) {
    this.db.prepare("UPDATE accounts SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  deleteAccount(id) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  getAccount(id) {
    return this.db.prepare(`
      SELECT id, platform, display_name AS displayName, profile_dir AS profileDir, status, last_event AS lastEvent, updated_at AS updatedAt
      FROM accounts
      WHERE id = ?
      LIMIT 1
    `).get(id) || null;
  }

  listAccounts(platform = null) {
    const sql = `
      SELECT id, platform, display_name AS displayName, profile_dir AS profileDir, status, last_event AS lastEvent, updated_at AS updatedAt
      FROM accounts
      ${platform ? "WHERE platform = ?" : ""}
      ORDER BY platform, display_name
    `;
    return platform ? this.db.prepare(sql).all(platform) : this.db.prepare(sql).all();
  }

  listLogs(limit = 20, runId = null) {
    const where = runId ? "WHERE run_id = ?" : "";
    const params = runId ? [runId, limit] : [limit];
    return this.db.prepare(`
      SELECT id, run_id AS runId, level, message, created_at AS createdAt
      FROM task_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params).reverse();
  }

  listSourcingResults(limit = 50) {
    return this.db.prepare(`
      SELECT
        p.jd_product_id AS jdProductId,
        p.jd_title AS jdTitle,
        p.jd_price AS jdPrice,
        p.jd_unit_price AS jdUnitPrice,
        p.jd_unit AS jdUnit,
        p.jd_comments AS jdComments,
        p.jd_shop AS jdShop,
        p.jd_brand AS jdBrand,
        p.jd_sku_info AS jdSkuInfo,
        p.jd_url AS jdUrl,
        p.jd_screenshot_path AS jdScreenshotPath,
        p.best_taobao_id AS bestTaobaoId,
        p.profit_amount AS profitAmount,
        p.profit_rate AS profitRate,
        p.status,
        p.strategy_id AS strategyId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        COUNT(t.id) AS taobaoMatchCount
      FROM sourcing_products p
      LEFT JOIN sourcing_taobao_matches t ON p.jd_product_id = t.jd_product_id
      GROUP BY p.jd_product_id
      ORDER BY p.updated_at DESC
      LIMIT ?
    `).all(limit);
  }

  getSourcingResult(jdProductId) {
    return this.db.prepare(`
      SELECT
        p.jd_product_id AS jdProductId,
        p.jd_title AS jdTitle,
        p.jd_price AS jdPrice,
        p.jd_unit_price AS jdUnitPrice,
        p.jd_unit AS jdUnit,
        p.jd_sales AS jdSales,
        p.jd_comments AS jdComments,
        p.jd_shop AS jdShop,
        p.jd_shop_type AS jdShopType,
        p.jd_brand AS jdBrand,
        p.jd_sku_info AS jdSkuInfo,
        p.jd_url AS jdUrl,
        p.jd_screenshot_path AS jdScreenshotPath,
        p.best_taobao_id AS bestTaobaoId,
        p.profit_amount AS profitAmount,
        p.profit_rate AS profitRate,
        p.status,
        p.strategy_id AS strategyId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        COUNT(t.id) AS taobaoMatchCount
      FROM sourcing_products p
      LEFT JOIN sourcing_taobao_matches t ON p.jd_product_id = t.jd_product_id
      WHERE p.jd_product_id = ?
      GROUP BY p.jd_product_id
      LIMIT 1
    `).get(jdProductId) || null;
  }

  listDedupedQualifiedResults(profitRules = {}) {
    return queryDedupedQualifiedRows(this.db, profitRules);
  }

  upsertStrategyProfile(profile) {
    this.db.prepare(`
      INSERT INTO strategy_profiles (id, name, description, strategy_json, builtin, updated_at)
      VALUES (@id, @name, @description, @strategyJson, @builtin, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        strategy_json = excluded.strategy_json,
        builtin = excluded.builtin,
        updated_at = excluded.updated_at
    `).run({
      id: profile.id,
      name: profile.name,
      description: profile.description || "",
      strategyJson: JSON.stringify(profile.strategy || {}),
      builtin: profile.builtin ? 1 : 0,
      updatedAt: new Date().toISOString()
    });
  }

  listStrategyProfiles() {
    return this.db.prepare(`
      SELECT id, name, description, strategy_json AS strategyJson, builtin, updated_at AS updatedAt
      FROM strategy_profiles
      ORDER BY builtin DESC, id
    `).all().map(normalizeStrategyProfile);
  }

  getStrategyProfile(id) {
    return normalizeStrategyProfile(this.db.prepare(`
      SELECT id, name, description, strategy_json AS strategyJson, builtin, updated_at AS updatedAt
      FROM strategy_profiles WHERE id = ? LIMIT 1
    `).get(id) || null);
  }

  getPreference(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json AS valueJson FROM agent_preferences WHERE key = ? LIMIT 1").get(key);
    if (!row) return fallback;
    return safeJson(row.valueJson, fallback);
  }

  setPreference(key, value) {
    this.db.prepare(`
      INSERT INTO agent_preferences (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      display_name TEXT NOT NULL,
      profile_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      last_event TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      strategy_json TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_preferences (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 选品结果表(京东品 + 一对多淘宝匹配 + 截图路径 + 比价利润)
  initSourcingTables(db);
}

function normalizeStrategyProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    strategy: safeJson(row.strategyJson, {}),
    builtin: Boolean(row.builtin),
    updatedAt: row.updatedAt
  };
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}
