# 电商选品 MCP - AI驱动版（通用引擎+策略库）

> 一套通用的AI驱动选品引擎，配合可定制的策略库，适配任意电商场景。

## 核心理念

**引擎通用，策略可配。** 不限定使用场景，Agent传入自己的策略即可。

| 适用场景 | 策略示例 |
|---------|---------|
| 无货源套利（搬店铺） | 京东只要买手店 + 利润率35-60% |
| 品牌方比价 | 只要旗舰店 + 销量>1000 |
| 低价猎人 | 价格<99 + 销量>1万 |
| 自定义场景 | 完全自定义策略 JSON |

## 关键技术

### 1. AI驱动的浏览器（绕过反爬）

- ✅ **使用正式Chrome**（不是开源Chromium，不会被检测）
- ✅ **使用用户已登录的Cookie**（不重复登录）
- ✅ **模拟人类操作**：随机停顿、打字速度、滚动轨迹、hover再点击
- ✅ **真实操作搜索框**（不构造URL，避免被识别）
- ✅ **点击商品图片进详情**（不直接跳转URL）

### 2. 智能DOM解析（自适应改版）

不依赖固定class名（京东都是动态哈希了），用以下方式：
- `data-sku` 属性提取商品ID
- `innerText` 智能解析标题、价格、销量
- 关键词模式识别（"已售XX+"、"¥XXX"等）

### 3. 通用策略引擎

```javascript
{
  "id": "no-source-arbitrage",
  "name": "无货源套利",
  "platforms": {
    "jd": {
      "shopTypes": {
        "include": ["buyer"],          // 只要买手店
        "exclude": ["flagship", "overseas"]
      },
      "minSales": 2,
      "priceRange": [10, 9999]
    },
    "taobao": {
      "shipFrom": "domestic",          // 国内发货
      "shipWithinHours": 48,           // 48小时
      "minSales": 10
    }
  },
  "profit": {
    "minRate": 0.35,
    "maxRate": 0.60
  }
}
```

## MCP 工具

### 1. `ecommerce_sourcing_strategy` - 策略库管理

```
action: list      # 列出所有策略
action: get       # 查看策略详情
action: save      # 保存自定义策略
action: delete    # 删除策略
action: templates # 查看内置模板
```

### 2. `ecommerce_sourcing_ai_select` - AI选品

```
action: search             # 真实操作搜索框搜索
action: extract            # 提取商品列表
action: detail             # 模拟人类点击进详情页
action: search_and_filter  # 搜索 + 按策略筛选（推荐）
action: close              # 关闭浏览器
```

## 使用示例

### Agent 自然语言调用

```
用户: 帮我选辅酶Q10，要无货源能搬的款
Agent:
  1. ecommerce_sourcing_strategy(action=templates) → 看模板
  2. ecommerce_sourcing_ai_select(
       action=search_and_filter,
       keyword=辅酶Q10,
       strategyId=no-source-arbitrage
     )
  3. 返回筛选后的买手店商品
```

### 自定义策略

```javascript
ecommerce_sourcing_strategy({
  action: "save",
  strategy: {
    id: "my-strategy",
    name: "我的策略",
    platforms: {
      jd: {
        shopTypes: { include: ["buyer"], exclude: [] },
        minSales: 5,
        priceRange: [50, 500]
      }
    },
    profit: { minRate: 0.4, maxRate: 0.7 }
  }
})
```

## 部署

### 本地使用（Claude Code）

```bash
claude mcp add ecommerce-sourcing-ai \
  -e ECOMMERCE_SOURCING_DATA_DIR=$HOME/.ecommerce-sourcing-agent \
  -- node /path/to/电商选品MCP-AI版/mcp/server.mjs
```

### 服务器部署（多用户）

服务器（HTTP MCP Gateway）：
```bash
export ECOMMERCE_SOURCING_USERS='[{"id":"user1","apiKey":"...","workerKey":"..."}]'
export ECOMMERCE_SOURCING_EXECUTION_MODE=worker
node mcp/http-server.mjs
```

用户本地（Worker，调用本地Chrome）：
```bash
export ECOMMERCE_SOURCING_MCP_SERVER_URL=http://server-ip/mcp
export ECOMMERCE_SOURCING_WORKER_KEY=...
node mcp/local-worker.mjs
```

## 安全边界

- 不绕过验证码（遇到暂停）
- 不破解反爬（被风控就停止）
- 不上传Cookie（只在本地使用）
- 多用户隔离（各用各的账号）

## 测试

```bash
node tests/test-real-account.mjs   # 单步测试
node tests/test-full-flow.mjs       # 完整流程
node tests/test-strategy.mjs        # 策略引擎
```

## 商业化

这是核心的商业模式：
- **核心引擎免费/开源**
- **策略库 + 服务器 + 多账号管理 = 收费服务**
- 用户给Agent装MCP，Agent调用工具，按用量计费

## License

MIT
