## 目标

平台 AI 模型配置从「环境变量直读」改为「管理员后台多套配置 + 动态切换」，存 D1、切换即时生效。apiKey 采用 **AES-GCM 加密存储**（复用现有 `server/utils/crypto.ts`，密钥由必填的 `BETTER_AUTH_SECRET` 经 HKDF 派生，不新增环境变量）。未配置库内配置时回退环境变量（现有行为不变，平滑迁移）。

## 数据层（`server/db/schema.ts` + `drizzle/init.sql`）

新表 `ai_provider_configs`（幂等 CREATE TABLE IF NOT EXISTS）：
- `id` text PK（uuid）
- `name` text notNull（展示名，如「DeepSeek 主用」）
- `format` text notNull default 'chat'（chat / anthropic / responses，复用 `shared/ai-config.ts` 的 `AiApiFormat` 与 `isAiApiFormat` 校验）
- `baseUrl` text notNull
- `apiKeyCiphertext` text notNull / `apiKeyIv` text notNull（AES-256-GCM，用现有 crypto.ts）
- `apiKeyHint` text notNull（明文存后 4 位，列表展示用，接口不返回密文）
- `model` text notNull
- `active` integer notNull default 0（全局至多一条为 1）
- `createdAt` / `updatedAt` timestamp_ms

## 服务端

1. **`server/utils/ai.ts`**：`getAiConfig(event)` 改 async——先查 D1 `active=1` 配置并解密 apiKey（crypto.ts 的 `decryptJson`），命中则返回（含 `format`、`name`、`source: 'db'`）；未命中回退现有环境变量逻辑（`source: 'env'`）。调用点仅 2 处，一并改 await。

2. **新增 `/api/admin/ai-config/`**（全部 `requireAdmin`，文件组织仿 `server/api/admin/redeem/*`）：
   - `list.get.ts`：配置列表（apiKeyHint 显示）+ 当前生效配置与来源（db/env）
   - `create.post.ts`：校验（`isAiApiFormat`、baseUrl http(s) 正则、apiKey/model 必填），加密后落库；首条配置自动置 active
   - `test.post.ts`：复用 `ai-relay.ts` 的 `testRelay`；传 `id` 时合并已存配置，apiKey 留空则用已存
   - `[id].put.ts`：更新；apiKey 留空 = 保持原密文不变；提供新 key 则重新加密
   - `[id].delete.ts`：删除；若删的是启用配置，自动激活剩余第一条（没有则回退 env）
   - `[id]/activate.put.ts`：事务内切换（目标行 active=1，其余置 0）

3. **`server/api/ai/chat.post.ts`**：平台模式改用 `getAiConfig` 返回的 `format`（不再硬编码 'chat'）；未配置时错误文案改为「请管理员在后台配置 AI」。

4. **`server/api/admin/dashboard.get.ts`**：余额查询基于当前生效配置，仅 baseUrl 主机含 `deepseek` 时调 `/user/balance`（其他供应商返回「非 DeepSeek 接口」说明）；返回值附带 `aiConfig: { name, source }`。

## 前端

5. **新增 `app/pages/admin/ai-config.vue`**（`layout: 'admin'` + `middleware: 'admin'`）：
   - 顶部「当前生效」卡片：配置名 + 来源（库内配置 / 环境变量兜底）+「新建配置」按钮
   - 配置列表：名称、格式、baseUrl、模型、key 后 4 位、启用徽标；行操作：「启用」（即时切换）、「测试连接」、「编辑」、「删除」（UModal 确认）
   - 新建/编辑共用一个 UModal 表单：格式下拉复用 `AI_API_FORMATS` 元数据、baseUrl/apiKey/model 输入（交互对齐 profile.vue 个人中心自建配置表单），表单内「测试连接」按钮
6. **`app/layouts/admin.vue`**：侧边栏加「AI 配置」（`i-lucide-bot`）
7. **`app/pages/admin/index.vue`**：DeepSeek 余额卡片显示当前生效配置名

## 迁移与验证

8. 更新 `drizzle/init.sql` → `pnpm db:migrate:local` 验证迁移；`pnpm typecheck` + `pnpm lint` 通过；启动 dev 手工验证：管理员建配置 → 动态切换 → 聊天请求走新配置（含 format 非 chat 的供应商）。

## 性能说明

每次聊天请求多一次 D1 单行查询（约 5~20ms）+ 亚毫秒级解密，相对 LLM 流式响应可忽略；不做缓存，保证切换即时生效。