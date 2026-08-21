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
}, (t) => [index('idx_games_user').on(t.userId), index('idx_games_novel').on(t.novelId)])

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
}, (t) => [index('idx_messages_game').on(t.gameId)])

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
}, (t) => [index('idx_options_game').on(t.gameId)])

// ---- 存档快照 ----
export const saves = sqliteTable('saves', {
  id: text('id').primaryKey(),
  gameId: text('game_id'),
  name: text('name'),
  /** JSON 快照:{ state, currentChapter, summary, lastMessageIdx, createdAt } */
  snapshot: text('snapshot'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, (t) => [index('idx_saves_game').on(t.gameId)])

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
