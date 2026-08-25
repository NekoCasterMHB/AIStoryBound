## 结论:合理,但有两处需要修正

你的提案（章节优先 + 12K tokens/块 + 500~1K tokens 重叠）方向正确，且"章节优先"在本项目已经是现状——`splitUnits`（shared/world-build.ts:41）每章独立成单元，只有超限长章才切段，从不合并小章、也不按字数机械切整本书。真正要改的是两件事：默认块大小和切段重叠。两处修正：

1. **12K tokens 要换算成项目的字符制**：设置项 `unitMaxChars` 以字符为单位（1.6~1.7 字符/token），12K tokens ≈ **20,000 字符**。
2. **"全局合并输入 64K~128K / 最终输出 16K~32K"在本架构里不需要照搬**：全局合并是代码级 `mergeExtractions`（确定性去重合并，不吃 LLM），对应的人工智能步骤是"一致性检查 + 成书"，它们的输入是压缩后的实体库（远小于 64K），输出上限已是可调项（检查 4000~16384、成书 16000~32768），已落在你的 16K~32K 区间内。

## 改动清单

### 1. shared/world-build.ts
- `UNIT_MAX_CHARS` 8000 → **20_000**（注释同步："≈12K tokens"）。
- 新增 `UNIT_OVERLAP_CHARS = 1000` 常量（≈590 tokens，含注释）。
- `splitUnits(chapters, maxChars, overlapChars = UNIT_OVERLAP_CHARS)`：超限长章切段时，下一段从 `cut - overlapChars` 起（clamp 到 ≥0；overlapChars 内部 clamp 到 ⌊maxChars/2⌋ 保证迭代必有进展）；单章 ≤ maxChars 时完全不受影响（整章一个单元、无重叠）。所有短章段落保持现状。

### 2. app/utils/genSettings.ts
- `GenLimits` 新增 `unitOverlapChars`（默认 `UNIT_OVERLAP_CHARS` = 1000）。
- `GEN_LIMIT_RANGE.unitOverlapChars = { min: 0, max: 5000, step: 100 }`（0 = 关闭重叠）。
- `extractMaxTokens` 默认 6000 → **8000**（对应 12K 输入块、你建议的 4K~8K 输出区间；内容密集章不易截断触发"非 JSON"失败；上限只是封顶，实际用量不涨）。
- 头部注释数字同步。

### 3. app/utils/worldGen.ts
- `splitUnits(chapters, genLimits.unitMaxChars, genLimits.unitOverlapChars)`。

### 4. app/pages/profile.vue
- 「高级设置」新增「单元切段重叠」输入框（字符，0=关闭，默认 1,000），`LIMIT_FIELDS` 校验表新增对应条目（已自动纳入统一校验/保存/恢复默认逻辑）。
- 提示文案"8,000 字符 ≈ 5K tokens" → "20,000 字符 ≈ 12K tokens"；卡片描述补充"单元切段重叠"也在高级设置中。

### 兼容性与影响
- 不改 `GEN_LIMIT_RANGE` 既有条目、不改服务端/数据库；无新接口。
- 旧 localStorage 用户保持各自已存值（多为 8000），点「恢复默认」才获得新默认；新用户直接用新默认。
- overlap 使总输入增加约 1~2%（仅超限长章的开销）；失败爆炸半径变化极小（仍在重试 1 次 + 失败率 >1/3 中止的策略内）。
- 已知可接受取舍：重叠区实体可能在两个相邻单元各提取一次 → 该实体 sources 多一条、mentionCount 虚增 1（不影响引用逐字校验、不产生虚假冲突——标量相同值不记冲突）；不做额外去重，避免"两个角色引用同一句原文"时误删真实证据。

## 验证
1. `npm run typecheck`。
2. 用 esbuild（node_modules 内已有）把 `shared/world-build.ts` 编译为 CJS，写一次性 node 脚本构造三类章节断言：短章（<20K）整章一个单元且无重叠；25K 长章按段落边界切成两段且第二段头部含上一段尾部重叠区；重叠值 0 时行为与现状一致。