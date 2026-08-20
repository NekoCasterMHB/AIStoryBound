// server/db/schema.ts
// Drizzle ORM schema(SQLite / Cloudflare D1 方言)
// NuxtHub 以此生成迁移(server/db/migrations/*.sql)与类型
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// ---- 用户 ----
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  password: text('password'),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
})

// ---- 小说 ----
export const novels = sqliteTable('novels', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  title: text('title'),
  author: text('author'),
  sourceFormat: text('source_format').default('txt'),
  storageKey: text('storage_key'),          // R2 key: novels/<userId>/<id>.txt
  encoding: text('encoding'),
  chapterCount: integer('chapter_count').default(0),
  status: text('status').default('uploaded'), // uploaded|parsing|ready|failed
  parseProgress: integer('parse_progress').default(0),
  worldState: text('world_state'),           // JSON
  error: text('error'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, (t) => [index('idx_novels_user').on(t.userId)])

// ---- 章节 ----
export const novelChapters = sqliteTable('novel_chapters', {
  id: text('id').primaryKey(),
  novelId: text('novel_id'),
  idx: integer('idx'),
  title: text('title'),
  content: text('content'),
  charCount: integer('char_count').default(0)
}, (t) => [index('idx_chapters_novel').on(t.novelId)])

// ---- 解析任务 ----
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                // novel_parse | ...
  payload: text('payload'),                    // JSON
  status: text('status').default('queued'),    // queued|running|done|failed
  progress: integer('progress').default(0),
  error: text('error'),
  result: text('result'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
}, (t) => [index('idx_jobs_status').on(t.status)])
