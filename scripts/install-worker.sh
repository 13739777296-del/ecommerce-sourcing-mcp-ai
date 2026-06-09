#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${ECOMMERCE_SOURCING_PROJECT_DIR:-$HOME/开发/电商选品MCP}"
REPO_URL="${ECOMMERCE_SOURCING_REPO_URL:-https://github.com/13739777296-del/ecommerce-sourcing-mcp.git}"
SERVER_URL="${ECOMMERCE_SOURCING_MCP_SERVER_URL:-http://111.228.45.180/ecommerce-sourcing-mcp/mcp}"
WORKER_KEY="${ECOMMERCE_SOURCING_WORKER_KEY:-}"
DATA_DIR="${ECOMMERCE_SOURCING_DATA_DIR:-$HOME/.ecommerce-sourcing-agent}"
PLIST="$HOME/Library/LaunchAgents/com.ecommerce-sourcing-mcp.worker.plist"
LOG_OUT="$HOME/Library/Logs/ecommerce-sourcing-mcp-worker.log"
LOG_ERR="$HOME/Library/Logs/ecommerce-sourcing-mcp-worker.err.log"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "当前安装脚本只支持 macOS。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22.12 或更高版本。"
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node.js 版本过低：$("$NODE_BIN" -v)。需要 22.12 或更高版本。"
  exit 1
fi

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo "没有找到 /Applications/Google Chrome.app。请先安装正式 Google Chrome。"
  exit 1
fi

if [[ -z "$WORKER_KEY" ]]; then
  if [[ -r /dev/tty ]]; then
    read -r -s -p "请输入电商选品 MCP worker 密钥：" WORKER_KEY < /dev/tty
    printf "\n" > /dev/tty
  else
    echo "缺少 ECOMMERCE_SOURCING_WORKER_KEY。"
    echo "请用环境变量传入，或在可交互终端运行安装脚本。"
    exit 1
  fi
fi

if [[ -z "$WORKER_KEY" ]]; then
  echo "worker 密钥不能为空。"
  exit 1
fi

mkdir -p "$(dirname "$PROJECT_DIR")" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$DATA_DIR"

if [[ -d "$PROJECT_DIR/.git" ]]; then
  echo "更新项目：$PROJECT_DIR"
  git -C "$PROJECT_DIR" pull --ff-only
else
  echo "克隆项目：$REPO_URL -> $PROJECT_DIR"
  rm -rf "$PROJECT_DIR"
  git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
npm ci

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ecommerce-sourcing-mcp.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/mcp/local-worker.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ECOMMERCE_SOURCING_MCP_SERVER_URL</key>
    <string>$SERVER_URL</string>
    <key>ECOMMERCE_SOURCING_WORKER_KEY</key>
    <string>$WORKER_KEY</string>
    <key>ECOMMERCE_SOURCING_DATA_DIR</key>
    <string>$DATA_DIR</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_OUT</string>
  <key>StandardErrorPath</key>
  <string>$LOG_ERR</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.ecommerce-sourcing-mcp.worker"
launchctl kickstart -k "gui/$(id -u)/com.ecommerce-sourcing-mcp.worker"

echo "本机 worker 已启动。"
echo "项目目录：$PROJECT_DIR"
echo "数据目录：$DATA_DIR"
echo "服务配置：$PLIST"
echo "状态检查：curl ${SERVER_URL%/mcp}/health"
