## 需求墙功能实现计划

新增「需求墙」页面 `/demand`：游客可浏览，发起需求与点赞需登录，按点赞数排序（已实现的需求沉底）；主页新增入口区块，个人主页新增渐变横幅；管理端新增需求管理页（标记 待实现/开发中/已实现、删除）。

### 1. 数据层（两张新表）

**`server/db/schema.ts`**（放在 Skill 商城表之后，`timestamp_ms` 风格）：
- `featureRequests`：`id`(text pk)、`userId`(FK→user, cascade)、`title`、`desc`、`likeCount`(integer default 0 冗余计数)、`status`(text default 'open'：open=待实现 / in_progress=开发中 / done=已实现)、`createdAt`、`updatedAt`；索引 `idx_fr_status_likes(status, like_count)`
- `featureRequestLikes`：`id`、`requestId`(FK→featureRequests, cascade)、`userId`(FK→user, cascade)、`createdAt`；`uniqueIndex(request_id, user_id)` 保证一人一赞 + `index(user_id)`

**`drizzle/init.sql`**：文件末尾（skill_purchases 之后）追加两张 `CREATE TABLE IF NOT EXISTS`，末尾索引段追加 3 条索引（遵循"幂等、可重复执行"约定）。

**迁移**：执行 `pnpm db:migrate:local`（本地）+ `pnpm db:migrate:remote`（线上 D1）。

### 2. 共享类型 `shared/demand.ts`（新建）

- `DemandStatus = 'open' | 'in_progress' | 'done'`、`DEMAND_STATUS_LABELS`、徽章颜色映射
- `MAX_DEMAND_TITLE_CHARS = 60`、`MAX_DEMAND_DESC_CHARS = 500`
- `DemandItem` 接口（仿 StoreSkillSummary）：`{ id, title, desc, likeCount, status, liked(登录用户是否已赞), authorName, createdAt }`

### 3. API 端点

- **`server/api/demand/index.get.ts`**（公开）：仿 `store/skills.get.ts` —— leftJoin users 取 authorName，`orderBy(CASE WHEN status='done' THEN 1 ELSE 0 END, desc(likeCount), asc(createdAt))`；`getSessionUser` 可选登录，查询该用户的点赞集附加 `liked` 标记
- **`server/api/demand/index.post.ts`**（`requireUserId`）：手写校验 title/desc 长度（400 错误）；`db.batch` 原子插入需求（likeCount=1）+ 点赞记录，发布即自赞
- **`server/api/demand/[id]/like.post.ts`**（`requireUserId`）：先查需求存在（404）；toggle 逻辑——已赞则 `db.batch([delete 点赞, count-1])`，未赞则 `db.batch([insert 点赞, count+1])`，返回 `{ liked, likeCount }`（重新 select 实际值）
- **`server/api/admin/requests/[id]/status.post.ts`**（`requireAdmin`）：校验 status 枚举后更新
- **`server/api/admin/requests/[id]/delete.post.ts`**（`requireAdmin`）：删除需求（点赞级联清除）

### 4. 需求墙页面 `app/pages/demand.vue`（新建）

- `useHead({ title: 'AI SpankWorld · 需求墙' })`；仿 store/index.vue 结构（`mx-auto max-w-4xl` + 内联加载/空状态）
- 头部：标题「需求墙」+ 副标题说明规则（高赞需求优先实现）+「发起需求」UButton（点击先 `requireLogin()` 再开 UModal）
- 发起表单 UModal：UFormField + UInput（标题）+ UTextarea（描述）+ 字数上限提示，成功后新需求置顶
- 需求列表 UCard：标题 + 状态徽章（开发中=primary 软底 / 已实现=success 带勾）+ 描述 + 作者与时间 + 右侧点赞按钮（`i-lucide-thumbs-up`，已赞高亮 + 数字），点击 `requireLogin()` → POST like → 本地即时更新计数与高亮，无需整页刷新
- **`app/middleware/auth.global.ts`**：`PUBLIC_PREFIXES` 加入 `'/demand'`（游客可浏览）

### 5. 管理端 `app/pages/admin/requests.vue`（新建）

- `definePageMeta({ layout: 'admin', middleware: 'admin' })`，仿 admin/skills.vue 风格
- 表格列出全部需求（标题/作者/点赞数/状态/时间）：每行状态用 UDropdownMenu 三态切换（调用 status API，toast 反馈）；「删除」按钮带确认 UModal
- `app/layouts/admin.vue`：侧边导航加「需求管理」条目

### 6. 入口

- **主页**：新建 `app/components/landing/LandingDemandWall.vue` 区块 —— 标题（「想让我们做什么」）+ 拉取 `GET /api/demand` 前 3 条高赞需求展示（失败静默降级）+「去需求墙提需求」UButton；插入 `app/pages/index.vue`（LandingFeatured 与 LandingFeatures 之间）
- **个人主页**：`app/pages/profile.vue` 页面标题栏与「余额与加油包」卡片之间插入渐变横幅 UCard（仿 LandingCta 的 `from-primary-500/10` 渐变风格）：文案「想让我们做什么?去需求墙提需求,高赞的会优先实现」+ `to="/demand"` 按钮
- **页脚**：`app/layouts/default.vue`「开始使用」链接列追加「需求墙」`NuxtLink to="/demand"`

### 7. 验证

`pnpm dev` 本地跑通完整流程（游客浏览 → 登录发起 → 登录点赞/取消 → 管理端标记状态与删除），运行类型检查与构建确保无 TS 错误。