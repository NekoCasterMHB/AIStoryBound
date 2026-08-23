## 世界观生成流水线改造计划（单次截断 6 万字符 → 分章提取/合并/检查/成书）

### 目标
把 `generateNovelWorld` 目前"正文截断开头 6 万字符 → 单次调用输出 5~8 张人物卡"的做法，改造成四步流水线：**分章提取(Map) → 代码合并(Reduce) → 一致性检查 → 成书合成**。每章都被独立放进注意力中心处理，产出带原文引用与章节溯源的完整实体库；最终 `world_state` 保持向后兼容（title/genre/summary/characters 结构不变），游戏回合与前端零改动。对齐蓝图 §4.1 的 Novel Analyzer → World Builder(校验/合并) 与 `source_chapter`/`confidence` 溯源设计。

### 1. 共享类型（shared/novel.ts）
- 新增单章提取 schema：`ExtractedCharacter`（name/alias[]/gender/age/identity/appearance/personality[]/speech_style[]/background/abilities[]/goals[]/fears[]/secrets[]/relationships[{name,type}]/dead/quote）、`ExtractedLocation`、`ExtractedFaction`、`ExtractedTimelineEvent`、`ExtractedWorldRule`、`ExtractedItem`、`ExtractedForeshadow`，汇总为 `ChapterExtraction`（7 个数组字段）。
- 新增合并产物：`EntitySource { chapter, quote }`（章节号+原文引用，`source_chapter` 由代码附加，不依赖模型输出）；`MergedCharacter` 等实体 = 提取形态 + `sources: EntitySource[]` + `mention_count`；`WorldEntities` 汇总。
- 新增 `EntityConflict`：`id/entity_type/entity_name/field/value_a/value_b/evidence_a/evidence_b`（各含 chapter+quote）+ 检查后补充 `verdict`（later_wins|first_wins|uncertain|not_conflict）与 `reason`。
- `WorldOverlay` 增加可选 `entities?: WorldEntities`、`conflicts?: EntityConflict[]`（只增不减，向后兼容）。
- `UploadSseEvent.done` 增加可选 `warnings?: string[]`（生成中跳过的章节告警）。

### 2. 提取阶段（Map，novel-generation.ts）
- 常量：`EXTRACT_CONCURRENCY = 5`（并发池，上游限流是实际上限）；`UNIT_MAX_CHARS = 8000`（超长章节/未切开的连续文本按段落边界切段，一段一个提取单元，label 如 "第12章(段2)"。实测 docs/txt 存在 7.2 万字单块，切段是必须项）；`EXTRACT_MAX_TOKENS = 6000`；`TOP_CHARACTERS = 12`。
- **增量提取**：提示词要求"只输出本段有新信息量的条目；仅闪过无新信息的角色不列；已有信息不重复罗列"——压制每个单元的输出量（~2.5k token/章 → ~0.8k），总墙钟降 2~3 倍。去重交给代码合并阶段。
- **`AI_EXTRACT_MODEL` 环境变量**：Map 阶段指定快速/廉价模型（如 deepseek-flash 类，120~200 tok/s），`check`/`synthesize` 仍用主模型（`ai.ts` 已支持按调用覆盖 model，零架构改动）；未配置则与主模型一致。
- 新增 `EXTRACT_SCHEMA_HINT`：7 类实体；`world_rules`/`timeline_events`/`foreshadowing`/`items` 及人物的 `relationships` 强制 `quote`（原文逐字、≤80 字），其余字段不确定填 null/省略、禁止脑补；人物名用原文用名、别名进 alias 数组。
- 每单元 `structuredOutput`（temperature 0.2、thinking disabled、maxRetries 1、timeout 180s）+ `validate`（7 个数组必须存在、必填字段非空）。失败经重试仍失败 → 跳过该章记 `warnings`；失败单元 > 总数 1/3 → 整体失败走 error 事件。
- 每完成一个单元 push `progress`（stage 'extract'，45→75）与 `token` 事件（累计 usage 估算）。
- 单次调用上限的兜底逻辑（旧 `AI_CONTEXT_CHAR_LIMIT`/`buildAIContext`）删除。

### 3. 合并阶段（Reduce，纯代码，无 LLM）
- 名字规整：去空白；别名消歧：先扫全部 name+alias 建"别名 → 正名"映射，再按正名合并。
- 标量字段（gender/age/identity/appearance/background/dead 等）：首个非空为初值，后续不同值 → 记冲突（双证据带 chapter+quote）并按"**后文为准**"覆盖（递进事实如年龄/生死，后文更可信）。
- 数组字段（personality/speech_style/abilities/goals/fears/secrets）：规整字符串去重并集；`relationships` 按 (name,type) 并集。
- locations/factions/items/timeline_events/world_rules/foreshadowing 同规则，timeline 按事件文本去重合并。
- `mention_count` = 合并的原始记录数（成书挑选角色的依据）；`first_appearance` 由 `sources[0].chapter` 兜底。
- 产出 `WorldEntities` + `EntityConflict[]`（id=uuid）。

### 4. 一致性检查（单次小调用）
- 输入裁剪：实体**紧凑序列化**（值 + 出现的章节号列表，不带 quote）+ 冲突全量（带双证据 quote）。实体库小（几千 token），一次调用可容纳，不涉及全文。
- 输出 schema：`reviewed[{conflict_id, verdict, reason}]` + `new_conflicts[{entity_type, entity_name, field, evidence_a.chapter, evidence_b.chapter, verdict, reason}]`。
- `new_conflicts` 只回**章节号**，代码按 source 表回填引用文本（防模型传引用不可信）；模型传的章节号不在实体 source 内则置空。
- 未匹配到 id 的冲突保持原样（verdict='uncertain'）。AI 只标证据与倾向、不裁决，裁决策略=代码的"后文为准"。
- 批注结果合并回 `conflicts` 落盘。

### 5. 成书合成（单次调用）
- 输入：按 `mention_count` 取前 12 名角色的紧凑卡（含出现章节区间与引用）+ 其余实体统计 + 冲突摘要（前 N 条 verdict+reason）+ warnings。
- 沿用现有 `WORLD_SCHEMA_HINT`（title/genre/summary + 详细人物卡，含 patience/softness/relationships 数值等），只输入实体库信息、禁止脑补；`maxTokens` 提到 16000。
- 代码后处理：`first_appearance` 缺失时用 `sources[0].chapter` 填充；verdict='uncertain' 的字段不强求。

### 6. 状态与落盘
- `world_state = { title, genre, summary, characters(前12), entities(全量合并库), conflicts(批注后) }`——原文引用、实体库、冲突清单全部落盘，供 Lorebook（蓝图 §4.5）与将来的人工修订 UI 复用。
- 进度映射：parse 30/45 → extract 45~75（按单元推进）→ merge 80 → check 85 → synthesize 90~98 → done 100；`parse_progress` 列同步更新；`warnings` 随 done 事件回传（前端忽略新字段）。

### 7. 兼容性与影响面
- `index.post.ts`、`presets/[id]/generate.post.ts`、`turn.post.ts`、前端 `index.vue` 均**不改**（字段只增不减；前端只读 title/genre/summary/characters）。
- 旧 `world_state` 数据无 entities/conflicts 字段，读取不受影响。
- `streamChat`/`consumeChatStream` 不再被 novel-generation 使用（ai.ts 保留，回合流式仍用）。

### 8. 成本与时限
- 按实测规模修正（docs/txt：16~25 万字、45~113 章、平均每章 1500~3600 字）：提取单元 = 章节数（现状书籍）+ 超长块按 8000 字切段，约 50~130 单元；增量提取后每单元输出 ~0.8k token。
- 墙钟估算（付费版单请求 5 分钟内）：① 增量提取 + ② 快速模型（120 tok/s）+ ③ 并发 5 → **1~3 分钟**；不换模型（旗舰 60 tok/s）→ 3~5 分钟。加 merge（纯代码）+ check/synthesize（各 1 次调用）后总时长仍落在付费版单请求窗口内。**免费版（30s 墙钟）才需要 ④ 分段执行协议**，本次不实现；提取函数保持独立签名，蓝图方案 B（Queues/Workflow 异步消费）可直接复用。
- 成本：全流程输入 ≈ 通读全文一遍（13~18 万 token）+ 输出 ~5 万 token，DeepSeek 单价下一本约几元。

### 9. 验证
- `pnpm typecheck`；`pnpm dev` 起服务。
- 用 `docs/txt` 中一本走"预置小说生成世界"（或上传短 txt），curl 观察 SSE 各 stage、done.usage、`world_state` 含 entities/conflicts；抽查若干实体 quote 与原文逐字一致。
- GUI 验证：生成完成 → 选角页正常 → 游戏回合可玩（人物卡结构未变）。

### 备注
- 超长章单次输出若 JSON 截断，`structuredOutput` 重试会回灌修正；仍失败按警告跳过该章，不回滚整体。
- "后文为准"为自动裁决策略；冲突清单完整留痕，人工裁决 UI 留待后续（对齐蓝图 confidence/source_chapter 字段）。