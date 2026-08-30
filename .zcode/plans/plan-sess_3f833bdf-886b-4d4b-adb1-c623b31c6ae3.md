# 云端世界生成任务(R2 + Workflows + 共享缓存 + 自建 key 暂存)实现计划

## 目标与决策(已与用户确认)

1. 上传 txt 的世界生成**完全在云端执行**:原文上传 R2,客户端只展示进度、接收结果;成书后 world json 存 R2 并记录消耗总 token,提供 zip 下载。
2. 书架显示任务进度条;下载后自动安装到本地 IndexedDB。
3. 按 txt 内容哈希去重:其他用户上传相同 txt 时提供「拉取已有世界(扣记录消耗的一半)」或「重新生成(正常流程,完成后更新缓存)」。
4. 执行架构:**Cloudflare Workflows**(每个提取单元一个可重试 step,自动断点续跑)。
5. 云端生成是**唯一上传路径**,且**支持用户自建 key**:任务创建时客户端把浏览器本地已验证的自建配置上送,服务端 AES-256-GCM 加密暂存(`server/utils/crypto.ts` 的 `encryptJson`,现成),任务结束即删除;用自建 key 跑的任务**不扣平台 token**(结构保证,同 chat 中继),只记录消耗。平台 key 任务走现有「预授权 + 多退少补」模式。

## 数据模型

### D1 新表(`server/db/schema.ts` + `pnpm db:generate` 迁移)

1. `world_gen_tasks` — 用户任务:
   `id`(uuid)、`user_id`、`created_at/updated_at`、
   `status: uploaded|running|completed|failed|cancelled`、
   `stage: parse|author|extract|merge|check|synthesize|done`、`stage_detail`(json:`{doneUnits,totalUnits}`)、
   `source_hash`(sha-256)、`source_key`(R2)、`file_size`、`title`、`encoding`、`mode: full|eco`、
   `estimated_tokens`(平台模式预授权额)、`tokens_used`(实耗累计,自建 key 任务也记录)、
   `key_ciphertext/key_iv`(自建 key 加密暂存,结束置 NULL)、
   `result_key`(world json 的 R2 key)、`error`、`warnings`
2. `world_gen_units` — 提取单元明细(断点续跑与幂等):`task_id` + `unit_index` 主键、`result`(json)、`tokens`。重跑时已完成单元直接读取跳过。
3. `world_cache` — 跨用户共享缓存,`(source_hash, mode)` 唯一:
   `id`、`source_hash`、`mode`、`file_size`、`title`、`author`、`world_key`(R2)、`tokens_used`(**记录消耗总 token**)、`downloads`、`created_by`、`created_at`
4. `ai_usage` 增加可空列 `task_id`(平台模式云端调用照常落账并关联)。

### R2 key(复用现有 bucket `aiword2world`,前缀区分)

- `world-gen/sources/<hash>.txt` — 原文(按 hash 去重,同一文件只存一份)
- `world-cache/<hash>-<mode>.json` — 成书结果(结构同 `public/worlds/*.json` v2:overlay/entities/storyline/conflicts)

### Zip 按需打包

不存 zip;`GET /api/world-gen/tasks/:id/download` 时服务端 fflate 现打包:`manifest.json + work.json(含正文)+ story.txt`,沿用 `aisb-share` 格式(SHARE_FORMAT/VERSION),客户端现有导入逻辑直接可用。

## 云端执行:Workflows

- 新增 `server/workflows/world-gen.ts` 导出 `WorldGenWorkflow`;`wrangler.toml` 加 `[[workflows]]` binding `WORLD_GEN`;跑 `npx wrangler types` 重新生成类型。
- 管线步骤抽到 `server/utils/world-gen-pipeline.ts`,每个单元函数幂等、进度写任务行,Workflow 的 `step.do()` 只是调用它们:
  1. R2 取 txt → `parseNovelBytes`(`server/utils/novel-parser.ts`,注释预留的服务端化在此落地)
  2. 作者识别(正则 + 复用 `/api/ai/search` 检索逻辑)
  3. `splitUnits` 切段 → 每单元一个 step(自动重试);进度 `{doneUnits,totalUnits}` 实时写任务行;已完成单元从 `world_gen_units` 读取跳过
  4. merge / check / synthesize / finalizeCards —— 全部复用 `shared/world-build.ts` 纯函数(与 `scripts/prebuild-presets.ts` 同一套)
  5. 成书 world json 写 R2 + `world_cache` upsert(ON CONFLICT 保留首条)+ 任务置 completed + 结算
  6. 每步前查任务行,`cancelled` 则提前终止;取消入口调 `env.WORLD_GEN.get(id).terminate()`
- **AI 调用**:新增 `server/utils/ai-call.ts` 非流式 JSON 调用,复用 `buildUpstreamRequest`/`relaySse`(`server/utils/ai-relay.ts`);配置解析函数同时支持平台(`getAiConfig('worldGen')` + 计费回调)与用户暂存 key(解密 `key_ciphertext` → RelayTarget,零扣费仅记账)两种模式。
- **计费**:平台模式创建时按 shared 估算函数原子预扣 `aiTokenBalance`(不足 402),每次调用实耗累加任务行 + 落 `ai_usage(task_id)`,任务终态按 `estimated - actual` 退差额;自建 key 模式只累计 `tokens_used`。
- **key 清理**:finalize / 失败 / 取消路径均把 key 列置 NULL;状态查询接口对「终态超过 1 小时仍有 key」的任务做兜底清除(防 workflow 被强杀残留)。
- **本地 dev 兜底**:`getPlatformProxy` 不支持 workflow binding 时(env.WORLD_GEN 缺失),上传端点回退为 `waitUntil` 内联顺序执行同一套管线函数(仅 dev 用),保证本地可跑。

## API(`server/api/world-gen/`)

- `POST /check` — `{hash, mode}`:返回缓存命中信息 `{title, author, tokensUsed, halfCost}` 供弹选择。
- `POST /upload` — multipart 上传原文 + `mode` + 可选自建配置(格式校验 + 指纹准入复用 `chat.post.ts` 逻辑 → `encryptJson` 暂存):服务端重算 sha-256、写 R2(按 hash 去重)、二次查缓存、预扣费、建任务行、启动 Workflow。
- `POST /pull` — `{cacheId}`:从下载者余额原子扣 `floor(记录消耗 / 2)`(不足 402,无论自建 key 与否都扣),为当前用户创建 `status=completed` 的任务记录,`downloads` +1。
- `GET /tasks`(用户任务列表)、`GET /tasks/:id`(进度轮询)、`DELETE /tasks/:id`(取消/删除)。
- `GET /tasks/:id/download` — 校验归属(pull 任务同样可下),R2 取 world json + 原文,fflate 打包返回。

## 前端

### `app/utils/worldGenCloud.ts`(新)

客户端封装:WebCrypto 算 sha-256 → check 查重 → XHR 上传(带上传进度)→ 轮询任务 → 完成后自动下载 zip → fflate 解压 → 安装进 IndexedDB `works`。`app/utils/shareZip.ts` 的 `importWorkFromZip` 抽出 `importWorkFromBytes(Uint8Array)` 供复用(works.vue 现有导入不变)。

### `app/pages/generate.vue`

- confirm 阶段:选文件即算 hash 查重;命中缓存弹选择卡片——「拉取已有世界(扣 ≈ 记录消耗的一半)」/「重新生成(预估 Y token)」;未命中显示原预估。上传正文的隐私提示文案。
- 「开始生成」统一走云端:上传 → 复用现有 stepper/进度条 UI(阶段映射沿用 15→80% extract 段逻辑),数据源从本地回调换成任务轮询;完成后自动安装并跳 `/play/<workId>`。
- 自建 key:沿用浏览器已保存的激活配置,创建任务时随请求上送暂存(前提是通过过个人中心指纹验证);任务运行期间 key 加密在云端,结束后立即删除。

### `app/pages/works.vue`(书架)

- 新增「云端生成任务」区块:进行中任务显示 **UProgress 进度条 + 阶段文案 + 实时 token 消耗**(存在活动任务时每 3s 轮询);完成任务显示记录消耗 token 与「下载安装」按钮;失败/取消显示错误与重试入口。安装后作品进入现有本地作品网格,任务卡可清理。

## 实施顺序

1. schema + 迁移(`pnpm db:generate`)
2. `shared/world-gen-task.ts` 类型 + 估算函数下沉 shared
3. `server/utils/ai-call.ts` + `world-gen-pipeline.ts`(计费/进度/R2 IO/key 解密)
4. Workflow 类 + wrangler.toml + `npx wrangler types` + dev 内联兜底
5. API 端点 6 个
6. `shareZip.ts` 重构 + `worldGenCloud.ts` 客户端封装
7. generate.vue 改造(查重选择 + 云端模式)
8. works.vue 云端任务区块 + 进度条
9. 本地 dev(内联兜底)验证 + 部署后跑一轮完整真实任务

## 风险与说明

- Workflows 在本地 dev(miniflare)的支持不确定,已设计内联回退;最终验证需部署到 Workers。
- 自建 key 暂存的安全边界:服务端执行期间必然接触明文 key(与现有 chat 中继一致),暂存仅防静态泄露;任务结束即删,页面会向用户明确提示这一点。
- 共享缓存意味着同 txt 的其他用户可拉取成书结果(即需求本身);成书 json 不含原文,原文仅随个人 zip 下载。