## 目标

彻底消除"动一处 → 整书/整局重写"。v13 后仍有三处大字段与高频小写绑在同一行:

| 痛点 | 现状 | 触发场景 |
|---|---|---|
| `books.fulltext`(整本正文)挂 meta 行 | touchBook2/saveBook2Meta/saveBook2Edits 的 charCount 更新都整行重写 | 进页面、概览编辑、存卡 |
| `book-segments` 行 = canon + **canon.text(段正文)+ 整段角色文件 map** | 改一个角色的段文件 → 重写该段正文 + 全员文件;SegmentsModal 改正文 → 全段重写 | 卡编辑器每键提交、分镜编辑 |
| `games.messages`(整局消息)+ saves 快照复制整局 messages | 每回合 persist 整行 O(N);50 个存档点 = 50 份消息拷贝 | 每回合 ×3 |

## 新表结构(v14)

```
books                 'id, updatedAt'          meta/manifest(无 fulltext,<5KB)
book-texts            'key, id'                { key: `${id}::full` | `${id}::seg::${seq}`, text }  ← 正文大字段,仅整块读写
book-segments         '[id+seq], id'           canon(去 text,含 节点/cast/beat)
book-seg-chars        'key, id'                { key: `${id}::${seq}::${name}`, seq, name, file }  ← 段角色文件原子行
book-characters       '[id+name], id'          基础卡(不变)
book-world            'id'                     entities/conflicts/characterArcs(不变)
book-stats            'id'                     tokensUsed(v13,不变)
games                 'id'                     LocalGame 去 messages(optionsByMessage 留在行内,已被裁剪有界;新增 msgCount)
game-messages         '[gameId+idx], gameId'   { gameId, idx, id, role, speaker, content }  ← 消息 append-only 一行一条
saves                 'key, gameId'            存档点去 messages,只存 state/summary/idx 水位线
works / 其余小表                              不动;顺手删零引用死表 worlds、extract-cache
```

saves 丢弃 messages 的无损性:消息表只追加,旧存档点(idx 水位线)所需消息 ⊆ 当前消息表,回滚语义不变。

## 改造清单

**1. app/utils/localDb.ts** — v14 schema + 单事务 upgrade:
- books.fulltext → book-texts,并从行内删除该字段
- segments:canon.text → book-texts;characters map → book-seg-chars 行;段行重写为 canon-only
- games.messages → game-messages 行(msgCount 写入 games 行);saves 行删 messages 字段
- worlds / extract-cache 置 null

**2. app/utils/bookStoreV2.ts**
- `saveBookDoc`/`loadBookDocWithMeta`:按新表拆装(texts 批量写/按 id 拉取)
- `saveBook2Edits`:段角色文件 diff 直接 put 到 book-seg-chars 单行(真原子);不再触发段行/正文搬移
- 新增 `saveBook2Fulltext(id, text)`(edit 页用)、`saveBook2SegmentText(id, seq, text)`(SegmentsModal 用)——各一张小表单行写
- `deleteBook2` 补删 book-texts(按 id 索引)、book-seg-chars
- `touchBook2`/`saveBook2Meta`/charCount 更新自然变成 <5KB 行写入(拆出 fulltext 后自动达成)
- `updateBook2` 保留兜底(edit 页切到专用 API 后仅罕见路径)

**3. app/utils/gameStore.ts** — 新增消息表 API:`appendGameMessages`(bulkPut)、`listGameMessages(gameId)`、`deleteGameMessagesAfter(gameId, idx)`、`deleteGameMessages(gameId)`;`saveLocalGame` 保留但调用方改为传"无消息的游戏行";`restoreLocalGame` 兼容旧格式行(带 messages → 拆行)。列表用 `msgCount` 替代 `messages.length`。

**4. app/pages/games/[id].vue** — persist 改为:games 行(state/summary/currentBeat/optionsByMessage/msgCount)+ 仅新增消息 append(内存维护 lastPersistedIdx 水位线);打开会话 = getLocalGame + listGameMessages 拼装(渲染逻辑不变);回滚 = deleteGameMessagesAfter + 行内 state 覆盖。

**5. app/utils/gameSaveStore.ts** — `GameSavePoint` 去 messages;恢复存档点时消息从 game-messages 读(idx ≤ 点位线),旧备份恢复路径同语义。

**6. app/utils/backupStore.ts** — 备份导出 games 时组装消息进备份 JSON、恢复时拆行写入消息表;旧备份(行内带 messages)容错兼容。

**7. 调用点小改** — `edit/[id].vue`(saveBook2Fulltext)、`SegmentsModal.vue`(saveBook2SegmentText)、`continue.vue`/`works.vue`(msgCount)、`CharacterCardsModal.vue` 无需动(saveBook2Edits 签名不变)。

## 不做 / 风险声明

- works(v1)表不动(遗留层,写入源都是低频)。
- LocalWork/BookView/zip 边界形状不变,全部吸收在拼装层,页面消费方无感。
- v14 迁移是一次性全库重写(单事务,失败整体回滚),换永久细粒度。
- 每回合仍写 games 行(state/summary 有界增长),但消息体 O(N) 部分拆除后,回合写放大从 O(N) 降为 O(1) 增量。
- 纯本地改动,不触云端/分享格式;完成后跑 lint + typecheck + 56 项测试,并按 §10.0 用现有本地作品实点验证(打开书架/卡编辑/续玩/回滚/导出)。