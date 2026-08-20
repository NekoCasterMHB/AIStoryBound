CREATE TABLE `jobs` (
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
--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `novel_chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text,
	`idx` integer,
	`title` text,
	`content` text,
	`char_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `idx_chapters_novel` ON `novel_chapters` (`novel_id`);--> statement-breakpoint
CREATE TABLE `novels` (
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
--> statement-breakpoint
CREATE INDEX `idx_novels_user` ON `novels` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`password` text,
	`display_name` text,
	`created_at` text NOT NULL
);
