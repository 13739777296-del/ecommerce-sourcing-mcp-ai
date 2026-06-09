import { existsSync, mkdirSync } from "node:fs";
import { openSourcingDb } from "../lib/db.js";
import {
  accountLoginUrl,
  createAccount,
  normalizePlatform,
  probeAccountLoginStatus,
  profileSummary,
  removeAccount,
  setAccountStatus
} from "../lib/accounts.js";
import { openChromeLoginWindow } from "../lib/chrome.js";

export const name = "accounts";
export const description = "账号池管理工具：在同一个电商选品 MCP 内新增、查看、启用、停用、删除京东/淘宝账号，并打开本机正式 Chrome 登录页。";
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "add", "open_login", "check", "enable", "disable", "remove"],
      description: "动作：list 查看账号池；add 新增账号；open_login 打开登录页；check 检测登录态；enable 启用；disable 停用；remove 删除账号记录。默认 list。"
    },
    platform: {
      type: "string",
      enum: ["jd", "taobao"],
      description: "平台：jd 京东，taobao 淘宝。add 时必填；list/check 可选。"
    },
    accountId: {
      type: "string",
      description: "账号 ID。open_login、enable、disable、remove 针对某个账号时使用。"
    },
    displayName: {
      type: "string",
      description: "新增账号名称，例如 京东账号三、淘宝账号二。"
    },
    profileDir: {
      type: "string",
      description: "可选，自定义 Chrome profile 目录。不填则自动放在本机数据目录下。"
    },
    probeLogin: {
      type: "boolean",
      description: "check 时是否打开本机 Chrome 探测登录态，默认 false。"
    }
  }
};

export async function execute(input = {}, ctx) {
  const db = openSourcingDb(ctx);
  try {
    const action = String(input.action || "list").trim();
    if (action === "add") return addAccount(ctx, db, input);
    if (action === "open_login") return openLogin(ctx, db, input);
    if (action === "check") return checkAccounts(ctx, db, input);
    if (action === "enable") return updateAccountStatus(db, input.accountId, "available");
    if (action === "disable") return updateAccountStatus(db, input.accountId, "paused");
    if (action === "remove") return deleteAccount(db, input.accountId);
    return listAccounts(ctx, db, input.platform || null);
  } finally {
    db.close();
  }
}

function addAccount(ctx, db, input) {
  const account = createAccount(ctx, db, input);
  mkdirSync(account.profileDir, { recursive: true });
  return {
    content: [{
      type: "text",
      text: [
        "账号已新增。",
        `账号：${account.displayName}`,
        `平台：${platformText(account.platform)}`,
        `状态：${statusText(account.status)}`,
        `profile：${account.profileDir}`,
        "下一步：调用 open_login 打开登录页，扫码登录后再调用 check。"
      ].join("\n")
    }],
    details: { account }
  };
}

function openLogin(ctx, db, input) {
  profileSummary(ctx, db);
  const account = findAccount(db, input);
  if (account.status === "paused") {
    throw new Error("账号已停用，请先 enable 后再打开登录页。");
  }
  mkdirSync(account.profileDir, { recursive: true });
  const loginUrl = accountLoginUrl(account.platform);
  openChromeLoginWindow(account.profileDir, loginUrl);
  db.updateAccount(account.id, "login_required", "已打开本机 Chrome 登录页，请扫码或完成网页登录。");
  const updated = db.getAccount(account.id);
  return {
    content: [{
      type: "text",
      text: [
        "已打开登录页。",
        `账号：${updated.displayName}`,
        `平台：${platformText(updated.platform)}`,
        `登录页：${loginUrl}`,
        "请在弹出的本机正式 Chrome 窗口里完成登录，然后调用 check 检测。"
      ].join("\n")
    }],
    details: { account: updated, loginUrl }
  };
}

async function checkAccounts(ctx, db, input) {
  let accounts = profileSummary(ctx, db);
  if (input.platform) {
    const platform = normalizePlatform(input.platform);
    accounts = accounts.filter((account) => account.platform === platform);
  }
  if (input.accountId) {
    accounts = accounts.filter((account) => account.id === input.accountId);
  }
  if (input.accountId && accounts.length === 0) {
    throw new Error(`账号不存在：${input.accountId}`);
  }

  if (input.probeLogin) {
    for (const account of accounts.filter((item) => item.status !== "missing")) {
      const result = await probeAccountLoginStatus(account).catch((error) => ({
        status: "login_required",
        event: error instanceof Error ? error.message : String(error)
      }));
      db.updateAccount(account.id, result.status, result.event);
    }
    accounts = accounts.map((account) => db.getAccount(account.id)).filter(Boolean);
  } else {
    for (const account of accounts) {
      if (!existsSync(account.profileDir) && account.status !== "missing") {
        db.updateAccount(account.id, "missing", "profile 目录不存在");
      }
    }
    accounts = accounts.map((account) => db.getAccount(account.id)).filter(Boolean);
  }

  return formatAccountList("账号检查完成。", accounts, db.dbPath);
}

function updateAccountStatus(db, accountId, status) {
  if (!accountId) throw new Error("该动作需要 accountId。");
  const account = setAccountStatus(db, accountId, status);
  return {
    content: [{
      type: "text",
      text: `账号状态已更新：${account.displayName} -> ${statusText(account.status)}`
    }],
    details: { account }
  };
}

function deleteAccount(db, accountId) {
  if (!accountId) throw new Error("remove 动作需要 accountId。");
  const account = removeAccount(db, accountId);
  return {
    content: [{
      type: "text",
      text: [
        "账号记录已删除。",
        `账号：${account.displayName}`,
        `profile 目录未自动删除：${account.profileDir}`
      ].join("\n")
    }],
    details: { removed: account }
  };
}

function listAccounts(ctx, db, platform = null) {
  let accounts = profileSummary(ctx, db);
  if (platform) {
    const normalized = normalizePlatform(platform);
    accounts = accounts.filter((account) => account.platform === normalized);
  }
  return formatAccountList("账号池列表。", accounts, db.dbPath);
}

function findAccount(db, input) {
  if (input.accountId) {
    const account = db.getAccount(input.accountId);
    if (!account) throw new Error(`账号不存在：${input.accountId}`);
    return account;
  }
  const platform = normalizePlatform(input.platform);
  const account = db.listAccounts(platform)[0];
  if (!account) throw new Error(`没有 ${platformText(platform)} 账号，请先 add。`);
  return account;
}

function formatAccountList(title, accounts, dbPath) {
  const text = [
    title,
    `数据库：${dbPath}`,
    ...accounts.map((account) => [
      `- ${account.displayName}（${platformText(account.platform)}）`,
      `ID=${account.id}`,
      `状态=${statusText(account.status)}`,
      `profile=${account.profileDir}`,
      `最近事件=${account.lastEvent || ""}`
    ].join("；"))
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { accounts, dbPath }
  };
}

function platformText(platform) {
  return platform === "jd" ? "京东" : "淘宝";
}

function statusText(status) {
  if (status === "available") return "可用";
  if (status === "missing") return "未找到 profile";
  if (status === "paused") return "已停用";
  if (status === "login_required") return "需要登录";
  if (status === "in_use") return "执行中";
  return status || "未知";
}
