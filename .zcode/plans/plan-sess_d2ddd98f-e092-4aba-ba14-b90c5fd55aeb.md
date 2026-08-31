# 角色卡章节化 + 互动动态演进 实施方案

## 目标
1. **章节基线层**:角色卡带 `chapterVariants`(从原著自动提取的每章差异),游玩时按当前章节自动切换。
2. **运行时动态层**:角色全字段可随互动演进(LLM 每回合回报 → 白名单合并进 `GameState.characterStates`)。
3. **UI**:游玩页状态面板展示并可手动编辑角色当前状态;支持查看角色章节时间线。

有效角色卡 = 基础卡 → ≤当前章的章节变体叠加 → 运行时动态补丁。

## 1. 数据模型(shared/novel.ts)
- 新增 `CharacterChapterVariant { chapter: number(0-based 章节下标), title?: string|null, status?: string|null(该章处境一句话), patch: Partial<CharacterCard> }`(patch 只存与上一章快照的差异字段)。
- `CharacterCard` 增加可选 `chapterVariants?: CharacterChapterVariant[]`。
- 新增 `CharacterDynamicState { status?, location?, mood?, dead?: boolean|null, patch?: Partial<CharacterCard>, log?: { idx: number, text: string }[] }`。
- `GameState` 增加可选 `characterStates?: Record<string, CharacterDynamicState>`。

## 2. 生成流水线(shared/world-build.ts,两条调用线共用)
- 提取 schema(`EXTRACT_SCHEMA_HINT` / `EXTRACT_SCHEMA_HINT_ECO`,world-build.ts:100/114)的 characters 增加 `"status": "该角色在本章的处境/状态(身份转变、受伤、被囚、死亡等)|null"`;`ExtractedCharacter`(novel.ts:190)加 `status?`。
- 新增 helper:按 `unit.startChar`(全书偏移)映射到章节下标(与 games 页 `resolveChapterIndex` 同款累加逻辑,下沉到 world-build.ts 共用)。
- `mergeExtractions`(world-build.ts:392):为每个角色记录按提取单元的标量快照序列(dead/identity/appearance/desire/sex/status),挂到 `MergedCharacter.chapterSnapshots`。
- 新增 `buildChapterVariants()`:相邻快照 diff,值变化才生成 patch + status;在 `buildLocalCards`(eco)与 `finalizeCards`(标准)里给 Top 角色卡挂载(每卡上限 ~30 条,防膨胀)。
- `app/utils/worldGen.ts` 与 `scripts/prebuild-presets.ts` 把 chapters 传入共用逻辑;产物(本地 IndexedDB / worlds/*.json / D1 `novels.world_state` JSON 列)自动携带,无 DB 迁移。

## 3. 有效卡计算 + 提示词(shared/game.ts)
- 新增 `effectiveCard(card, chapterIndex, dyn?)`:依次叠加章节变体与动态补丁。
- `cardBrief(c, dyn?)`(game.ts:168)末尾追加 `状态/情绪/位置`(动态层提供)。
- `buildTurnPrompt`(game.ts:338)增加 `chapterIndex?` 参数:system 人物卡块(:381)与"人设提醒"(:439)改用有效卡;新增一小段【角色当前状态】说明(告诉 AI 该状态随剧情演进、以此为准)。
- `turnOptionsSchema()`(game.ts:46)的 state_delta 增加:
  `"character_states": {"角色名": {"status": "处境一句话", "location": "位置", "mood": "情绪", "dead": true|false, 以及任意人物卡字段(如 identity/appearance/personality/goals/secrets…),无变化省略}}`。
- `mergeState`(game.ts:111)白名单合并 character_states(字符串/数组替换、dead 布尔),并按 delta 自动生成一句变化摘要追加到 log(带回合 idx);kinkBoost 用的卡改为有效卡(调用方传入)。

## 4. 游玩页(app/pages/games/[id].vue)
- 用 `plotPos.idx`/`resolveChapterIndex` 计算 chapterIndex,`effectiveCards` computed 贯穿 buildTurnPrompt / mergeState / seedDesiresByOpening(:403)。
- `runOptionsPhase`(:477)随现有 mergeState 自动落 characterStates;persist/存档点/云同步无需改动(JSON 透传)。
- 状态面板(:280-320)新增「角色状态」区:每角色展示 status/location/mood/dead,支持手动编辑(复用现有草稿→确认交互)。
- 新增角色「章节时间线」弹窗:chapterVariants(第N章:状态/字段差异)+ 运行时 log(第N回合:变化)按序展示。

## 5. 兼容性与注意点
- 全部新字段可选:旧存档、旧作品零迁移(chapterVariants 缺失=只有基础卡;characterStates 缺失=空行为)。
- `CharacterCardsModal` 的 normalizeCards 保存时必须 spread 原卡,避免丢掉 chapterVariants(实现时验证)。
- token 增量可控:提取阶段每单元多一个 status 字段;每回合收尾 character_states 约多 100-300 tokens;system 块因有效卡叠加略有增长。

## 验证
1. 预构建脚本跑一本作品,检查 worlds/*.json 中 chapterVariants 是否按章 diff 正确;本地标准/节约两模式各生成一次核对。
2. 开新局游玩数回合:确认 AI 回报 character_states 被合并、面板展示与手动编辑生效、章节切换后有效卡变化、时间线展示正确。
3. 用旧存档打开确认无报错(兼容路径)。