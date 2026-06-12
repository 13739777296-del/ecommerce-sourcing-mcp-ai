export function installScriptUrl() {
  const base = String(process.env.ECOMMERCE_SOURCING_PUBLIC_BASE_URL || "http://111.228.45.180/ecommerce-sourcing-mcp").replace(/\/$/, "");
  return `${base}/install.sh`;
}

export function buildWorkerInstallCommand() {
  return `curl -fsSL ${installScriptUrl()} | bash`;
}

export function buildBootstrapGuide() {
  const command = buildWorkerInstallCommand();
  return [
    "# 电商选品 MCP 本机 worker 初始化",
    "",
    "本机 worker 是必须的：服务器 MCP 只负责转发任务，真正打开京东/淘宝的是用户电脑上的正式 Chrome。",
    "",
    "Agent 遇到新电脑、新用户或 `worker.connected=false` 时，要先询问用户选择哪种初始化方式：",
    "",
    "## 方案 A：一条安装命令",
    "",
    "适合普通用户。让用户复制并运行：",
    "",
    "```bash",
    command,
    "```",
    "",
    "脚本不会公开携带 worker 密钥。运行时会在终端提示用户输入 worker key。",
    "",
    "",
    "脚本会在本机完成这些事：",
    "",
    "- 检查 macOS、Node.js 和 Google Chrome。",
    "- 克隆或更新 GitHub 项目。",
    "- 安装依赖。",
    "- 写入 `~/Library/LaunchAgents/com.ecommerce-sourcing-mcp.worker.plist`。",
    "- 启动本机 worker。",
    "- 检查服务器 health。",
    "",
    "## 方案 B：让 Claude Code / Agent 本机自动安装",
    "",
    "适合 Agent 有本机终端权限的场景。Agent 可以执行与脚本等价的步骤：",
    "",
    "1. 克隆或更新 `https://github.com/13739777296-del/ecommerce-sourcing-mcp-ai.git`。",
    "2. 在项目目录运行 `npm ci`。",
    "3. 写入 macOS LaunchAgent。",
    "4. 询问用户提供 worker key，设置 `ECOMMERCE_SOURCING_MCP_SERVER_URL`、`ECOMMERCE_SOURCING_WORKER_KEY`、`ECOMMERCE_SOURCING_DATA_DIR`。",
    "5. `launchctl bootstrap` 和 `launchctl kickstart` 启动 worker。",
    "6. 调用服务器 `/health`，确认 `worker.connected=true`。",
    "",
    "## 初始化后",
    "",
    "所有能力都走同一个 MCP 工具 `ecommerce_sourcing`：",
    "",
    "1. 调用 `ecommerce_sourcing({ action: \"warmup\" })` 查看账号池。",
    "2. 没账号就调用 `ecommerce_sourcing({ action: \"account_add\", platform: \"jd\", displayName: \"京东账号一\" })`。",
    "3. 调用 `ecommerce_sourcing({ action: \"account_login\", accountId: \"...\" })` 打开本机 Chrome 登录页。",
    "4. 用户登录后调用 `ecommerce_sourcing({ action: \"account_check\", accountId: \"...\" })`。",
    "5. 账号可用后按 `jd_harvest` → Agent 提取品牌+核心品名 → `taobao_harvest` → Agent 同款和利润复核 → `save_sourcing` → `sourcing_list` → `export_results` / `export_feishu` 执行。"
  ].join("\n");
}
