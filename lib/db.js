import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { initSourcingTables, saveSourcingResult, exportToExcel } from "./sourcing-db.js";

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

  startRun(input) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO selection_runs
        (id, input_type, input_value, keyword, jd_url, status, jd_raw_count, jd_filtered_count, taobao_raw_count, taobao_filtered_count, eligible_count, strategy_profile_id, strategy_json, taobao_keywords_json, started_at)
      VALUES
        (@id, @inputType, @inputValue, @keyword, @jdUrl, 'running', 0, 0, 0, 0, 0, @strategyProfileId, @strategyJson, '[]', @startedAt)
    `).run({
      id,
      inputType: input.jdUrl ? "jd_url" : "keyword",
      inputValue: input.jdUrl || input.keyword,
      keyword: input.keyword || "",
      jdUrl: input.jdUrl || "",
      strategyProfileId: input.strategyProfileId || "",
      strategyJson: JSON.stringify(input.strategy || {}),
      startedAt: new Date().toISOString()
    });
    this.addLog(id, "info", `开始选品：${input.jdUrl || input.keyword}`);
    return id;
  }

  updateRun(id, patch) {
    const current = this.getRun(id);
    if (!current) return;
    this.db.prepare(`
      UPDATE selection_runs
      SET status = @status,
        jd_raw_count = @jdRawCount,
        jd_filtered_count = @jdFilteredCount,
        taobao_raw_count = @taobaoRawCount,
        taobao_filtered_count = @taobaoFilteredCount,
        eligible_count = @eligibleCount,
        completed_at = @completedAt
      WHERE id = @id
    `).run({
      id,
      status: patch.status ?? current.status,
      jdRawCount: patch.jdRawCount ?? current.jdRawCount,
      jdFilteredCount: patch.jdFilteredCount ?? current.jdFilteredCount,
      taobaoRawCount: patch.taobaoRawCount ?? current.taobaoRawCount,
      taobaoFilteredCount: patch.taobaoFilteredCount ?? current.taobaoFilteredCount,
      eligibleCount: patch.eligibleCount ?? current.eligibleCount,
      completedAt: patch.completedAt ?? current.completedAt
    });
  }

  saveCandidate(runId, product, status, reason) {
    this.db.prepare(`
      INSERT OR REPLACE INTO selection_candidates
        (id, run_id, platform, product_id, title, url, price, unit_price, sku_text, shop_name, status, reason, main_image_url, source_account_id, raw_json)
      VALUES
        (@id, @runId, @platform, @productId, @title, @url, @price, @unitPrice, @skuText, @shopName, @status, @reason, @mainImageUrl, @sourceAccountId, @rawJson)
    `).run({
      id: `${runId}:${product.platform}:${product.productId}`,
      runId,
      platform: product.platform,
      productId: product.productId,
      title: product.title,
      url: product.url,
      price: product.price,
      unitPrice: product.unitPrice,
      skuText: product.skuText,
      shopName: product.shopName || "",
      status,
      reason,
      mainImageUrl: product.mainImageUrl || "",
      sourceAccountId: product.sourceAccountId || "",
      rawJson: JSON.stringify(product)
    });
  }

  saveMatch(runId, match) {
    this.db.prepare(`
      INSERT OR REPLACE INTO matches
        (id, run_id, jd_product_id, taobao_product_id, status, profit_rate, profit_amount, listing_price, taobao_cost, reason)
      VALUES
        (@id, @runId, @jdProductId, @taobaoProductId, @status, @profitRate, @profitAmount, @listingPrice, @taobaoCost, @reason)
    `).run({
      id: `${runId}:${match.jdProductId}:${match.taobaoProductId}`,
      runId,
      ...match
    });
  }

  getRun(id) {
    return normalizeRun(this.db.prepare(`
      SELECT id, input_type AS inputType, input_value AS inputValue, keyword, jd_url AS jdUrl, status,
        jd_raw_count AS jdRawCount, jd_filtered_count AS jdFilteredCount,
        taobao_raw_count AS taobaoRawCount, taobao_filtered_count AS taobaoFilteredCount, eligible_count AS eligibleCount,
        strategy_profile_id AS strategyProfileId, strategy_json AS strategyJson, taobao_keywords_json AS taobaoKeywordsJson,
        started_at AS startedAt, completed_at AS completedAt
      FROM selection_runs WHERE id = ? LIMIT 1
    `).get(id) || null);
  }

  latestRun() {
    return normalizeRun(this.db.prepare(`
      SELECT id, input_type AS inputType, input_value AS inputValue, keyword, jd_url AS jdUrl, status,
        jd_raw_count AS jdRawCount, jd_filtered_count AS jdFilteredCount,
        taobao_raw_count AS taobaoRawCount, taobao_filtered_count AS taobaoFilteredCount, eligible_count AS eligibleCount,
        strategy_profile_id AS strategyProfileId, strategy_json AS strategyJson, taobao_keywords_json AS taobaoKeywordsJson,
        started_at AS startedAt, completed_at AS completedAt
      FROM selection_runs ORDER BY started_at DESC LIMIT 1
    `).get() || null);
  }

  listMatches(runId = null, limit = 50) {
    const where = runId ? "WHERE m.run_id = ?" : "";
    const params = runId ? [runId, limit] : [limit];
    return this.db.prepare(`
      SELECT m.id, m.run_id AS runId, m.status, m.profit_rate AS profitRate, m.profit_amount AS profitAmount,
        m.listing_price AS listingPrice, m.taobao_cost AS taobaoCost, m.reason,
        jd.title AS jdTitle, jd.url AS jdUrl, jd.price AS jdPrice, jd.unit_price AS jdUnitPrice, jd.sku_text AS jdSkuText,
        jd.main_image_url AS jdImage, jd.shop_name AS jdShopName,
        tb.title AS taobaoTitle, tb.url AS taobaoUrl, tb.price AS taobaoPrice, tb.unit_price AS taobaoUnitPrice,
        tb.sku_text AS taobaoSkuText, tb.main_image_url AS taobaoImage
      FROM matches m
      JOIN selection_candidates jd ON jd.run_id = m.run_id AND jd.product_id = m.jd_product_id AND jd.platform = 'jd'
      JOIN selection_candidates tb ON tb.run_id = m.run_id AND tb.product_id = m.taobao_product_id AND tb.platform = 'taobao'
      ${where}
      ORDER BY m.status = 'qualified' DESC, m.profit_amount DESC
      LIMIT ?
    `).all(...params);
  }

  listCandidates(runId = null, limit = 500) {
    const where = runId ? "WHERE run_id = ?" : "";
    const params = runId ? [runId, limit] : [limit];
    return this.db.prepare(`
      SELECT id, run_id AS runId, platform, product_id AS productId, title, url, price, unit_price AS unitPrice,
        sku_text AS skuText, shop_name AS shopName, status, reason, main_image_url AS mainImageUrl,
        source_account_id AS sourceAccountId
      FROM selection_candidates
      ${where}
      ORDER BY platform, status = 'passed' DESC, price ASC
      LIMIT ?
    `).all(...params);
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

  saveArtifact(runId, artifact) {
    const id = artifact.id || `${runId}:${artifact.platform || "run"}:${artifact.productId || "page"}:${artifact.artifactType}:${hashKey(artifact.filePath || artifact.sourceUrl || artifact.label || Date.now())}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO run_artifacts
        (id, run_id, platform, product_id, artifact_type, label, file_path, source_url, created_at)
      VALUES
        (@id, @runId, @platform, @productId, @artifactType, @label, @filePath, @sourceUrl, @createdAt)
    `).run({
      id,
      runId,
      platform: artifact.platform || "",
      productId: artifact.productId || "",
      artifactType: artifact.artifactType || "artifact",
      label: artifact.label || "",
      filePath: artifact.filePath || "",
      sourceUrl: artifact.sourceUrl || "",
      createdAt: artifact.createdAt || new Date().toISOString()
    });
    return id;
  }

  listArtifacts(runId = null) {
    const where = runId ? "WHERE run_id = ?" : "";
    const params = runId ? [runId] : [];
    return this.db.prepare(`
      SELECT id, run_id AS runId, platform, product_id AS productId, artifact_type AS artifactType,
        label, file_path AS filePath, source_url AS sourceUrl, created_at AS createdAt
      FROM run_artifacts
      ${where}
      ORDER BY created_at ASC
    `).all(...params);
  }

  appendRunTaobaoKeyword(runId, entry) {
    const run = this.getRun(runId);
    if (!run) return;
    const next = [
      ...(Array.isArray(run.taobaoKeywords) ? run.taobaoKeywords : []),
      {
        jdProductId: entry.jdProductId || "",
        jdTitle: entry.jdTitle || "",
        keyword: entry.keyword || "",
        createdAt: new Date().toISOString()
      }
    ];
    this.db.prepare("UPDATE selection_runs SET taobao_keywords_json = ? WHERE id = ?").run(JSON.stringify(next), runId);
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
    CREATE TABLE IF NOT EXISTS selection_runs (
      id TEXT PRIMARY KEY,
      input_type TEXT NOT NULL,
      input_value TEXT NOT NULL,
      keyword TEXT NOT NULL,
      jd_url TEXT NOT NULL,
      status TEXT NOT NULL,
      jd_raw_count INTEGER NOT NULL DEFAULT 0,
      jd_filtered_count INTEGER NOT NULL DEFAULT 0,
      taobao_raw_count INTEGER NOT NULL DEFAULT 0,
      taobao_filtered_count INTEGER NOT NULL DEFAULT 0,
      eligible_count INTEGER NOT NULL DEFAULT 0,
      strategy_profile_id TEXT NOT NULL DEFAULT '',
      strategy_json TEXT NOT NULL DEFAULT '{}',
      taobao_keywords_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS selection_candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      product_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      price REAL NOT NULL,
      unit_price REAL NOT NULL,
      sku_text TEXT NOT NULL,
      shop_name TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      main_image_url TEXT NOT NULL,
      source_account_id TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      jd_product_id TEXT NOT NULL,
      taobao_product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      profit_rate REAL NOT NULL,
      profit_amount REAL NOT NULL,
      listing_price REAL NOT NULL,
      taobao_cost REAL NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      product_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      label TEXT NOT NULL,
      file_path TEXT NOT NULL,
      source_url TEXT NOT NULL,
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
  ensureColumn(db, "selection_runs", "strategy_profile_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "selection_runs", "strategy_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "selection_runs", "taobao_keywords_json", "TEXT NOT NULL DEFAULT '[]'");

  // 选品结果表(京东品 + 一对多淘宝匹配 + 截图路径 + 比价利润)
  initSourcingTables(db);
}

function hashKey(value) {
  let hash = 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (columns.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    ...row,
    strategy: safeJson(row.strategyJson, {}),
    taobaoKeywords: safeJson(row.taobaoKeywordsJson, [])
  };
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
