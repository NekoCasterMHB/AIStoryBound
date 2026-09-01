## 目标

对「世界设定与剧情轨道」块做 5 项优化(全部在 prompt 组装层,现有作品立即生效),目标整块从 ~4,476 降到 ~1,800-2,000。

## 改动清单

### 1. 回注窗口与默认间隔收紧(纯无损)
- `shared/game.ts:18`:`REINJECT_WINDOW_CHARS` 1500 → **900**(段首原文窗口,锚定场景足够;`games/[id].vue:145` 引用同一常量自动生效)。
- `app/utils/reinjectPrefs.ts:8`:`REINJECT_INTERVAL_DEFAULT` 5 → **8**(仅新默认;老用户本地偏好保留,零影响)。

### 2. 冲突裁决 reason 截断(零风险)
- `plotTrackBlock`([game.ts:498](/D:/workspace/AIStoryBound/shared/game.ts#L498)):`c.reason` 现为原样注入 → `clampText(c.reason, 60)`。

### 3. 包装指令文案精简(零风险)
- [game.ts:503](/D:/workspace/AIStoryBound/shared/game.ts#L503)约 160 字 → 约 90 字,保留三个关键约束:「按需触发不要每回合抛出」「与情节/玩家行动冲突时以二者为准(此豁免仅指情节走向)」「世界设定与人物定位是不可违背的硬设定」。

### 4. 故事背景截断(零风险)
- `overlayToneLine`([game.ts:441](/D:/workspace/AIStoryBound/shared/game.ts#L441)):`故事背景:${summary}` → `clampText(summary, 300)`(作品级静态背景,300 字足够承载前提;动态进展由剧情回顾 summary 承载)。

### 5. 细纲/弧线窗口化(核心,收益最大)
- 删除 `storylineWindow`(全量注入实现,注释与行为不符),新增 `trackLines(beats, currentBeat)`:
  - 近窗:当前段 ±2 段(`TRACK_WINDOW_RADIUS = 2`)保留**完整摘要 + 注记**(细纲的 place/cast、弧线的 status);
  - 远段:压成一行 `[段X] 摘要前24字…`(`TRACK_FAR_SUMMARY_CHARS = 24`,去注记)——情节骨架仍在,模型仍知道整体走向;
  - **当前段未知**(stageIndex 为 null,旧存档/未传)时全部全量,行为不变。
- `plotTrackBlock` 增加 `currentBeat` 参数,弧线分支与细纲分支都走 `trackLines`;
- 调用处 `buildTurnPromptParts`([game.ts:573](/D:/workspace/AIStoryBound/shared/game.ts#L573))传入 `currentBeat: stageIndex`(页面已传入的当前细纲段),并移除 `plotTrackBlock` 内已不再使用的 `opening` 参数。

## 风险与兜底

- **远段变骨架**:远期情节由两套现成机制兜底——剧情回顾 summary(每回合收尾压缩)+ 段回注(每 N 回合重新全量注入当前段);且 prompt 本来就有「不要每回合抛出」全部细纲的约束。
- **旧存档无 stageIndex**:回退全量,零行为变化。
- 改动全部在 `shared/game.ts` + `reinjectPrefs.ts`,不碰生成管线、不改页面逻辑。

## 验证

1. `pnpm test`(现有 shared 测试不受影响)。
2. 临时脚本(跑完即删):用样例作品跑 `estimateTurnPromptBreakdown`,验证——近段全量/远段一行/当前段未知回退三态正确,并量化「世界设定与剧情轨道」块的 token 降幅。
3. `pnpm typecheck` exit 0。