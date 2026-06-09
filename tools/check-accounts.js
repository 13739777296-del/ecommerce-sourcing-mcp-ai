import { openSourcingDb } from "../lib/db.js";
import { probeAccountLoginStatus, profileSummary } from "../lib/accounts.js";

export const name = "check-accounts";
export const description = "检查旧项目京东/淘宝账号 profile 是否存在；可选打开正式 Chrome 做轻量登录态探测。";
export const parameters = {
  type: "object",
  properties: {
    platform: { type: "string", enum: ["jd", "taobao", "all"], description: "检查平台，默认 all。" },
    probeLogin: { type: "boolean", description: "是否打开 Chrome 轻量探测登录态，默认 false。" }
  }
};

export async function execute(input, ctx) {
  const db = openSourcingDb(ctx);
  try {
    let accounts = profileSummary(ctx, db);
    const platform = input?.platform && input.platform !== "all" ? input.platform : null;
    if (platform) accounts = accounts.filter((account) => account.platform === platform);

    if (input?.probeLogin) {
      for (const account of accounts.filter((item) => item.status !== "missing")) {
        const result = await probeAccountLoginStatus(account).catch((error) => ({
          status: "login_required",
          event: error instanceof Error ? error.message : String(error)
        }));
        db.updateAccount(account.id, result.status, result.event);
      }
      accounts = platform ? db.listAccounts(platform) : db.listAccounts();
    }

    const text = [
      "账号检查完成。",
      ...accounts.map((account) => `- ${account.displayName}（${account.platform === "jd" ? "京东" : "淘宝"}）：${statusText(account.status)}，${account.lastEvent}`)
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: { accounts, dbPath: db.dbPath }
    };
  } finally {
    db.close();
  }
}

function statusText(status) {
  if (status === "available") return "可用";
  if (status === "missing") return "未找到 profile";
  if (status === "paused") return "已暂停";
  if (status === "login_required") return "需要登录";
  if (status === "in_use") return "执行中";
  return status;
}
