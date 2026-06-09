import { openSourcingDb } from "../lib/db.js";
import { listStrategyProfiles, setDefaultStrategyProfile } from "../lib/strategy.js";

export const name = "strategy-library";
export const description = "查看或设置电商选品策略库。策略决定京东页数、候选数、淘宝搜索次数、评论/销量和发货规则。";
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "set-default"],
      description: "list 查看策略库；set-default 设置默认策略。"
    },
    strategyId: {
      type: "string",
      description: "设置默认策略时传入，例如 conservative、compare-more、strict-profit。"
    }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const action = input?.action || "list";
    if (action === "set-default") {
      const profile = setDefaultStrategyProfile(db, String(input?.strategyId || ""));
      const profiles = listStrategyProfiles(db);
      return {
        content: [{
          type: "text",
          text: `默认策略已设置为：${profile.name}（${profile.id}）。\n\n${formatStrategies(profiles)}`
        }],
        details: { defaultStrategyId: profile.id, profiles }
      };
    }
    const profiles = listStrategyProfiles(db);
    return {
      content: [{ type: "text", text: `电商选品策略库：\n\n${formatStrategies(profiles)}` }],
      details: { profiles, defaultStrategyId: profiles.find((item) => item.isDefault)?.id || "conservative" }
    };
  } finally {
    db.close();
  }
}

function formatStrategies(profiles) {
  return profiles.map((profile) => [
    `- ${profile.isDefault ? "默认 " : ""}${profile.name}（${profile.id}）`,
    `  ${profile.description}`,
    `  京东 ${profile.strategy.jdPages} 页，京东候选 ${profile.strategy.maxJdCandidates} 个，淘宝逐品 ${profile.strategy.maxTaobaoSearches} 个，关键词尝试 ${profile.strategy.maxTaobaoKeywordAttempts} 组，京东评论 >= ${profile.strategy.minJdComments}，淘宝销量 >= ${profile.strategy.minTaobaoSales}。`
  ].join("\n")).join("\n");
}
