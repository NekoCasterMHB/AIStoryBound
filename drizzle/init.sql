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

-- ---- Skill 商城商品(zip 存 R2 SKILL_FILES;购买拆账 80/20,见 shared/store-skill.ts) ----
CREATE TABLE IF NOT EXISTS `skill_products` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`name` text NOT NULL,
	`desc` text NOT NULL,
	`price` integer NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`file_entries` text,
	`icon` text,
	`tags` text,
	`readme` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text,
	`main_version` integer,
	`featured` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`purchase_count` integer DEFAULT 0 NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);

-- ---- Skill 版本(每次发布/更新生成一条;审核、购买锁定与下载都以版本为准;旧数据由一次性
--      INSERT ... SELECT 从 skill_products 回填为 v1,见版本管理迁移说明) ----
CREATE TABLE IF NOT EXISTS `skill_product_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`desc` text NOT NULL,
	`price` integer NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`file_entries` text,
	`icon` text,
	`tags` text,
	`readme` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skill_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);

-- ---- Skill 购买记录(唯一(skill_id,buyer_id)= 一次购买永久可下载,不可重购) ----
-- 运行中库需一次性补列:ALTER TABLE skill_purchases ADD COLUMN skill_version_id text
CREATE TABLE IF NOT EXISTS `skill_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`price` integer NOT NULL,
	`seller_share` integer NOT NULL,
	`platform_fee` integer NOT NULL,
	`skill_version_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skill_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buyer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 需求墙(用户提交功能需求并按点赞数排序,高赞优先实现) ----
CREATE TABLE IF NOT EXISTS `feature_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`desc` text NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 需求点赞记录(唯一(request_id,user_id)= 一人一赞,可取消) ----
CREATE TABLE IF NOT EXISTS `feature_request_likes` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `feature_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ---- 站点配置(key-value,运行时管理,无需重新部署;见 server/utils/config.ts) ----
CREATE TABLE IF NOT EXISTS `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);

-- ---- AI 用量记录(平台模式每次扣费写一条;管理仪表盘统计近 24h 消耗) ----
CREATE TABLE IF NOT EXISTS `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tokens` integer NOT NULL,
	`prompt_tokens` integer NOT NULL DEFAULT 0,
	`completion_tokens` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE UNIQUE INDEX IF NOT EXISTS `idx_skill_version_unique` ON `skill_product_versions` (`skill_id`,`version`);
CREATE INDEX IF NOT EXISTS `idx_skill_version_status` ON `skill_product_versions` (`skill_id`,`status`);
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
CREATE INDEX IF NOT EXISTS `idx_skill_seller` ON `skill_products` (`seller_id`);
CREATE INDEX IF NOT EXISTS `idx_skill_status` ON `skill_products` (`status`,`featured`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_skill_purchase_unique` ON `skill_purchases` (`skill_id`,`buyer_id`);
CREATE INDEX IF NOT EXISTS `idx_fr_status_likes` ON `feature_requests` (`status`,`like_count`);
CREATE INDEX IF NOT EXISTS `idx_fr_user` ON `feature_requests` (`user_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_frl_unique` ON `feature_request_likes` (`request_id`,`user_id`);
CREATE INDEX IF NOT EXISTS `idx_frl_user` ON `feature_request_likes` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_ai_usage_time` ON `ai_usage` (`created_at`);
CREATE INDEX IF NOT EXISTS `idx_ai_usage_user` ON `ai_usage` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_skill_purchase_buyer` ON `skill_purchases` (`buyer_id`);