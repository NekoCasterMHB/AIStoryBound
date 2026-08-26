## 调整 Token 加油包定价

### 改动文件(仅 1 个)
`shared/quota-packages.ts` —— 全项目唯一定价源,前端展示(profile.vue)、服务端收银(payment/create、notify)、限购校验均自动跟随,无需改其他文件。

### 具体修改(4 个套餐的 priceYuan + discountLabel)
1. **tokens_1m_once(新人特惠 1M)**: `priceYuan: 3 → 6`,`discountLabel: '1.5 折' → '3 折'`(6/20 = 3折)
2. **tokens_1m(1M)**: `priceYuan: 18 → 15`,`discountLabel: '9 折' → '7.5 折'`(15/20 = 7.5折)
3. **tokens_10m(10M)**: `priceYuan: 150 → 120`,`discountLabel: '7.9 折' → '6.3 折'`(120/191 ≈ 6.3折)
4. **tokens_50m(50M)**: `priceYuan: 599 → 500`,`discountLabel: '6.3 折' → '5.3 折'`(500/951 ≈ 5.3折)

划线原价(`originalPriceYuan = packPriceYuan(...)`,公式 ≈¥20/1M)保持不变;套餐规模(1M/10M/50M)、文案、`isTokenPackageId`/`getTokenPackageById` 均不动。

### 验证
1. 全局 grep 确认旧价格(18、150、599、3 元)没有在其他文件被硬编码引用。
2. 运行 `pnpm typecheck` 或构建确认无类型错误。
3. 检查 `shared/quota-packages.ts` 最终数值与上表一致。

### 说明
- D1 中已落库的历史订单(`quota_package_order.amount`)不受影响,只影响新订单。
- `TOKEN_CNY_PER_M`(≈¥19/1M 标准价估算,用于 store/publish.vue 技能定价的人民币参考)不在本次调整范围,保持不变。