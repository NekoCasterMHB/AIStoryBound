-- drizzle/init.sql — 全量数据库初始化脚本(唯一迁移入口)
--
-- 由 server/db/schema.ts 维护,覆盖全部表与索引;所有语句幂等(IF NOT EXISTS),
-- 可对全新库执行,也可对已存在的库重复执行(自动补齐缺失的表/索引,不会破坏已有数据)。
-- 应用方式: pnpm db:migrate:local / pnpm db:migrate:remote(见 scripts/d1-migrate.mjs)
--
-- 后续 schema 变更约定:
--   1. 新表 / 新索引 → 直接加进本文件的 CREATE TABLE / CREATE INDEX(幂等,两端通用)。
--   2. 给已有表加列 → 同时改 CREATE TABLE 里的列定义(仅对全新库生效)与运行中库,
--      运行中库用一次性命令补列,例如:
--        wrangler d1 execute aiSpankWorld --remote --command "ALTER TABLE user ADD COLUMN xxx integer"
--      (不要把 ALTER 写进本文件,否则全新库会因列已存在而报错)

-- ---- 旧版账号表(早期 email+password 登录,已被 better-auth user 表取代,保留兼容) ----
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`password` text,
	`display_name` text,
	`created_at` text NOT NULL
);

-- ---- Better Auth 核心表(登录/会话/验证码;user 表附带平台 AI 配额、用户自建 AI 配置与生成参数) ----
CREATE TABLE IF NOT EXISTS `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ai_token_balance` integer DEFAULT 0 NOT NULL,
	`ai_config_enabled` integer DEFAULT 0 NOT NULL,
	`ai_config_ciphertext` text,
	`ai_config_iv` text,
	`gen_unit_max_chars` integer,
	`gen_unit_overlap_chars` integer,
	`gen_extract_max_tokens` integer,
	`gen_check_max_tokens` integer,
	`gen_synth_max_tokens` integer,
	`gen_relay_timeout_sec` integer
);

CREATE TABLE IF NOT EXISTS `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`issuer` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

-- ---- Token 加油包订单(微支付网关;order_no 唯一约束=幂等键) ----
CREATE TABLE IF NOT EXISTS `quota_package_order` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`user_id` text NOT NULL,
	`package_id` text NOT NULL,
	`package_name` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`provider` text DEFAULT 'unknown' NOT NULL,
	`provider_trade_no` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_at` integer,
	`refunded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 兑换码(仅管理员可生成,用户兑换得 token) ----
CREATE TABLE IF NOT EXISTS `redeem_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`tokens` integer NOT NULL,
	`max_uses` integer,
	`per_user_limit` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 兑换记录(每人每次兑换一条;支撑每人限次校验与管理页明细) ----
CREATE TABLE IF NOT EXISTS `redeem_code_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`code_id` text NOT NULL,
	`user_id` text NOT NULL,
	`tokens` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`code_id`) REFERENCES `redeem_codes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 小说 ----
CREATE TABLE IF NOT EXISTS `novels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`title` text,
	`author` text,
	`source_format` text DEFAULT 'txt',
	`storage_key` text,
	`encoding` text,
	`chapter_count` integer DEFAULT 0,
	`status` text DEFAULT 'uploaded',
	`parse_progress` integer DEFAULT 0,
	`world_state` text,
	`error` text,
	`created_at` text NOT NULL
);

-- ---- 预置小说(平台推荐内容,正文静态部署于 public/txt/,此表存索引与元数据) ----
CREATE TABLE IF NOT EXISTS `preset_novels` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`author` text,
	`genre` text,
	`description` text,
	`cover_emoji` text,
	`cover_color` text,
	`storage_key` text,
	`encoding` text DEFAULT 'utf-8',
	`chapter_count` integer DEFAULT 0,
	`char_count` integer DEFAULT 0,
	`featured` integer DEFAULT 1,
	`sort_order` integer DEFAULT 0,
	`download_count` integer DEFAULT 0,
	`created_at` text NOT NULL
);

-- ---- 章节 ----
CREATE TABLE IF NOT EXISTS `novel_chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text,
	`idx` integer,
	`title` text,
	`content` text,
	`char_count` integer DEFAULT 0
);

-- ---- 游戏会话(用户选定角色后创建) ----
CREATE TABLE IF NOT EXISTS `games` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text,
	`user_id` text,
	`player_character_id` text,
	`player_character_name` text,
	`mode` text DEFAULT 'canonical',
	`current_chapter` text,
	`status` text DEFAULT 'active',
	`summary` text,
	`state` text,
	`created_at` text NOT NULL,
	`updated_at` text
);

-- ---- 游戏消息流(旁白/角色台词/玩家/系统) ----
CREATE TABLE IF NOT EXISTS `game_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`idx` integer,
	`role` text,
	`speaker` text,
	`content` text,
	`created_at` text NOT NULL
);

-- ---- 每轮 AI 生成的选项 ----
CREATE TABLE IF NOT EXISTS `game_options` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`message_id` text,
	`idx` integer,
	`text` text,
	`effects` text
);

-- ---- 存档快照 ----
CREATE TABLE IF NOT EXISTS `saves` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`name` text,
	`snapshot` text,
	`created_at` text NOT NULL
);

-- ---- 解析任务 ----
CREATE TABLE IF NOT EXISTS `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'queued',
	`progress` integer DEFAULT 0,
	`error` text,
	`result` text,
	`created_at` text NOT NULL,
	`updated_at` text
);

-- ---- 索引 ----
CREATE UNIQUE INDEX IF NOT EXISTS `user_email_unique` ON `user` (`email`);
CREATE INDEX IF NOT EXISTS `idx_user_email` ON `user` (`email`);
CREATE UNIQUE INDEX IF NOT EXISTS `session_token_unique` ON `session` (`token`);
CREATE INDEX IF NOT EXISTS `idx_session_token` ON `session` (`token`);
CREATE INDEX IF NOT EXISTS `idx_session_user` ON `session` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_verification_identifier` ON `verification` (`identifier`);
CREATE UNIQUE INDEX IF NOT EXISTS `quota_package_order_order_no_unique` ON `quota_package_order` (`order_no`);
CREATE INDEX IF NOT EXISTS `idx_order_user` ON `quota_package_order` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_order_status` ON `quota_package_order` (`status`);
CREATE UNIQUE INDEX IF NOT EXISTS `redeem_codes_code_unique` ON `redeem_codes` (`code`);
CREATE INDEX IF NOT EXISTS `idx_redemption_code` ON `redeem_code_redemptions` (`code_id`);
CREATE INDEX IF NOT EXISTS `idx_redemption_user` ON `redeem_code_redemptions` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_novels_user` ON `novels` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_preset_featured` ON `preset_novels` (`featured`,`sort_order`);
CREATE INDEX IF NOT EXISTS `idx_chapters_novel` ON `novel_chapters` (`novel_id`);
CREATE INDEX IF NOT EXISTS `idx_games_user` ON `games` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_games_novel` ON `games` (`novel_id`);
CREATE INDEX IF NOT EXISTS `idx_messages_game` ON `game_messages` (`game_id`);
CREATE INDEX IF NOT EXISTS `idx_options_game` ON `game_options` (`game_id`);
CREATE INDEX IF NOT EXISTS `idx_saves_game` ON `saves` (`game_id`);
CREATE INDEX IF NOT EXISTS `idx_jobs_status` ON `jobs` (`status`);