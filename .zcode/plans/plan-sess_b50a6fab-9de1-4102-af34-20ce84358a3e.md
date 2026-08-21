## 目标

把上传页与规划 §5.1/§6 对齐，补齐两条缺失能力：

1. **详细人物卡**：LLM 生成的不再是一行简介，而是带性格/外貌/背景/能力/目标/恐惧/秘密/人物关系等的完整人物卡，前端以卡片形式展示。
2. **流式实时 token 消费显示**：生成改为 SSE 流式输出，解析进度 + 生成期间 token 计数实时滚动上涨并显示消耗速度（tokens/秒），结束后展示真实总消耗。

## 改动清单

### 1. `shared/novel.ts`（新增共享类型）
- `CharacterCard`：name / alias / gender / age / identity / role / appearance / personality[] / speech_style[] / background / abilities[] / goals[] / fears[] / secrets[] / relationships[{name,type,value}] / first_appearance / dead。
- `WorldOverlay`：title / genre / summary / characters: CharacterCard[]。
- `TokenUsage`：promptTokens / completionTokens / totalTokens。
- `UploadSseEvent` 联合类型：`progress | token | world | done | error`，供前端解析。

### 2. `server/utils/ai.ts`（AI 网关）
- `ChatOptions` 增加 `streamOptions?: { include_usage?: boolean }`，`streamChat` 透传到请求体 `stream_options`，让流末尾能带真实 usage。
- 新增 `consumeChatStream(res, { onDelta, onUsage, onDone })`：解析上游 SSE `data:` 行，累计文本、识别末尾 usage 分片，供复用（后续 MVP-1 对话流式也会用到）。

### 3. `server/api/novels/index.post.ts`（上传→生成 改为 SSE 流式）
- 保留：multipart 解析文件 → `parseNovelBytes` → 建记录 → 章节目入库。
- 扩展 schema：人物卡字段对齐 `CharacterCard`，`maxTokens` 由 1200 提到 ~3200，约 5~8 个关键角色。
- 改为返回 `text/event-stream`：
  - 解析/入库完成 → 发 `progress`（阶段化真实进度，替代前端假进度）。
  - `streamChat(json:true, streamOptions:{include_usage:true})` 流式生成；聚合分片，节流发 `token` 事件（当前累计估算 token ≈ 字符数/1.7、耗时、tokens/秒）。
  - 流结束 → `extractJson` 解析 world_state → 写库（title/chapter_count/status/world_state）→ 发 `world` + `done`（附真实 usage）。若流式 JSON 解析失败，兜底一次非流式 `structuredOutput` 重试（可拿到真实 usage）。
  - include_usage 被服务商拒绝时，自动去掉 `stream_options` 重试一次；此时最终用量用估算值兜底。
  - 出错 → 标记 failed + 发 `error` 事件。

### 4. `app/pages/index.vue`（前端：流式消费 + 人物卡 UI）
- `upload()` 改用原生 `fetch` + `ReadableStream` 读取 SSE（`TextDecoder{stream:true}`，按 `\n\n` 分块解析事件；不再用 `useFetch` + 二次 GET）。
- 新增实时状态：token 计数、tokens/秒、耗时、最终 usage；生成期间显示"已消耗 ≈ N tokens · X tokens/s"。
- 结果区改用**人物卡**：头像占位（取姓名首字）+ 姓名 + 身份/性别/年龄 + 性格标签 chips，按非空分节展示 外貌/背景/能力/目标/恐惧/秘密/人物关系/首次登场/死亡状态，网格布局。
- 结束追加一行：总消耗（prompt/completion/total）与耗时。

### 5. 验证
- `pnpm typecheck` 通过；`pnpm dev` 本地上传 TXT，确认 token 计数实时跳动、人物卡完整渲染、结束显示真实 usage。

## 说明
- 不碰数据库 schema（`world_state` 仍是 JSON 文本列，结构升级即可，老数据为空时前端做兼容占位）。
- 保留 `server/api/novels/[id].get.ts` 不动；前端不再依赖它的二次 GET（world 直接走 SSE）。
- `deepseek-v4-flash` 是否支持 `stream_options.include_usage` 未知，已做降级兜底，不会因此中断整个流程。