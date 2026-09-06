# format-v2 进度确认与开发计划

## 现状结论(代码已核实,与文档 §10.0 一致)

`docs/format-v2.md` 记录的进度与实际代码完全一致(925c7b6「新重构」即把这批工作落盘提交,文档无滞后也无超前):

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 契约+类型 | ✅ | `shared/novel-v2.ts`(SegmentCanon 含`节点[]`/`主角`、bookDocToZip/bookZipToDoc) |
| P1 存储+转换器 | ✅ | `localDb.ts` DB_VERSION 10 + book2 表;`v2-convert.ts`/`bookStoreV2.ts`/`normalize-card.ts`/`migrateV2.ts`(无 UI 入口);读取层经 `loadWorkSmart` 直连 book2 |
| P2-A | ✅ | play/世界详情/角色卡编辑器经 `loadWorkSmart`;`game.ts` cardBrief 注入 profile「补充设定」 |
| **P2-B** | 🔴 **未动工(当前卡点)** | `game.ts` 对 v2/节点/段叠加零引用;`character-interpreter.ts` 全仓无消费者;开局仍是旧"按细纲段"流程 |
| P3 | 🟡 部分 | 自由区编辑器已接 v2 写回;统一富展示、分段查看 UI、v2 正文/世界详情编辑未做 |
| P4/P5/P6 | 🔴 未开工 | Workflows 仍产 v1;无 R2 `works/<id>.zip`;迁移工具无 UI |

**关键依赖缺口**:`节点[]`、段级`主角`、转折标题目前只有契约定义,无任何链路产出(`workToV2` 从 v1 storyline 切段只产 text+beat,无节点;云端管线是 v1)。因此 P2-B 按容错降级实施:引擎能力先建好,无节点数据的作品(现状全部)自动退回现有 beat 行为,P4 产出节点后自动生效。

## 阶段一:P2-B 引擎读取层(下一步,本次实施)

1. **接入保留键解释器 + 段状态叠加**(§8 规则 4):
   - `v2ToWork`/读取层把段角色文件(姓名/状态/剧情)随 LocalWork 透传给引擎(新增可选字段,如 `segmentCharacterFiles`),或引擎按 book2SourceId 直读 BookDoc;
   - `game.ts` 有效卡计算:基础卡 → 当前段角色文件`状态`浅覆盖 → `剧情`作为该角色分线注入 prompt;`character-interpreter.ts` 的 `interpretCharacter` 在此接入,替代 `bookCharacterToCard` 的散点类型假设;无段文件的角色行为不变。
2. **段级主角锚**(§11.6):`game.ts` NPC 对手戏锚改为先取当前段 `正典.主角` 名单最适者,段未标则回退 `role==='主角'`。
3. **节点进度与注入**(§7.4):
   - `turnOptionsSchema` 的 `current_beat` 扩展为可回报「段序号 + 已达节点/百分比」(兼容旧格式字符串,解析器双读);
   - GameState 增加已触发节点记录;回合 prompt 的剧情轨道只注入「已达节点摘要 + 下一未触发节点详细描述」;
   - **降级**:本段无`节点[]`时完全不启用节点逻辑,维持现有段窗口注入。
4. **卡住引导**(§7.4):连续 5 回合且段内进度 <40% 时,在 options 混入「【推进剧情】…」引导项指向下一未触发节点;仍为建议,自由输入优先。无节点数据不触发。
5. **开局交互「先选角色 → 再选时间点」**(§7.3):
   - `play/[id].vue` 对 v2 作品(book2SourceId)改为两步:选角色(以各段角色文件反查可用角色)→ 选该角色的切入时间段(列表展示段`title`转折标题/主角/剧情摘要,以文件为准过滤);
   - 选定后以该段该角色状态开局,现有 openingMode(ai/beat/custom)叠加细化首回合;v1 作品保持现有三选流程不变。
6. **验证**:用测试账号导入/转换一个 v2 作品开局游玩,核对段状态叠加、主角锚、降级路径(v1 转 v2 无节点)均正常;有节点数据的作品用手工构造样例验证节点注入与卡住引导。

## 阶段二:P3 收尾(接下来)

- 统一人物卡富展示组件(保留键富展示 + 自由键"键:值"通用渲染 + 折叠),选角页/书架/游戏内角色卡复用;
- 分段查看 UI:正典(标题/beat/节点/cast/正文)+ 各角色本段文件(状态/剧情/自由区)浏览;
- v2 正文编辑与世界详情概览编辑接 v2 写回,解除 `works.vue` 对 v2 的菜单禁用;
- `migrateV2.ts` UI 入口(设置页/书架工具位,dry-run + 备份)。

## 阶段三:P4 生成管线 v2 化(周期最长)

Workflows 改为:parse → author → 切段即产 `正典.json`(AI 标转折标题/主角/cast/`节点[]`)→ extract 每段只产各角色`剧情+状态` → merge 合并 → 代码翻译成中文键 `characters/` → 弧线纯总结 → 落 v2 zip。此阶段完成后,阶段一的全部引擎能力在新生成作品上自动生效。

## 阶段四:P5 云端/同步/工坊

R2 zip 统一存储(`works/<id>.zip`、`preset-worlds/<id>.zip`、`store/<id>.zip`),D1 只存索引元数据;分享 share|kind=game 打包 games/;存量 world_state JSON 迁移。

## 阶段五:P6 回归 + 兼容矩阵

旧 zip/新版 zip/空字段/异结构导入回归;迁移工具全量走查;更新 `docs/format-v2.md` §10.0 进度表(每阶段完成后同步)。

**本次执行范围**:阶段一(P2-B)完整落地并验证;阶段二起按上述顺序作为后续迭代,不并行展开。