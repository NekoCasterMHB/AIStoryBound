# 兑换码兑换 Token 功能设计方案

## 1. 总体结构

- **管理员身份**:新增 `ADMIN_EMAIL` 环境变量 + `requireAdmin` 鉴权助手(项目目前无任何管理员体系,这是最小侵入方案)
- **两张新表**:兑换码表 + 兑换记录表(支持明细查询与每人限次)
- **用户侧**:`profile.vue` 增加兑换码输入区 + `POST /api/redeem` 兑换接口
- **管理侧**:隐藏页面 `/admin`(应用内无入口,仅所有者知道 URL)+ 4 个管理 API

## 2. 数据库(server/db/schema.ts + drizzle 迁移)

新增两张表:

**`redeem_codes`(兑换码)**
| 字段 | 说明 |
|---|---|
| id | text PK(uuid) |
| code | text UNIQUE,10 位大写字母数字(去易混淆字符 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,32 字符空间 ≈ 1.1e15 不可暴力枚举) |
| tokens | integer,兑换可得 token 数 |
| max_uses | integer 可空,总用量上限,null=不限 |
| per_user_limit | integer 默认 1,每人限用次数,1=活动码每人限领一次 |
| used_count | integer 默认 0 |
| disabled | integer 默认 0,1=停用(码泄露时封禁) |
| expires_at | timestamp_ms 可空,过期时间,null=永不过期 |
| created_by / created_at / updated_at | 创建人(所有者)、时间 |

**`redeem_code_redemptions`(兑换记录)**
- id PK、code_id(FK→redeem_codes, cascade)、user_id(FK→user.id)、tokens(入账额快照)、created_at

迁移流程:`pnpm db:generate` 生成迁移文件 → `pnpm db:migrate:local` 本地验证;**远程迁移 `db:migrate:remote` 由你决定执行时机**(不可逆操作)。

## 3. 管理员身份(authz.ts + 配置)

- `server/utils/authz.ts` 新增 `requireAdmin(event)`:先 `requireUser`,再比对 `user.email === ADMIN_EMAIL`(env.cloudflare 优先、runtimeConfig 兜底,与 ai.ts/auth.ts 读取模式一致);不匹配或无配置抛 403
- `nuxt.config.ts` runtimeConfig 增加 `admin: { email: '' }`
- `.env.example` / `.dev.vars` 增加 `ADMIN_EMAIL` 说明;`wrangler.toml [vars]` 加 `ADMIN_EMAIL`(非敏感);本地 `.dev.vars` 填你的邮箱
- 顺手跑 `npx wrangler types` 重新生成类型(不跑也不影响编译,env 读取处有类型断言)

## 4. 用户兑换 API

**`POST /api/redeem`**(requireUser),body `{ code }`
1. 规范化:trim + 转大写
2. 查码校验:不存在/已停用 → 400「无效的兑换码」;已过期 → 400;已领完(used_count ≥ max_uses)→ 400
3. 每人限次检查:查询该用户对该码的兑换次数,≥ per_user_limit → 400「每人限领一次」
4. **原子入账**(D1 batch 一次性提交,任一失败整体回滚,不会出现"码被消耗但没到账"):
   - `UPDATE redeem_codes SET used_count = used_count + 1 WHERE id=? AND disabled=0 AND (max_uses IS NULL OR used_count < max_uses) AND (expires_at IS NULL OR expires_at > now)`(changes===0 则失败)
   - `INSERT 兑换记录`
   - `UPDATE user SET ai_token_balance = ai_token_balance + ?`(与支付回调 notify.post.ts 相同的 sql 增量模式)
5. 返回 `{ ok: true, tokens }`

并发边界说明:同一毫秒内的极端并发可能多放行 1~2 次(与现有 chat 余额扣减的容忍策略一致),活动场景可接受。

## 5. 管理 API(全部 requireAdmin)

- **POST `/api/admin/redeem/create`**:body `{ tokens, count, maxUses?, perUserLimit?, expiresAt? }`;校验 tokens>0、count 1~100;`crypto.getRandomValues` 生成唯一码(碰撞重试);批量插入;返回本次生成的完整码数组(创建响应是完整码的唯一展示时机)
- **GET `/api/admin/redeem/list`**:全部码列表(码、token、used_count/max_uses、per_user_limit、disabled、expires_at、created_at)
- **GET `/api/admin/redeem/[id]`**:码详情 + 兑换明细(兑换用户 name/email、时间)
- **POST `/api/admin/redeem/[id]/disable`**:停用/恢复(翻转 disabled,保留记录)

## 6. 前端

**`app/pages/profile.vue`**:余额卡片下方新增「兑换码」兑换区 —— UInput 输入码 + 兑换按钮;成功刷新余额并提示到账 token 数,失败显示错误文案(沿用页面现有内联 UAlert 风格,不引入 toast)。

**`app/pages/admin.vue`**(/admin,未登录会被现有 auth.global.ts 中间件拦到登录页;非管理员调用 list API 得 403 后页面显示"无权限"):
1. **生成表单**:token 数量、生成个数、规则选择(每人限一次·不限总量 / 每人限一次·限量 N 次 / 一码一用)、有效期(可选,日期选择)
2. **生成结果**:完整码列表 + 一键复制按钮
3. **码列表表格**:码、token、用量(used/max)、每人限次、状态、过期时间、创建时间、停用/恢复按钮
4. **兑换明细**:点击码展开 UModal,展示兑换记录(用户、时间)

复用 @nuxt/ui v4 的 UInput/UButton/UTable/UModal/UFormField 等现有组件,风格对齐 profile.vue。

## 7. 实施步骤

1. schema.ts 加两表 → `pnpm db:generate` → `pnpm db:migrate:local`(本地验证)
2. authz.ts 加 `requireAdmin`,改 nuxt.config.ts / .env.example / wrangler.toml / .dev.vars
3. 实现 `POST /api/redeem` + 4 个 admin API
4. profile.vue 加兑换区;新建 admin.vue
5. 本地启动 dev(先查端口占用,按全局规则杀旧重启)手动验证:注册→兑换→余额增加→重复兑换被拒→非管理员访问 admin 被拒
6. 验证完关闭自己启动的 dev 服务器、确认端口释放

远程迁移(`db:migrate:remote`)与部署(`deploy:cf`)留给你确认后执行。