#!/bin/bash

# 电商选品MCP-AI版 - 快速演示脚本

set -e

echo "================================"
echo "  电商选品MCP - AI驱动版"
echo "  快速演示"
echo "================================"
echo ""

# 1. 检查环境
echo "【步骤1】检查环境..."
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未安装 Node.js"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "✅ Node.js 版本: $NODE_VERSION"

# 2. 安装依赖（如果需要）
if [ ! -d "node_modules" ]; then
    echo ""
    echo "【步骤2】安装依赖..."
    npm install
else
    echo "✅ 依赖已安装"
fi

# 3. 运行AI选品测试
echo ""
echo "【步骤3】运行AI选品测试..."
echo "提示: 测试会打开Chrome浏览器，搜索京东商品"
echo ""

node tests/test-real-account.mjs

echo ""
echo "================================"
echo "  演示完成！"
echo "================================"
