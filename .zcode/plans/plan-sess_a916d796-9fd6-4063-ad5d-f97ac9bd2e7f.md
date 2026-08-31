# 管理仪表盘改版:AI 生效状态 + 充值数据 + 待审核汇总 + 全配置余额查询

## 改动 1:`server/api/admin/dashboard.get.ts`(扩展返回体)

1. **充值收入** `revenue: { total, day24 }`(单位:分)
   - `quota_package_order` 中 `status='paid'` 的 `SUM(amount)`;24h 判定 `COALESCE(paidAt, createdAt) >= 24h 前毫秒数`(与 recharge/list.get.ts 同款,D1 时间传毫秒数字)。

2. **待审核计数** `pending: { skills, novels, requests }`
   - Skill/小说:「每商品最新提交版本 status='pending'」的商品数(与审核列表同口径子查询);需求墙无审核流,取 `feature_requests.status='open'` 计数,展示为「待处理需求」。

3. **AI 配置生效状态** `aiConfig` 增强:`{name, source, model, baseUrl, activeCount, envHasKey, routing: {worldGen, chat}}`(路由解析为配置名;null=跟随生效配置;AI_ROUTE_ENV=环境变量)。

4. **余额查询改为扫描全部已保存配置(无论是否启用),逐个显示,不支持的平台显示「不支持」**:
   - 遍历 `ai_provider_configs` 全部行(含未启用),`decryptJson` 解出 apiKey;另加环境变量条目(有 baseUrl+key 时);
   - 按 baseUrl 识别平台:`deepseek` → `GET {base}/user/balance`(现状逻辑);`muskapi` → `GET {baseUrl}/v1/usage`(Bearer key,文档 https://docs.muskapi.cc/guide/key-usage-balance ),取 `balance/remaining/unit/isValid/mode/usage.total.actual_cost`;其他平台不发请求,标记 `supported: false`;
   - 返回 `accounts: [{ label, source: 'db'|'env', provider: 'deepseek'|'muskapi'|'unknown', supported, available, balanceInfos?, musk?: {balance, unit, isValid, mode, totalCost}, error? }]`(替换原单对象 `deepseek`)。

## 改动 2:`app/pages/admin/index.vue`(UI 重排)

1. **统计卡片**(6 张,`sm:grid-cols-2 lg:grid-cols-3`):总充值收入 ¥、近 24h 充值 ¥、总注册用户、近 24h 注册、总消耗 token、近 24h 消耗。
2. **待审核处理卡**(3 个可点击项,>0 红色高亮):Skill 待审 → `/admin/skills`、小说待审 → `/admin/novels`、待处理需求 → `/admin/requests`。
3. **AI 配置生效状态卡**:来源 badge(db/env)+ 配置名、模型、baseUrl、启用配置数、worldGen/chat 路由指向(未设置显示「跟随生效配置」)。
4. **AI 账户余额卡**(原「DeepSeek 账户余额」改名):按 `accounts` 顺序逐配置渲染——配置名 + 来源 badge + 平台 badge(DeepSeek/MuskAPI/不支持);DeepSeek 显示币种总余额/充值/赠送,MuskAPI 显示 `balance + unit`(附累计消费),不支持的平台显示灰色「不支持」badge;查询失败的显示错误信息。

## 验证
- `npx nuxi typecheck`;起 dev(4569,先查占用)用管理员账号 curl `/api/admin/dashboard`,核对充值/待审计数与各列表接口一致、余额数组按全部配置返回(DeepSeek/MuskAPI 正常、其他显示不支持);`GET /admin` SSR 200;完事关 server 清端口。