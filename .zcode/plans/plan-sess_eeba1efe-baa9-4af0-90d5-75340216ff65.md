## 方案:续玩上下文错位 + 回滚摘要缺口 + 解码器并发隐患

### 修复 1(根治主线 bug,同时治好回滚落点错位)
`app/pages/games/[id].vue`——把"结算落盘"从「旁白入列之前」挪到「回合闭环之后」:
- `runOptionsPhase`(724-807):删除内部 `persist()`(805)与 `await savePointNow()`(806)。收尾器只合并内存态,不写盘。
- `sendTurn` 尾部(1084 `messages.value.push(narratorMsg)` 之后):
  ```ts
  messages.value.push(narratorMsg)
  if (!optionsOk) awaitingOptions.value = true
  await optionsTask
  persist()                       // 旁白已入列:成功=完整回合,失败=可恢复前置态
  if (optionsErr) throw optionsErr
  await savePointNow()            // 回合闭环才更新回滚点
  ```
- `retryOptionsPhase`(810-837,旁白已在尾部的那条收尾路径):`await runOptionsPhase(...)` 成功后补 `persist(); await savePointNow()`。

效果:磁盘上不再存在"state/summary/段位已结算、回应旁白缺失"的中间形态;存档点自动变为"消息到旁白 + state/选项对齐"的闭环点 → 回滚命中的就是正确决策点,不再有"看似未回应 → 重试 → 二次结算"。**这一条同时治愈回滚的落点错位(原 1a),无需单独改回滚。**

### 修复 2(续玩旧坏档自愈)
`games/[id].vue` `onMounted`(约 195 行 `game.value = g` 之前):
- 检测:末条 `role==='user'` 且 `typeof g.summary?.idx === 'number' && g.summary.idx > last.idx`(摘要已越过该行动 = 行动已被结算、旁白丢在磁盘外)。
- 自愈:循环丢弃尾部满足条件的悬空 user 消息(丢弃后末条变 narrator 即停,幂等);选项置空;`void saveLocalGame(g)` 回写;中性 toast 提示"上次回合进度保存不完整,剧情摘要已保留,请直接输入行动继续"。state/summary 保持不变(丢弃后不可能再被重试,杜绝二次结算)。
- 反例保护:真中断回合(`summary.idx ≤ last.idx`)不触发,保留干净重试。

### 修复 3(回滚摘要缺口,原 1b)
- `app/utils/gameSaveStore.ts`:`GameSavePoint` 增加 `summary?: LocalGame['summary'] | null`(旧点无此字段,读回为 undefined)。
- `savePointNow`(games/[id].vue:702-714)写入时带上 `summary: game.value.summary`。
- `rollbackAction`(games/[id].vue:1152-1192)恢复 messages/state/currentBeat 的同时恢复 `game.value.summary = (target as GameSavePoint).summary ?? null`(旧点/空摘要 → null,宁缺毋超前)。
- opening 不用动(澄清:开局后无人改写 opening,回滚不删它,不存在"丢失")。

### 修复 4(解码器并发隐患,独立)
`server/utils/ai-relay.ts:154-155`:`const encoder/decoder` 从模块级搬进 `relaySse` 函数体内(每次调用新建,`{stream:true}` 状态不跨请求共享)。chat 分支行为不变(本来就透传),anthropic/responses 分支的拼装不再可能被并发流串扰。

### 验证
1. `npx nuxt typecheck` 通过。
2. 本地 dev server 按 AGENTS.md(先查配置端口占用,杀遗留进程;测完关闭并确认端口释放)。
3. 逻辑走查:sendTurn 各时序(收尾先于/后于播完、中断、取消、收尾失败)磁盘终态均为闭环或"未结算行动"两种;回滚在新存档点下落在正确决策点;rollbackAction 对无 summary 旧点降级为 null;ai-relay 单测/走查确认 decoder 每次调用独立。
4. 请用已有坏档实测:进入「继续游玩」应见自愈提示,新剧情恢复;回合看完离开再续玩不再复发;回滚到旧行动后继续生成内容正常。

### 不做
- 旧(修复前)存档点仍为错位形态:回滚到它们仍会踩旧问题(历史数据无法追溯修复),仅在回滚菜单遇到旧点时可接受;新产生的点全部闭环。
- 不提交/不推送 git(需要时另说)。
