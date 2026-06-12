# 电商选品 MCP - AI 驱动

> 一个 MCP 工具，给通用 Agent 增加电商选品能力：京东找候选品、淘宝找供货、单位价比价、结果入库和导出。

## 核心能力

**推荐由 Agent 分段执行：**
```
ecommerce_sourcing({ 
  action: "jd_harvest",
  brand: "GNC",
  targetCount: 5,
  strategyId: "no-source-arbitrage"
})
```

推荐工作流：
1. `jd_harvest`：先用“品牌 + 买手店”收集买手店名，再只搜买手店名。批量脚本会传入品牌表作为 `allowedBrands`，买手店页里命中任一可用品牌的商品都可进入详情页复核评论数、SKU、主图和价格，并先入库。
2. 调用方 Agent：从京东候选标题里提取品牌名 + 核心品名，去掉规格、瓶数、营销词。
3. `taobao_harvest`：用 Agent 清洗后的关键词逐品去淘宝找供货，筛国内发货、48 小时内发货、销量门槛。前几次搜索必须保留品牌词，不能直接用“美国原装进口 + 品类”这类泛词。
4. 调用方 Agent：做同款复核、SKU 单位价比价、利润筛选；`selectedSkuRejectReason` 不为空的淘宝候选不要入库。
5. `save_sourcing`：把京东品和匹配的淘宝货源写回本地库。
6. `sourcing_list`：导出前确认 `taobaoMatchCount > 0`，避免只导出京东候选。
7. `export_results` / `export_feishu`：导出 CSV 或飞书表格。导出前会按“同款商品”最终去重，返回的 `count` 才是最终可用商品数。

## 一个 MCP，所有功能

| Action | 用途 |
|--------|------|
| **初始化** | |
| `usage_guide` | 查看 Agent 使用手册 |
| `batch_guide` | 查看批量选品脚本、断点续跑和最终去重规则 |
| `bootstrap` | 新电脑安装本机 worker 引导 |
| `warmup` | 只读账号状态预检 |
| **策略库** | |
| `strategy_templates` | 查看内置策略模板 |
| `strategy_list` | 列出所有策略 |
| `strategy_get` | 查看策略详情 |
| `strategy_save` | 保存自定义策略 |
| **账号池** | |
| `account_list` | 列出账号 |
| `account_add` | 新增账号 profile |
| `account_login` | 打开正式 Chrome 登录页 |
| `account_check` | 检查登录态 |
| `account_remove` | 删除账号记录 |
| **京东** | |
| `jd_search` | 搜索 |
| `jd_extract` | 提取列表 |
| `jd_detail` | 提取详情（模拟人类点击） |
| `jd_search_filter` | 搜索+按策略筛选 |
| `jd_harvest` | 推荐：京东品牌候选采集并入库 |
| **淘宝** | |
| `taobao_search` | 关键词搜索 |
| `taobao_search_image` | 以图搜图（推荐） |
| `taobao_extract` | 提取列表 |
| `taobao_harvest` | 推荐：淘宝逐品供货采集；会把选中 SKU 明显不匹配的候选放入 rejected |
| **数据** | |
| `save_sourcing` | 保存京东品和淘宝匹配 |
| `sourcing_list` | 查看已入库结果和淘宝匹配数量 |
| `logs` | 查看最近 MCP 操作日志 |
| `export_results` | 导出 CSV；导出前按品牌、核心品名和剂量最终去重 |
| `bind_feishu` | 绑定飞书 |
| `export_feishu` | 导出飞书多维表格；主列会初始化为“序号”，并清理默认字段和默认空行；导出前按同款商品最终去重 |
| `close` | 兼容旧调用；默认保持浏览器会话打开 |

## 内置策略

### 1. 无货源套利（默认）
```json
{
  "id": "no-source-arbitrage",
  "platforms": {
    "jd": {
      "shopTypes": { "include": ["buyer"] },  // 只要买手店
      "minComments": 2
    },
    "taobao": {
      "shipFrom": "domestic",    // 国内发货
      "shipWithinHours": 48,     // 48小时内
      "minSales": 10
    }
  },
  "profit": {
    "minRate": 0.35,  // 35%
    "maxRate": 0.60,  // 60%，超过可能是假货/异常货源
    "minAmount": 20   // 最低单件利润
  },
  "riskControl": {
    "bannedBrands": [
      { "name": "斯维诗", "aliases": ["Swisse"] },
      { "name": "益节", "aliases": ["Move Free", "MoveFree"] },
      { "name": "脉拓", "aliases": ["MegaRed"] },
      { "name": "安利", "aliases": ["Amway", "纽崔莱", "NUTRILITE"] },
      { "name": "优必欧", "aliases": ["UBIO"] },
      { "name": "汤普森", "aliases": ["Thompsons", "Thompson's"] },
      { "name": "佰澳朗德", "aliases": ["BioIsland", "Bio Island"] },
      { "name": "澳佳宝", "aliases": ["Blackmores"] }
    ]
  }
}
```

## 技术亮点

### 保守浏览器自动化
- ✅ 正式Chrome（不是Chromium）
- ✅ 用户已登录Cookie
- ✅ 小量、低频、可暂停
- ✅ 遇到验证码、安全验证、访问频繁、登录失效时暂停并返回给 Agent
- ✅ 保持账号 profile，不清空、不重建、不默认杀 Chrome 进程

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

### Agent 调用（Claude Code）

```typescript
// 1. 推荐：京东先采集并入库候选
ecommerce_sourcing({
  action: "jd_harvest",
  brand: "GNC",
  targetCount: 5,
  strategyId: "no-source-arbitrage"
})

// 2. Agent 从京东标题提取品牌+核心品名后，逐个淘宝找货源
ecommerce_sourcing({
  action: "taobao_harvest",
  keyword: "GNC 辅酶Q10",
  strategyId: "no-source-arbitrage",
  minSales: 10,
  requireDomestic: true,
  require48h: true
})

// 3. Agent 完成同款复核、单位价和利润计算后，把匹配结果写回库
ecommerce_sourcing({
  action: "save_sourcing",
  jdProduct: { "productId": "jd-xxx", "title": "...", "price": 398 },
  taobaoMatches: [{ "taobao": { "productId": "tb-xxx", "price": 216 }, "profit": { "profitRate": 0.45, "profitAmount": 182 } }]
})

// 4. 导出前确认淘宝匹配已经入库
ecommerce_sourcing({ action: "sourcing_list", limit: 20 })
```

### 分段返回结果示例

`jd_harvest` 会先把京东候选保存到本地库，并把下一步要给 Agent 处理的任务返回出来：
```json
{
  "ok": true,
  "action": "jd_harvest",
  "candidateCount": 2,
  "database": {
    "savedCount": 2,
    "saveErrors": []
  },
  "suggestedTaobaoTasks": [
    {
      "jdProductId": "jd-xxx",
      "jdTitle": "GNC 辅酶Q10 150mg 60粒",
      "searchKeywordCandidates": ["GNC 辅酶Q10 软胶囊", "辅酶Q10 软胶囊"]
    }
  ]
}
```

### 批量跑满目标数量

长任务建议由 Agent 先调用：
```json
{ "action": "batch_guide" }
```

本仓库内置批量编排脚本，适合“找满 100 个最终去重可用品”：
```bash
npm run batch:sourcing -- \
  --target=100 \
  --brands=$HOME/.ecommerce-sourcing-agent/brand-queue.json \
  --maxShopsPerBrand=8 \
  --maxDetailPerShop=12 \
  --maxConsecutiveCommentRejectsPerShop=8 \
  --exportFeishu=true
```

品牌队列支持两种格式：
```json
["GNC", "Nature Made"]
```

```json
{ "brands": ["GNC", "Nature Made"] }
```

批量脚本会断点续跑，并使用和 CSV/飞书一致的最终去重规则。最终 `export_results` / `export_feishu` 返回的 `count` 小于目标数时，Agent 继续跑下一批品牌即可。

排查批量任务时先看日志：`jd_harvest` 会记录买手店列表命中、跳过原因和详情页淘汰原因；`taobao_harvest` 会记录国内发货、48 小时、销量、价格等基础筛选摘要；批量脚本还会记录同款复核、剂量、单位价和利润策略的淘汰原因。

京东采集默认带低质量店保护：每个买手店最多进 `maxDetailPerShop=12` 个商品详情；如果连续 `maxConsecutiveCommentRejectsPerShop=8` 个详情评论不达标，会跳过当前店铺继续下一个买手店。需要深挖某个店时可以把这两个参数调大。

`save_sourcing` 之后再用 `sourcing_list` 确认淘宝匹配是否已经写回库：
```json
{
  "ok": true,
  "action": "sourcing_list",
  "count": 1,
  "items": [
    {
      "jdProductId": "jd-xxx",
      "jdTitle": "GNC 辅酶Q10 150mg 60粒",
      "jdPrice": 398,
      "jdUnitPrice": 6.6333,
      "profitAmount": 182,
      "profitRate": 0.4573,
      "taobaoMatchCount": 1
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
npm run typecheck                 # 类型检查
npm test                          # 本地单元测试和 MCP 协议测试，不打开京东/淘宝
npm run smoke                     # 安全烟测：usage_guide + warmup
npm run batch:sourcing -- --target=1 --brandLimit=1  # 小批量真实链路验证，会打开本机Chrome
```

## License

MIT
