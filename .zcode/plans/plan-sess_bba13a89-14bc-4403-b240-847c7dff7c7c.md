## 全面改造实施计划：登录 + 本地优先 + AI 中继计费 + 支付

### 架构总览（已确认的全部决策）
- **必须登录**（无游客）；Better Auth 接入（Nuxt + Drizzle/D1 + Resend 发信）。
- **本地优先**：小说库（章节/实体库/冲突/人物卡/概要）、游戏会话、消息、存盘点全部 IndexedDB；云端（D1）只做**登录用户的同步层**（作品库 + 存盘点 + 跨设备续玩）。
- **AI 转发**：服务器无状态中继 + 配额扣减；用户可配置**自己的 API key**（baseUrl/apiKey/模型/请求模式，D1 内 AES-GCM 加密存储）→ 走用户额度。
- **计费**：新用户赠送 10 万 token；token 加油包固定三档，价格 = DeepSeek V4 flash 输出价 ×2 向上取整；支付走微支付网关（docs/payment-integration.md 模式复刻）。

### 阶段 0：认证（Better Auth + 强制登录）
- 安装 `better-auth`；`server/utils/auth.ts`（drizzle adapter provider 'sqlite' + D1）挂 `server/api/auth/[...all].ts`；`app/utils/auth-client.ts`（`createAuthClient` + `emailOTPClient`）。
- 插件配置：`emailAndPassword {enabled, requireEmailVerification}` + `emailOTP {sendVerificationOTP, disableSignUp: true, overrideDefaultEmailVerification: true}`——注册即触发验证码邮件，登录可用 邮箱+密码 或 邮箱+验证码。
- `server/utils/email.ts`：`sendVerificationOTP({email, otp, type})` 调 Resend API（`RESEND_API_KEY` env；dev 无 key 时日志打印验证码占位）。
- 前端：`/login` 页双 tab（邮箱+密码 / 邮箱+验证码）；注册为**模态框**（用户名/邮箱/密码/确认密码 + 获取验证码/输入验证码）；`app/middleware/auth.global.ts` 全局守卫（未登录跳 /login）。
- 全部现有 API 鉴权：`userId='anon'` 三处（games 创建、novels 列表、生成管线）替换为 `auth.api.getSession` 的真实 userId；未登录一律 401/302。
- D1 迁移：better-auth 核心表（user/session/account/verification）；`users` 加 `ai_token_balance INTEGER DEFAULT 0`（注册赠送 10 万）、`ai_config_enabled`、`ai_config_ciphertext`、`ai_config_iv`；旧的自定义 `users` 表保留不删（无冲突）。

### 阶段 1：AI 中继 + 配额 + 用户 Key
- 新增 `server/api/ai/chat.post.ts`：**通用无状态中继**，body `{messages, json?, maxTokens?, model?, temperature?, thinking?}`：
  - 鉴权 → 读用户 AI 配置：已启用 → 用用户 key/baseUrl/model 转发（不扣配额）；未启用 → 用平台 key（当前 deepseek-v4-flash）转发并**按 usage totalTokens 扣 `ai_token_balance`**，余额 ≤0 → 402 "token 余额不足"。
  - 流式 SSE 透传（选项/叙事/生成共用这一个接口；不再有服务器端编排）。
- 用户 AI 配置：`GET/POST /api/profile/ai-config`（baseUrl/apiKey/model/请求模式 thinking 开关）；`server/utils/crypto.ts` 用 `BETTER_AUTH_SECRET` HKDF 派生密钥做 AES-GCM 加解密。
- 生成管线/回合/检查/成书全部改为浏览器编排 → 调 `/api/ai/chat`；`shared/world-build.ts` 提供纯函数（切块/合并/引用校验/提示词组装）。

### 阶段 2：本地优先 + 云同步
- `app/utils/localDb.ts` DB_VERSION 4：`works`（本地小说：meta+章节+entities+conflicts+warnings+overlay）、`games`（会话+消息+状态+存盘点）。
- 上传生成改为浏览器全流程：本地解析（复用 shared 纯函数）→ 本地切块/并发调中继 → 本地合并/引用校验 → 检查/成书 → 存 IndexedDB；进度由本地状态驱动（删除旧 SSE 生成路径与 `novel-generation.ts` 服务器编排）。
- 游戏回合浏览器驱动：`shared/prompt.ts` 组装提示词（卡片随请求由浏览器携带）→ `/api/ai/chat` 叙事流 + 选项结构化 → `shared/mergeState` 本地应用 → 本地落盘；回滚用本地存盘点（现成机制）。
- 云同步（登录用户，手动按钮 push/pull）：`POST /api/works`（作品 overlay+entities+conflicts 入库 D1 `novels`，不含章节全文）、`GET /api/works`（换设备恢复列表 + 下载）；游戏同步 `POST /api/games/import` + 现有 saves API 鉴权化。同步状态字段（synced/pending）记录在本地。
- 旧服务器端游戏逻辑（turn.post.ts 编排、章节入库、选角读 D1 world_state）废弃，代码移除或标记 deprecated；`novel_chapters` 表保留兼容旧数据不再写入。

### 阶段 3：计费与支付（微支付网关）
- `shared/quota-packages.ts`：三档加油包 {1M/10M/100M tokens}；`price分 = ceil(2 × 1.32(flash 输出 $/M) × 汇率7.2 × M) 元 → 转分`，常量表可调（1M≈¥20）。
- 复刻 docs/payment-integration.md：`server/utils/micropay.ts`（buildSignStr/signRSA/verifyRSA/generateOutTradeNo，PEM 自动补齐）；`POST /api/payment/create`（鉴权→商品白名单→服务端定价→签名→返回 {action, params}）；`POST/GET /api/payment/notify`（验签→TRADE_SUCCESS→order_no 幂等→写 quota_package_order→ai_token_balance 叠加→返回文本 success/fail）；`GET /api/profile/purchases`。
- env/runtimeConfig：`MICROPAY_PID/PRIVATE_KEY/PUBLIC_KEY`、`RESEND_API_KEY`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`。
- D1：`quota_package_order` 表（order_no 唯一索引、amount 分、status pending/paid/closed/refunded）。

### 阶段 4：页面与验证
- `/profile` 页：token 余额展示、"购买加油包"弹窗（三档卡片 + wxpay/alipay 动态 form 跳转）、"购买记录"弹窗、API Key 配置表单（含"测试连接"调一次 /api/ai/chat 极短请求）。
- 首页改造：登录后进入，本地作品库列表（+云同步状态徽标）、上传生成流程（本地进度）、登录/登出入口。
- 验证：`pnpm typecheck`/`lint`；`pnpm dev` 全链路手测——注册（验证码）→ 登录双 tab → 生成世界（本地 + 中继扣费）→ 选角 → 回合 → 存盘点回滚 → 云端 push/pull 跨设备 → 购买流程（微支付沙箱/最小金额）→ 404/401 校验。旧数据兼容抽查。

### 风险与备注
- 并发扣费有竞态（先扣后查/乐观锁，MVP 可接受少量超卖）。
- 用户 key 加密仅防静态泄露；实际转发时服务器仍可见明文（转发必经之手），文档注明。
- 章节全文不进云端（作品库只同步生成结果），换设备重生成需重新上传 txt。
- 10 万 token 约等于 1~2 本 20 万字书的生成量，赠送额按产品决策可调常量。