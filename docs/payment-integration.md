# 支付接入文档（微支付网关 · 额度购买）

> 本文档用于辅助其他 AI / 开发者复刻 SP飞行棋 v3 的支付逻辑。
> 该支付为「额度（Quota）购买」：用户付费扩充棋盘/工具/道具/事件/方案的容量上限。
> 支付网关为第三方 **微支付（microgg.cn）**，支持微信支付 / 支付宝，走 **RSA 签名** 的页面跳转支付（非 JSAPI/小程序）。

---

## 1. 整体流程

```mermaid
sequenceDiagram
    participant U as 用户浏览器
    participant FE as 前端 (Nuxt app)
    participant API as 服务端 API (Nitro)
    participant GW as 微支付网关 (microgg.cn)
    participant DB as D1 (SQLite)

    U->>FE: 打开「购买额度」弹窗，选商品+支付方式
    FE->>API: POST /api/payment/create { packageId, payType }
    API->>API: 鉴权 → 校验商品 → 生成订单号 → 构造参数 → RSA 私钥签名
    API-->>FE: { action: 网关submit地址, params: 表单字段 }
    FE->>GW: 动态创建隐藏 form POST 跳转
    GW->>U: 收银台支付
    GW->>API: 异步回调 POST/GET /api/payment/notify (带签名)
    API->>API: RSA 公钥验签 → 校验 TRADE_SUCCESS → 幂等检查
    API->>DB: 写入/更新 quota_package_order 订单
    API->>DB: 用户配额字段叠加 (applyQuotaIncrease)
    API-->>GW: 返回 "success" / "fail"
    GW->>U: 跳转 return_url = /profile
    FE->>API: GET /api/profile/purchases 拉取购买历史
```

**核心原则（复刻时不可改动）：**

1. **金额服务端权威**：价格永远从服务端商品表读取，绝不信任前端传参。
2. **双 RSA 签名**：提交参数用「商户私钥」签名（网关验签）；回调参数用「平台公钥」验签（防伪造）。
3. **幂等**：回调可能重复/乱序到达，必须用 `out_trade_no` 唯一约束 + 状态判断保证只入账一次。
4. **回调携带业务上下文**：通过 `param` 字段（JSON 字符串）携带 `userId` 和 `packageId`，回调时据此定位用户与商品。

---

## 2. 环境变量与运行时配置

### 2.1 环境变量（`.env`）

```
MICROPAY_PID=1006                       # 商户号
MICROPAY_PRIVATE_KEY=<RSA私钥(商户)>
MICROPAY_PUBLIC_KEY=<RSA公钥(平台)>
```

> 私钥/公钥可传「裸 base64」（无 PEM 头），代码会自动补全 PEM 头尾；也支持带 `\n` 字面量或完整 PEM。

### 2.2 Nuxt runtimeConfig（`nuxt.config.ts`）

```ts
runtimeConfig: {
  micropayPid: process.env.MICROPAY_PID || '',
  micropayPrivateKey: process.env.MICROPAY_PRIVATE_KEY || '',
  micropayPublicKey: process.env.MICROPAY_PUBLIC_KEY || '',
}
```

服务端通过 `useRuntimeConfig()` 读取，禁止在客户端暴露私钥。

---

## 3. 商品（额度包）定义

文件：`lib/quota-packages.ts`（同时被前后端引用，纯 TS、无框架依赖）。

### 3.1 配额维度

5 类容量上限：`boards`(棋盘) / `tools`(工具) / `items`(道具) / `events`(事件) / `plans`(方案)。

默认上限 `DEFAULT_QUOTA_LIMITS`：

```ts
{ boards: 3, tools: 5, items: 5, events: 5, plans: 3 }
```

### 3.2 商品结构

```ts
type QuotaPackageDefinition = {
  id: string            // 唯一商品ID，如 'boards_small' / 'bundle_large'
  label: string         // 展示名（同时作为支付网关的 name 字段）
  shortLabel: string
  description: string
  kind: 'single' | 'bundle'
  size: 'small' | 'medium' | 'large'
  price: number         // 单位：元（两位小数）
  filters: QuotaFilterKey[]   // 命中哪些分类筛选
  quotaIncrease: QuotaLimits  // 每个维度的增量（0 表示不增加）
}
```

### 3.3 现有商品体系（供参考）

- 单类包（4 分类 × 3 档）：
  - 小：+3（棋盘）/+5（其余），¥6
  - 中：+6/+10，¥10
  - 大：+12/+20，¥18
- 综合包（bundle）：
  - 小：¥28（+5 棋盘 / +10 工具/道具/事件）
  - 大：¥38（+10 棋盘 / +20 工具/道具/事件）

### 3.4 关键函数

```ts
isQuotaPackageId(id)        // 是否为合法商品ID（前端传参白名单校验）
getQuotaPackageById(id)     // 取商品（服务端据此取价格）
applyQuotaIncrease(current, increase)  // 配额叠加（逐字段相加）
buildQuotaLimits(overrides) // 构造完整 QuotaLimits（含默认值）
```

---

## 4. 服务端实现

### 4.1 签名工具 `server/utils/micropay.ts`

三个函数，全部基于 `node:crypto`：

```ts
// 1. 构造待签名字符串：按 ASCII key 排序，排除 sign/sign_type/空值
buildSignStr(params): string
// => Object.keys(params)
//    .filter(k => k !== 'sign' && k !== 'sign_type' && 非空)
//    .sort().map(k => `${k}=${params[k]}`).join('&')

// 2. RSA-SHA256 签名（商户私钥，base64 输出）
signRSA(signStr): string

// 3. RSA-SHA256 验签（平台公钥）
verifyRSA(signStr, sign): boolean

// 4. 生成商户订单号：Date.now() + 6位随机数（共19位数字）
generateOutTradeNo(): string
```

密钥处理细节（复刻时照抄）：

```ts
let pem = rawKey.replace(/\\n/g, '\n')          // 还原 \n 字面量
if (!pem.includes('-----')) {                    // 裸 base64 自动补 PEM 头尾
  pem = `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`
}
```

### 4.2 创建订单 `server/api/payment/create.post.ts`

```ts
POST /api/payment/create
Body: { packageId: string, payType: string }   // payType: 'wxpay' | 'alipay'
```

处理步骤：

1. **鉴权**：`better-auth` 取 session，无用户抛 401。
2. **校验商品**：`isQuotaPackageId(packageId)` 不合法抛 400；`getQuotaPackageById` 取不到抛 400。
3. **价格**：`quotaPackage.price.toFixed(2)`（服务端权威，不用前端传价）。
4. **商户号**：`config.micropayPid`，缺失抛 500。
5. **生成订单号**：`generateOutTradeNo()`。
6. **构造提交参数**：

```ts
{
  pid,                                        // 商户号
  type: payType,                              // 支付方式
  out_trade_no: outTradeNo,                   // 商户订单号（唯一，幂等键）
  notify_url: `${baseUrl}/api/payment/notify`,// 异步回调地址（必须公网可达）
  return_url: `${baseUrl}/profile`,           // 支付完成跳转页
  name: quotaPackage.label,                   // 商品名
  money: price,                               // 金额（元，字符串）
  timestamp,                                  // 秒级时间戳
  param: JSON.stringify({ userId, packageId }),// 业务上下文（回调解析用）
  sign_type: 'RSA',
}
```

7. **签名**：`sign = signRSA(buildSignStr(params))` 追加到 `params.sign`。
8. **返回**：

```ts
{
  action: 'https://pay.microgg.cn/api/pay/submit',  // 网关提交地址
  params,                                          // 完整表单字段（含 sign）
}
```

> `baseUrl` 由 `getRequestProtocol(event) + '://' + getRequestHost(event)` 动态拼接，保证回调/回跳 URL 指向当前域名。

### 4.3 异步回调 `server/api/payment/notify.post.ts`

```ts
POST|GET /api/payment/notify
```

处理步骤（顺序敏感，逐条照抄）：

1. **合并参数**：`params = { ...getQuery(event), ...readBody(event) }`（网关 POST form 或 GET 均兼容）。
2. **验签**：`verifyRSA(buildSignStr(params), params.sign)` 失败 → 返回字符串 `'fail'`（网关会重试）。
3. **状态过滤**：`params.trade_status !== 'TRADE_SUCCESS'` → 直接返回 `'success'`（不处理非成功状态）。
4. **取关键字段**：
   - `outTradeNo = params.out_trade_no`（缺失返回 `'fail'`）
   - `amountFen = Math.round(parseFloat(params.money) * 100)`（元 → 分，入库单位）
   - 解析 `params.param` JSON → `userId`、`packageId`（缺失/解析失败返回 `'fail'`）
5. **校验商品**：`getQuotaPackageById(packageId)`，取不到返回 `'fail'`。
6. **幂等检查**：按 `orderNo` 查 `quota_package_order`：
   - 已存在且 `status === 'paid'` → 返回 `'success'`（已入账，直接确认）。
   - 已存在（未 paid）→ `UPDATE` 置为 paid，写入 `providerTradeNo`、`paidAt`。
   - 不存在 → `INSERT` 新订单（status=paid）。
7. **配额入账**：
   - `getUserQuotaSnapshot(userId)` 取当前配额。
   - `applyQuotaIncrease(limits, quotaPackage.quotaIncrease)` 叠加。
   - `UPDATE users` 写回 `boardQuotaLimit / toolQuotaLimit / itemQuotaLimit / eventQuotaLimit / planQuotaLimit / quotaUpdatedAt`。
8. **返回**：字符串 `'success'`。

> ⚠️ 回调响应体必须是纯字符串 `success` / `fail`（网关按内容判断是否重试），**不是 JSON**。

### 4.4 购买历史 `server/api/profile/purchases.get.ts`

```ts
GET /api/profile/purchases   // 需登录
```

按 `userId` 查询 `quota_package_order`，按 `paidAt`、`createdAt` 倒序，返回：

```ts
{ id, orderNo, packageId, packageName, amount /*分*/, currency,
  provider, providerTradeNo, status, paidAt, createdAt }
```

---

## 5. 数据库表

文件：`server/db/schema/quota_package.ts`（Drizzle + SQLite/D1）。

```ts
quota_package_order {
  id                text  PK          // 'order_<ts>_<random6>'
  order_no          text  NOT NULL    // 商户订单号（唯一索引！幂等键）
  user_id           text  NOT NULL    // FK -> users.id (onDelete cascade)
  package_id        text  NOT NULL
  package_name      text  NOT NULL
  amount            integer NOT NULL  // 单位：分
  currency          text  NOT NULL DEFAULT 'CNY'
  provider          text  NOT NULL    // wxpay / alipay / unknown
  provider_trade_no text              // 网关流水号
  status            text  NOT NULL DEFAULT 'pending'
                    // 取值: 'pending' | 'paid' | 'closed' | 'refunded'
  paid_at           integer(timestamp_ms)
  refunded_at       integer(timestamp_ms)
  created_at        integer(timestamp_ms) NOT NULL
  updated_at        integer(timestamp_ms) NOT NULL
}
```

索引：`order_no` 唯一索引 + `user_id` / `status` / `created_at` 普通索引。

用户配额字段在 `users` 表（`server/db/schema/auth.ts`）：

```ts
board_quota_limit INTEGER DEFAULT 3
tool_quota_limit  INTEGER DEFAULT 5
item_quota_limit  INTEGER DEFAULT 5
event_quota_limit INTEGER DEFAULT 5
plan_quota_limit  INTEGER DEFAULT 3
quota_updated_at  INTEGER
```

迁移文件示例：`server/db/migrations/0009_quota_package_model.sql`。

---

## 6. 前端实现

### 6.1 购买弹窗 `app/components/QuotaPurchaseModal.vue`

1. 商品列表直接引用 `QUOTA_PACKAGES`（客户端静态数据，仅展示）；支持按分类筛选、选中态高亮、折扣徽标（`getQuotaPackageDiscount`）。
2. 支付方式：两个按钮 `wxpay`（微信支付）/ `alipay`（支付宝），默认 `wxpay`。
3. **提交订单**（`submitOrder`）：

```ts
const res = await $fetch('/api/payment/create', {
  method: 'POST',
  body: { packageId: currentPackage.id, payType: selectedPayment }
})
// res = { action, params }

// 动态创建隐藏 form 并 POST 跳转到网关
const form = document.createElement('form')
form.method = 'POST'
form.action = res.action
form.style.display = 'none'
for (const [key, value] of Object.entries(res.params)) {
  const input = document.createElement('input')
  input.type = 'hidden'; input.name = key; input.value = value
  form.appendChild(input)
}
document.body.appendChild(form)
form.submit()
```

> 页面跳走后支付流程与当前页面无关；回调由服务端 `notify_url` 异步完成，无需前端轮询。
> 支付完成后网关跳回 `return_url = /profile`，用户可打开「购买记录」查看结果。

### 6.2 购买历史弹窗 `app/components/PurchaseHistoryModal.vue`

打开时请求 `/api/profile/purchases`，展示商品名、状态徽标（paid/pending/closed/refunded）、订单号、创建/支付时间、金额（`amount / 100` 转为元）、渠道单号。

### 6.3 入口

`app/pages/profile.vue` 中两个按钮：`购买额度`（打开 `QuotaPurchaseModal`）与 `购买记录`（打开 `PurchaseHistoryModal`）。

### 6.4 i18n

新增文案需同步三语言：`i18n/locales/{zh-CN,en,ja}.ts` 的 `purchase.*` 命名空间（见 zh-CN 参考：`title/shopTitle/filter/payment/status/submitOrder/orderNo/...`）。

---

## 7. 安全要点清单（复刻必读）

| # | 要点 | 说明 |
|---|------|------|
| 1 | 金额服务端权威 | 价格来自 `getQuotaPackageById`，前端无法改价 |
| 2 | 商品白名单 | `isQuotaPackageId` 校验，杜绝任意 packageId |
| 3 | 回调验签 | 平台公钥验签，防第三方伪造 `notify` 请求 |
| 4 | 幂等 | `order_no` 唯一索引 + `status==='paid'` 短路，防重复入账 |
| 5 | 业务上下文走 `param` | `userId`/`packageId` 由服务端加密签名携带，回调解析；**不要在 notify 里信任前端可改字段** |
| 6 | 金额入库转分 | `money(元) → amount(分)` 整数存储，避免浮点误差 |
| 7 | 回调响应文本 | 返回字符串 `success`/`fail`，非 JSON |
| 8 | 私钥不出客户端 | 私钥仅存服务端 runtimeConfig/环境变量 |
| 9 | 订单号唯一 | `时间戳+6位随机`，网关侧幂等键 |
| 10 | 仅处理 TRADE_SUCCESS | 其他状态直接确认不处理，避免误入账 |

---

## 8. 测试

文件：`server/utils/__tests__/micropay.test.ts`（Vitest）。

覆盖点：
- `buildSignStr`：ASCII 排序、忽略 `sign`/`sign_type`/空值/undefined/null。
- `signRSA`/`verifyRSA` 往返一致（测试内临时生成 RSA 密钥对并 strip PEM）。
- 篡改载荷验签失败。
- `generateOutTradeNo` 为 19 位数字、多次调用不重复。

运行：`pnpm test`（或 `pnpm --filter @flying-chess/core typecheck` 校验核心包）。

---

## 9. 复刻实现清单（给其他 AI 的步骤指引）

1. **配置**：在 `.env` 与 `runtimeConfig` 添加 `MICROPAY_PID` / `MICROPAY_PRIVATE_KEY` / `MICROPAY_PUBLIC_KEY`。
2. **商品定义**：创建 `lib/quota-packages.ts`（含商品数组、`isQuotaPackageId`、`getQuotaPackageById`、`applyQuotaIncrease`）。
3. **签名工具**：创建 `server/utils/micropay.ts`（`buildSignStr` / `signRSA` / `verifyRSA` / `generateOutTradeNo`）。
4. **数据库**：建 `quota_package_order` 表 + `users` 表配额字段，加 `order_no` 唯一索引。
5. **创建订单接口**：`POST /api/payment/create`（鉴权 → 校验 → 签名 → 返回 `{action, params}`）。
6. **回调接口**：`POST/GET /api/payment/notify`（验签 → 状态过滤 → 幂等 → 写订单 → 叠加配额 → 返回 `success`）。
7. **查询接口**：`GET /api/profile/purchases`（登录用户订单列表）。
8. **前端弹窗**：商品选择 + 支付方式 + 动态 form POST 跳转；购买历史弹窗。
9. **i18n**：补齐三语言 `purchase.*` 文案。
10. **测试**：`micropay.test.ts` 覆盖签名往返与订单号生成。
11. **联调**：用真实支付 1 分钱/最小金额商品验证回调入账与幂等（重复回调只入账一次）。

---

## 10. 相关文件索引

| 文件 | 职责 |
|------|------|
| `server/api/payment/create.post.ts` | 创建订单、构造并签名提交参数 |
| `server/api/payment/notify.post.ts` | 异步回调：验签、幂等、入账 |
| `server/api/profile/purchases.get.ts` | 购买历史查询 |
| `server/utils/micropay.ts` | 签名/验签/订单号工具 |
| `server/utils/quota.ts` | 用户配额快照读取/映射 |
| `lib/quota-packages.ts` | 商品定义 + 配额叠加纯函数 |
| `server/db/schema/quota_package.ts` | 订单表 schema |
| `app/components/QuotaPurchaseModal.vue` | 购买弹窗（前端入口） |
| `app/components/PurchaseHistoryModal.vue` | 购买历史弹窗 |
| `server/utils/__tests__/micropay.test.ts` | 签名工具测试 |
| `i18n/locales/{zh-CN,en,ja}.ts` | 三语言文案 |
