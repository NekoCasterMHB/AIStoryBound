// server/db/schema.ts
// Drizzle ORM schema(SQLite / Cloudflare D1 方言)
// NuxtHub 以此生成迁移(server/db/migrations/*.sql)与类型
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ---- 用户 ----
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  password: text('password'),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
})

// ---- Better Auth 核心表(登录/会话/验证码;user 表附带平台 AI 配额与用户自建 AI 配置) ----
// 时间列用 integer timestamp_ms:better-auth 适配器传 Date 对象,Drizzle 负责 Date↔毫秒转换(D1 兼容)。
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified').notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  /** 平台 AI 配额余额(token 数;注册赠送 FREE_TOKEN_GRANT,加油包叠加) */
  aiTokenBalance: integer('ai_token_balance').notNull().default(0),
  /** 用户自建 AI 配置:1=启用(中继走用户 key,不扣平台配额) */
  aiConfigEnabled: integer('ai_config_enabled').notNull().default(0),
  /** AES-GCM 加密后的 AI 配置 JSON(baseUrl/apiKey/model/thinking) */
  aiConfigCiphertext: text('ai_config_ciphertext'),
  aiConfigIv: text('ai_config_iv'),
  // ---- 生成参数(个人中心「生成参数」卡片;null=未设置,运行时取默认值,见 shared/gen-limits) ----
  genUnitMaxChars: integer('gen_unit_max_chars'),
  genUnitOverlapChars: integer('gen_unit_overlap_chars'),
  genExtractMaxTokens: integer('gen_extract_max_tokens'),
  genCheckMaxTokens: integer('gen_check_max_tokens'),
  genSynthMaxTokens: integer('gen_synth_max_tokens'),
  genRelayTimeoutSec: integer('gen_relay_timeout_sec')
}, t => [index('idx_user_email').on(t.email)])

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, t => [index('idx_session_token').on(t.token), index('idx_session_user').on(t.userId)])

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  /** 提供方标识(OAuth issuer,emailAndPassword 场景为空) */
  issuer: text('issuer'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, t => [index('idx_verification_identifier').on(t.identifier)])

// ---- Token 加油包订单(微支付网关;order_no 唯一约束=幂等键) ----
export const quotaPackageOrder = sqliteTable('quota_package_order', {
  id: text('id').primaryKey(),
  /** 商户订单号(网关幂等键,唯一) */
  orderNo: text('order_no').notNull().unique(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  packageId: text('package_id').notNull(),
  packageName: text('package_name').notNull(),
  /** 金额(分,整数存储避免浮点误差) */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CNY'),
  /** wxpay / alipay / unknown */
  provider: text('provider').notNull().default('unknown'),
  providerTradeNo: text('provider_trade_no'),
  /** pending | paid | closed | refunded */
  status: text('status').notNull().default('pending'),
  paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
  refundedAt: integer('refunded_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, t => [
  index('idx_order_user').on(t.userId),
  index('idx_order_status').on(t.status)
])

// ---- 兑换码(仅管理员可生成,用户兑换得 token;见 /admin 管理页与 /api/redeem) ----
export const redeemCodes = sqliteTable('redeem_codes', {
  id: text('id').primaryKey(),
  /** 大写字母数字码(去易混淆字符,32 字符空间,不可暴力枚举) */
  code: text('code').notNull().unique(),
  /** 兑换可得 token 数 */
  tokens: integer('tokens').notNull(),
  /** 总用量上限,null=不限 */
  maxUses: integer('max_uses'),
  /** 每人限用次数(1=活动码每人限领一次) */
  perUserLimit: integer('per_user_limit').notNull().default(1),
  /** 已兑换次数 */
  usedCount: integer('used_count').notNull().default(0),
  /** 1=停用(码泄露时封禁,不再可兑换) */
  disabled: integer('disabled').notNull().default(0),
  /** 过期时间,null=永不过期 */
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
})

// ---- 兑换记录(每人每次兑换一条;支撑每人限次校验与管理页明细) ----
export const redeemCodeRedemptions = sqliteTable('redeem_code_redemptions', {
  id: text('id').primaryKey(),
  codeId: text('code_id').notNull().references(() => redeemCodes.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** 入账 token 数(冗余快照) */
  tokens: integer('tokens').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, t => [
  index('idx_redemption_code').on(t.codeId),
  index('idx_redemption_user').on(t.userId)
])

// ---- Skill 商城商品(zip 存 R2,见 wrangler.toml SKILL_FILES 绑定;购买拆账 80/20) ----
export const skillProducts = sqliteTable('skill_products', {
  id: text('id').primaryKey(),
  /** 发布者 */
  sellerId: text('seller_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** 展示名称 */
  name: text('name').notNull(),
  /** 说明文(商城卡片展示) */
  desc: text('desc').notNull(),
  /** 售价(token,正整数) */
  price: integer('price').notNull(),
  /** R2 key: skills/<sellerId>/<id>.zip */
  fileKey: text('file_key').notNull(),
  /** 上传的原始文件名(下载时回填) */
  fileName: text('file_name').notNull(),
  /** 字节数 */
  fileSize: integer('file_size').notNull(),
  /** JSON:zip 内文件清单(上传时解析,管理端预览) */
  fileEntries: text('file_entries'),
  /** pending=待审核 | approved=已上架 | rejected=已拒绝 | removed=已下架 */
  status: text('status').notNull().default('pending'),
  /** 审核驳回原因 */
  rejectReason: text('reject_reason'),
  /** 1=平台推荐(优质 skill 推荐标识) */
  featured: integer('featured').notNull().default(0),
  downloadCount: integer('download_count').notNull().default(0),
  purchaseCount: integer('purchase_count').notNull().default(0),
  reviewedBy: text('reviewed_by').references(() => user.id),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, t => [
  index('idx_skill_seller').on(t.sellerId),
  index('idx_skill_status').on(t.status, t.featured)
])

// ---- Skill 版本(每次发布/更新生成一条;审核、购买锁定与下载都以版本为准) ----
export const skillProductVersions = sqliteTable('skill_product_versions', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull().references(() => skillProducts.id, { onDelete: 'cascade' }),
  /** 版本号,从 1 自动递增 */
  version: integer('version').notNull(),
  /** 本次提交的名称/说明/售价快照(审核通过后同步到主表) */
  name: text('name').notNull(),
  desc: text('desc').notNull(),
  price: integer('price').notNull(),
  /** R2 key(每个版本独立文件,不覆盖) */
  fileKey: text('file_key').notNull(),
  /** 上传的原始文件名(下载时回填) */
  fileName: text('file_name').notNull(),
  /** 字节数 */
  fileSize: integer('file_size').notNull(),
  /** JSON:zip 内文件清单(上传时解析,管理端预览) */
  fileEntries: text('file_entries'),
  /** pending=待审核 | approved=已上架 | rejected=已拒绝(版本级状态) */
  status: text('status').notNull().default('pending'),
  /** 审核驳回原因 */
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by').references(() => user.id),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, t => [
  uniqueIndex('idx_skill_version_unique').on(t.skillId, t.version),
  index('idx_skill_version_status').on(t.skillId, t.status)
])

// ---- Skill 购买记录(唯一(skill, buyer)= 一次购买永久可下载,不可重购) ----
export const skillPurchases = sqliteTable('skill_purchases', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull().references(() => skillProducts.id, { onDelete: 'cascade' }),
  buyerId: text('buyer_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** 成交价快照(token) */
  price: integer('price').notNull(),
  /** 发布者所得(售价 80%,round 取整) */
  sellerShare: integer('seller_share').notNull(),
  /** 平台手续费(售价 20%) */
  platformFee: integer('platform_fee').notNull(),
  /** 购买时锁定的版本记录 id(旧数据为 null 时回退 v1) */
  skillVersionId: text('skill_version_id').references(() => skillProductVersions.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, t => [
  uniqueIndex('idx_skill_purchase_unique').on(t.skillId, t.buyerId),
  index('idx_skill_purchase_buyer').on(t.buyerId)
])

// ---- 小说 ----
export const novels = sqliteTable('novels', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  title: text('title'),
  author: text('author'),
  sourceFormat: text('source_format').default('txt'),
  storageKey: text('storage_key'), // R2 key: novels/<userId>/<id>.txt
  encoding: text('encoding'),
  chapterCount: integer('chapter_count').default(0),
  status: text('status').default('uploaded'), // uploaded|parsing|ready|failed
  parseProgress: integer('parse_progress').default(0),
  worldState: text('world_state'), // JSON
  error: text('error'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, t => [index('idx_novels_user').on(t.userId)])

// ---- 预置小说(平台推荐内容,正文静态部署于 public/txt/,此表存索引与元数据;见主页推荐列表) ----
export const presetNovels = sqliteTable('preset_novels', {
  id: text('id').primaryKey(), // 文件名去扩展名为 id
  title: text('title'),
  author: text('author'),
  genre: text('genre'),
  /** 推荐语/简介(卡片展示) */
  description: text('description'),
  /** 封面视觉:emoji */
  coverEmoji: text('cover_emoji'),
  /** 静态资源路径约定: txt/<id>.txt(下载接口据此直读 public/txt/) */
  storageKey: text('storage_key'),
  encoding: text('encoding').default('utf-8'),
  chapterCount: integer('chapter_count').default(0),
  charCount: integer('char_count').default(0),
  /** 1=首页推荐 */
  featured: integer('featured').default(1),
  sortOrder: integer('sort_order').default(0),
  downloadCount: integer('download_count').default(0),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, t => [index('idx_preset_featured').on(t.featured, t.sortOrder)])

// ---- 章节 ----
export const novelChapters = sqliteTable('novel_chapters', {
  id: text('id').primaryKey(),
  novelId: text('novel_id'),
  idx: integer('idx'),
  title: text('title'),
  content: text('content'),
  charCount: integer('char_count').default(0)
}, t => [index('idx_chapters_novel').on(t.novelId)])

// ---- 游戏会话(用户选定角色后创建,见 MVP-1 1.5/1.6) ----
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  novelId: text('novel_id'),
  userId: text('user_id'),
  /** 玩家选择的角色(原著角色模式,暂用角色名作为 id,后续可接 character_id) */
  playerCharacterId: text('player_character_id'),
  playerCharacterName: text('player_character_name'),
  /** 游戏模式:canonical=原著角色 */
  mode: text('mode').default('canonical'),
  /** 当前所处原著章节(剧情推进后更新) */
  currentChapter: text('current_chapter'),
  /** active | ended */
  status: text('status').default('active'),
  /** 滚动摘要(防止长对话失忆,每回合由 AI 压缩追加) */
  summary: text('summary'),
  /** 游戏公开状态 + AI 内部状态(JSON,见 shared GameState) */
  state: text('state'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
}, t => [index('idx_games_user').on(t.userId), index('idx_games_novel').on(t.novelId)])

// ---- 游戏消息流(旁白/角色台词/玩家/系统) ----
export const gameMessages = sqliteTable('game_messages', {
  id: text('id').primaryKey(),
  gameId: text('game_id'),
  idx: integer('idx'),
  /** narrator=旁白/剧情, character=角色台词, user=玩家, system=系统 */
  role: text('role'),
  /** role=character 时的角色名 */
  speaker: text('speaker'),
  content: text('content'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, t => [index('idx_messages_game').on(t.gameId)])

// ---- 每轮 AI 生成的选项(渲染成按钮,记录所属消息以便回滚/重 roll) ----
export const gameOptions = sqliteTable('game_options', {
  id: text('id').primaryKey(),
  gameId: text('game_id'),
  /** 属于哪条剧情/对话消息(idx 顺序) */
  messageId: text('message_id'),
  idx: integer('idx'),
  text: text('text'),
  /** JSON 效果声明(轻量引擎校验用,预留) */
  effects: text('effects')
}, t => [index('idx_options_game').on(t.gameId)])

// ---- 存档快照 ----
export const saves = sqliteTable('saves', {
  id: text('id').primaryKey(),
  gameId: text('game_id'),
  name: text('name'),
  /** JSON 快照:{ state, currentChapter, summary, lastMessageIdx, createdAt } */
  snapshot: text('snapshot'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, t => [index('idx_saves_game').on(t.gameId)])

// ---- 解析任务 ----
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // novel_parse | ...
  payload: text('payload'), // JSON
  status: text('status').default('queued'), // queued|running|done|failed
  progress: integer('progress').default(0),
  error: text('error'),
  result: text('result'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
}, t => [index('idx_jobs_status').on(t.status)])
