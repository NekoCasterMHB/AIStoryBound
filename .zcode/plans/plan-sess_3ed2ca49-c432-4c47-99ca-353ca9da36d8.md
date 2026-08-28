## 公告系统实现计划

**核心逻辑**:服务端存公告(D1),客户端弹 Nuxt UI 模态框;localStorage 存"已读游标"(用户看到的最近一条公告的 createdAt),用户勾选"有新公告前不再提示"后写入游标;之后仅当出现 createdAt 更大的新公告时才再次弹出。

### 1. 数据层
- **`server/db/schema.ts`**:新增 `announcements` 表(参照 `featureRequests` 风格):`id`(text uuid)、`title`(text)、`content`(text,支持 markdown)、`published`(integer 0/1 默认 1)、`createdAt`/`updatedAt`(integer timestamp_ms),索引 `idx_ann_published_created`
- **`drizzle/init.sql`**:追加 `CREATE TABLE IF NOT EXISTS announcements` + 索引(项目约定手工维护迁移,不用 drizzle-kit generate)
- **`shared/announcement.ts`**(新):`AnnouncementItem` / `AnnouncementInput` 类型 + `normalizeAnnouncementInput` 校验(参照 `shared/demand.ts`)

### 2. 服务端 API(5 个)
- `server/api/announcements/index.get.ts`(公开):已发布公告列表,按 createdAt 倒序,无分页(量少)
- `server/api/admin/announcements/index.get.ts`:全部公告(含未发布),第一行 `requireAdmin`
- `server/api/admin/announcements/index.post.ts`:新建,`requireAdmin` + 校验,返回 `{ ok: true }`
- `server/api/admin/announcements/[id].put.ts`:更新
- `server/api/admin/announcements/[id].delete.ts`:删除
- 遵循现有约定:裸数据返回、`createError` 抛错、`useD1(event)`、`uuid()` 生成 id

### 3. 前端弹窗(折叠手风琴)
- **`app/utils/announcementRead.ts`**(新):localStorage 封装(参照 `adultMode.ts` 模式,KEY `announcement-read-until`,SSR 守卫 + try/catch),`getReadUntil()` / `setReadUntil(ts)`
- **`app/components/AnnouncementModal.vue`**(新):`<UModal>`(标题"公告",`sm:max-w-lg` scrollable)
  - `onMounted` 时 `$fetch('/api/announcements')`,过滤 `createdAt > readUntil` 得到未读列表,非空则弹出
  - body 用 **`UAccordion`** 折叠手风琴:每条未读公告一项,label 为「日期 · 标题」,**默认展开最新一条**,旧公告点击展开;内容区用 `<MDC>` 渲染 markdown(参照管理端 Skill 文档预览用法)
  - footer:`UCheckbox`「有新公告前不再提示」+ `UButton`「知道了」
  - 交互:勾选后关闭 → `setReadUntil(最新公告.createdAt)`(永久不再提示);不勾选直接关闭 → 本次会话不再自动弹(内存标记),刷新后仍会提示
- **`app/app.vue`**(改):`UApp` 内挂 `<AnnouncementModal />`,全站生效

### 4. 管理后台
- **`app/pages/admin/announcements.vue`**(新):参照 `ai-config.vue` CRUD 模式 + 手写表格(标题/发布状态/创建时间/操作列)
  - 新建/编辑 `UModal`:标题 `UInput` + 内容 `UTextarea`(提示支持 markdown)+ 发布 `USwitch`
  - 删除确认 `UModal`;`$fetch` + `onMounted` 加载;错误用 `useToast()`
- **`app/layouts/admin.vue`**(改):侧边栏 items 加「公告管理」(icon `i-lucide-megaphone`,`/admin/announcements`)

### 5. 验证
- `pnpm db:migrate:local` 应用迁移,`pnpm typecheck` + eslint
- curl 验证公开/管理 API(本地 dev server 4569)
- 浏览器验证:发布一条公告 → 弹窗出现 → 勾选不再提示 → 刷新不弹 → 再发一条新公告 → 再次弹出
- 若 dev server 正在运行,结束后保持运行(按全局约定)