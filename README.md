# 电商选品MCP - AI驱动（All-in-One）

> 一个MCP工具，搞定所有电商选品场景。京东→淘宝→比价→输出可用品。

## 核心能力

**一条指令，端到端自动化：**
```
ecommerce_sourcing({ 
  action: "full_selection",
  keyword: "辅酶Q10",
  strategyId: "no-source-arbitrage"
})
```

自动完成：
1. 京东搜索 + 提取列表
2. 按策略筛选（店铺类型/销量/价格）
3. 进入详情页提取SKU/评论/品牌
4. 计算最小规格单价（每片/每克/每毫升）
5. 淘宝以图搜图
6. 提取淘宝供货 + 筛选（发货地/发货时效/已售）
7. 比价 + 计算利润率
8. 输出符合条件的可用品

## 一个MCP，所有功能

| Action | 用途 |
|--------|------|
| **策略库** | |
| `strategy_templates` | 查看内置策略模板 |
| `strategy_list` | 列出所有策略 |
| `strategy_get` | 查看策略详情 |
| **京东** | |
| `jd_search` | 搜索 |
| `jd_extract` | 提取列表 |
| `jd_detail` | 提取详情（模拟人类点击） |
| `jd_search_filter` | 搜索+按策略筛选 |
| **淘宝** | |
| `taobao_search` | 关键词搜索 |
| `taobao_search_image` | 以图搜图（推荐） |
| `taobao_extract` | 提取列表 |
| **完整自动化** | |
| `full_selection` | 单个关键词完整选品 |
| `batch_selection` | 批量关键词（目标500个品） |
| `close` | 关闭浏览器 |

## 内置策略

### 1. 无货源套利（默认）
```json
{
  "id": "no-source-arbitrage",
  "platforms": {
    "jd": {
      "shopTypes": { "include": ["buyer"] },  // 只要买手店
      "minSales": 2
    },
    "taobao": {
      "shipFrom": "domestic",    // 国内发货
      "shipWithinHours": 48,     // 48小时内
      "minSales": 10
    }
  },
  "profit": {
    "minRate": 0.35,  // 35%
    "maxRate": 0.60   // 60%
  }
}
```

### 2. 品牌优品
只要旗舰店/海外店，高销量高质量

### 3. 低价猎手
超低价高销量商品

## 技术亮点

### AI绕过反爬
- ✅ 正式Chrome（不是Chromium）
- ✅ 用户已登录Cookie
- ✅ 模拟人类：随机停顿/打字速度/滚动/hover
- ✅ 真实操作搜索框（不构造URL）
- ✅ 点击商品图片进详情（不直跳）

### 智能DOM解析
- 不依赖固定class（适应动态哈希）
- innerText智能解析（标题/价格/销量）
- 自适应京东/淘宝改版

### 最小规格单价
自动识别：粒/片/克/毫克/升/毫升
```
"60粒 ¥100" → 每粒 ¥1.67
"500g ¥50" → 每克 ¥0.1
```

## 使用示例

### Agent调用（Claude Code）

```typescript
// 1. 完整选品（单个关键词）
ecommerce_sourcing({
  action: "full_selection",
  keyword: "辅酶Q10",
  strategyId: "no-source-arbitrage",
  maxJdCandidates: 10,
  maxTaobaoCandidatesPerJd: 10
})

// 2. 批量选品（目标500个品）
ecommerce_sourcing({
  action: "batch_selection",
  keywords: ["辅酶Q10", "鱼油", "维生素D", ...],
  strategyId: "no-source-arbitrage",
  targetCount: 500
})

// 3. 单步操作（调试用）
ecommerce_sourcing({ action: "jd_search_filter", keyword: "辅酶Q10" })
```

### 返回结果示例

```json
{
  "ok": true,
  "matchedCount": 3,
  "matched": [
    {
      "jd": {
        "title": "辅酶Q10软胶囊 60粒",
        "price": "100",
        "unitPrice": 1.67,
        "unit": "粒",
        "shop": "某买手店",
        "shopType": "buyer"
      },
      "taobao": {
        "title": "辅酶Q10 60粒",
        "price": "60",
        "unitPrice": 1.0,
        "unit": "粒",
        "shipFrom": "浙江",
        "shipHours": 24
      },
      "profit": {
        "rate": 0.67,
        "amount": 40
      }
    }
  ]
}
```

## 部署

### 本地（Claude Code）

```bash
claude mcp add ecommerce-sourcing \
  -e ECOMMERCE_SOURCING_DATA_DIR=$HOME/.ecommerce-sourcing \
  -- node /path/to/mcp/server.mjs
```

### 服务器（多用户）

服务器端：
```bash
export ECOMMERCE_SOURCING_USERS='[{"id":"user1","apiKey":"...","workerKey":"..."}]'
export ECOMMERCE_SOURCING_EXECUTION_MODE=worker
node mcp/http-server.mjs
```

用户本地Worker（调用本地Chrome）：
```bash
export ECOMMERCE_SOURCING_MCP_SERVER_URL=http://server-ip/mcp
export ECOMMERCE_SOURCING_WORKER_KEY=...
node mcp/local-worker.mjs
```

## 测试

```bash
npm test                          # 所有测试
node tests/test-all-in-one.mjs    # All-in-One工具测试
node tests/test-strategy.mjs      # 策略引擎
node tests/test-full-flow.mjs     # 完整流程
```

## 商业模式

- **核心引擎开源** → 吸引用户
- **服务器托管 + 多账号管理 = 收费SaaS**
- Agent装MCP → 调用云端服务 → 按用量计费

## 路线图

- [x] 京东AI控制器
- [x] 淘宝AI控制器（含以图搜图）
- [x] 通用策略引擎
- [x] 最小规格单价计算
- [x] 完整选品流程
- [x] All-in-One MCP工具
- [ ] 商品截图保存
- [ ] 数据库持久化（匹配的淘宝链接）
- [ ] Web控制台
- [ ] 批量账号管理

## License

MIT
