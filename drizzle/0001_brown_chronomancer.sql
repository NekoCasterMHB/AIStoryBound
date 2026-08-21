CREATE TABLE `game_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`idx` integer,
	`role` text,
	`speaker` text,
	`content` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_messages_game` ON `game_messages` (`game_id`);--> statement-breakpoint
CREATE TABLE `game_options` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`message_id` text,
	`idx` integer,
	`text` text,
	`effects` text
);
--> statement-breakpoint
CREATE INDEX `idx_options_game` ON `game_options` (`game_id`);--> statement-breakpoint
CREATE TABLE `games` (
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
--> statement-breakpoint
CREATE INDEX `idx_games_user` ON `games` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_games_novel` ON `games` (`novel_id`);--> statement-breakpoint
CREATE TABLE `saves` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`name` text,
	`snapshot` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_saves_game` ON `saves` (`game_id`);