/**
 * MCP工具：通用策略库
 *
 * 让任何Agent可以：
 * - 列出所有策略
 * - 创建/更新自己的策略
 * - 用策略来选品
 *
 * 这是商业化的关键：核心引擎通用，规则全开放。
 */

import { DEFAULT_STRATEGIES } from "../lib/strategy-engine.js";

export const description = "通用策略库管理。Agent可以创建、查看、修改自己的选品策略。策略包含：店铺类型筛选、销量价格区间、标题关键词、利润率要求等。一套引擎适配任意场景。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "get", "save", "delete", "templates"],
      description: "操作: list=列出策略, get=查看策略详情, save=保存/更新策略, delete=删除策略, templates=查看内置模板"
    },
    strategyId: {
      type: "string",
      description: "策略ID（get/save/delete时使用）"
    },
    strategy: {
      type: "object",
      description: "策略JSON对象（save时使用）。结构见: lib/strategy-engine.js"
    }
  },
  required: ["action"]
};

export async function handler(ctx, db, input) {
  const action = input.action;

  try {
    if (action === "templates") {
      return {
        ok: true,
        action,
        templates: Object.values(DEFAULT_STRATEGIES),
        message: `内置 ${Object.keys(DEFAULT_STRATEGIES).length} 个策略模板，可作为起点。修改后用 save 保存。`
      };
    }

    if (action === "list") {
      const strategies = listStrategies(db);
      return {
        ok: true,
        action,
        count: strategies.length,
        strategies,
        message: `共 ${strategies.length} 个策略`
      };
    }

    if (action === "get") {
      if (!input.strategyId) {
        return { ok: false, message: "缺少 strategyId" };
      }
      const strategy = getStrategy(db, input.strategyId);
      if (!strategy) {
        return { ok: false, message: `策略不存在: ${input.strategyId}` };
      }
      return { ok: true, action, strategy };
    }

    if (action === "save") {
      if (!input.strategy) {
        return { ok: false, message: "缺少 strategy 对象" };
      }
      const saved = saveStrategy(db, input.strategy);
      return {
        ok: true,
        action,
        strategy: saved,
        message: `策略已保存: ${saved.id}`
      };
    }

    if (action === "delete") {
      if (!input.strategyId) {
        return { ok: false, message: "缺少 strategyId" };
      }
      deleteStrategy(db, input.strategyId);
      return {
        ok: true,
        action,
        message: `策略已删除: ${input.strategyId}`
      };
    }

    return { ok: false, message: `未知操作: ${action}` };

  } catch (error) {
    return {
      ok: false,
      action,
      error: error.message,
      message: `策略库操作失败: ${error.message}`
    };
  }
}

// ===== 策略库存储（用现有DB） =====

function listStrategies(db) {
  // 复用原有的 strategy_profiles 表（如果有），否则用 KV
  try {
    const stmt = db.db?.prepare?.("SELECT id, name, description, payload FROM strategy_profiles");
    if (stmt) {
      const rows = stmt.all();
      const customs = rows.map(r => {
        try {
          return { id: r.id, name: r.name, description: r.description, ...JSON.parse(r.payload) };
        } catch {
          return { id: r.id, name: r.name, description: r.description };
        }
      });
      // 加上内置模板
      return [...Object.values(DEFAULT_STRATEGIES), ...customs];
    }
  } catch {}

  return Object.values(DEFAULT_STRATEGIES);
}

function getStrategy(db, id) {
  if (DEFAULT_STRATEGIES[id]) return DEFAULT_STRATEGIES[id];

  try {
    const stmt = db.db?.prepare?.("SELECT id, name, description, payload FROM strategy_profiles WHERE id=?");
    if (stmt) {
      const row = stmt.get(id);
      if (row) {
        try {
          return { id: row.id, name: row.name, description: row.description, ...JSON.parse(row.payload) };
        } catch {
          return null;
        }
      }
    }
  } catch {}

  return null;
}

function saveStrategy(db, strategy) {
  if (!strategy.id) {
    throw new Error("策略必须包含 id");
  }

  // 确保表存在
  try {
    db.db?.exec?.(`
      CREATE TABLE IF NOT EXISTS strategy_profiles (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        payload TEXT,
        updated_at TEXT
      )
    `);

    const payload = JSON.stringify(strategy);
    const stmt = db.db?.prepare?.(`
      INSERT INTO strategy_profiles (id, name, description, payload, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        description=excluded.description,
        payload=excluded.payload,
        updated_at=excluded.updated_at
    `);
    stmt.run(strategy.id, strategy.name || '', strategy.description || '', payload, new Date().toISOString());
  } catch (e) {
    console.error("保存策略失败:", e.message);
    throw e;
  }

  return strategy;
}

function deleteStrategy(db, id) {
  if (DEFAULT_STRATEGIES[id]) {
    throw new Error("内置策略不可删除，可以创建同id的策略覆盖");
  }
  try {
    db.db?.prepare?.("DELETE FROM strategy_profiles WHERE id=?").run(id);
  } catch (e) {
    console.error("删除策略失败:", e.message);
  }
}
