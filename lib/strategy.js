import { DEFAULT_STRATEGY, sanitizeStrategy } from "./logic.js";

export const BUILTIN_STRATEGIES = Object.freeze([
  {
    id: "health-products",
    name: "保健品选品",
    description: "京东买手店+评论>=2，淘宝国内发货+48h内发货+已售>=10。单次任务目标200个去重商品。",
    builtin: true,
    strategy: {
      ...DEFAULT_STRATEGY,
      jdPages: 3,
      maxJdCandidates: 5,
      maxTaobaoSearches: 3,
      maxTaobaoKeywordAttempts: 2
    }
  },
  {
    id: "conservative",
    name: "稳健小量",
    description: "默认策略。每次只跑少量页面和候选，适合测试。",
    builtin: true,
    strategy: {
      ...DEFAULT_STRATEGY,
      jdPages: 1,
      maxJdCandidates: 1,
      maxTaobaoSearches: 1,
      maxTaobaoKeywordAttempts: 2
    }
  }
]);

export function ensureBuiltinStrategies(db) {
  for (const profile of BUILTIN_STRATEGIES) {
    db.upsertStrategyProfile(profile);
  }
  if (!db.getPreference("defaultStrategyId")) {
    db.setPreference("defaultStrategyId", "health-products");
  }
}

export function listStrategyProfiles(db) {
  ensureBuiltinStrategies(db);
  const profiles = db.listStrategyProfiles();
  const defaultStrategyId = db.getPreference("defaultStrategyId", "conservative");
  return profiles.map((profile) => ({
    ...profile,
    isDefault: profile.id === defaultStrategyId
  }));
}

export function setDefaultStrategyProfile(db, strategyId) {
  ensureBuiltinStrategies(db);
  const profile = db.getStrategyProfile(strategyId);
  if (!profile) throw new Error(`策略不存在：${strategyId}`);
  db.setPreference("defaultStrategyId", profile.id);
  return profile;
}

export function resolveStrategyProfile(db, input = {}, configStrategy = {}) {
  ensureBuiltinStrategies(db);
  const requestedId = String(input.strategyPreset || "").trim();
  const defaultId = db.getPreference("defaultStrategyId", "conservative");
  const profile =
    db.getStrategyProfile(requestedId || defaultId) ||
    db.getStrategyProfile("conservative") ||
    BUILTIN_STRATEGIES[0];
  const explicitOverrides = {
    ...removeUndefined(configStrategy || {}),
    ...removeUndefined(input.strategy || {}),
    ...removeUndefined({
      jdPages: input.jdPages,
      maxJdCandidates: input.maxJdCandidates,
      maxTaobaoSearches: input.maxTaobaoSearches,
      maxTaobaoKeywordAttempts: input.maxTaobaoKeywordAttempts
    })
  };
  const strategy = sanitizeStrategy({
    ...profile.strategy,
    ...explicitOverrides
  });
  return { profile, strategy };
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
