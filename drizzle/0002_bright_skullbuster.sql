CREATE TABLE `preset_novels` (
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
--> statement-breakpoint
CREATE INDEX `idx_preset_featured` ON `preset_novels` (`featured`,`sort_order`);