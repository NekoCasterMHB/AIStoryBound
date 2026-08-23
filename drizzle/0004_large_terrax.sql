CREATE TABLE `quota_package_order` (
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
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_package_order_order_no_unique` ON `quota_package_order` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_order_user` ON `quota_package_order` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_order_status` ON `quota_package_order` (`status`);