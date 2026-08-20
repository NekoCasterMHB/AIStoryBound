# AI 小说驱动互动游戏平台：完整产品与技术规划

> 项目定位：将用户上传的小说 TXT 转换为可游玩的 AI 互动剧情游戏。  
> 核心能力：小说解析 → 人物卡/世界观生成 → 角色代入 → AI 扮演 → 动态选项 → 剧情分支 → 状态与记忆 → 事件系统 → 可插拔外部设备控制层。
>
> **成人设备部分仅作为可选硬件输出层设计。平台核心必须能够在没有任何外部设备时完整运行。**

---

## 1. 产品愿景

### 1.1 一句话

**让任何一本小说都可以变成一个可互动、可分支、可长期游玩的 AI RPG。**

用户上传一本小说后，系统自动分析：

- 人物
- 人物关系
- 世界观
- 地点
- 势力
- 物品
- 时间线
- 关键事件
- 原著剧情

然后让用户：

1. 选择自己要代入的角色
2. 选择 AI 扮演的角色
3. 进入小说世界
4. 与 AI 角色进行对话
5. 从 AI 提供的选项中选择
6. 也可以自由输入行动
7. 根据行为产生不同剧情
8. 保存长期记忆和世界状态
9. 在特定事件中触发游戏反馈
10. 最终产生不同于原著的分支和结局

---

# 2. 核心产品循环

```text
上传小说
    ↓
小说解析
    ↓
世界模型构建
    ↓
人物卡生成
    ↓
用户选择角色
    ↓
选择 AI 扮演角色
    ↓
开始剧情
    ↓
AI 描述场景
    ↓
AI 提供 3～4 个选项
    ↓
玩家选择 / 自由输入
    ↓
Game Engine 判断
    ↓
更新状态
    ↓
生成下一剧情
    ↓
触发事件
    ↓
保存 Memory
    ↓
继续游戏
```

---

# 3. 产品核心理念

## 3.1 小说不是固定剧本

原著应该作为：

> **世界初始状态 + 原始时间线**

而不是强制剧情。

例如原著：

```text
第 50 章
A 遇到 B

第 51 章
B 背叛 A

第 52 章
A 死亡
```

玩家进入后：

> “我提前告诉 A，B 可能会背叛。”

系统应该允许：

```text
原著时间线
    ↓
玩家干预
    ↓
B 发现计划暴露
    ↓
B 改变行动
    ↓
产生新事件
    ↓
世界偏离原著
```

因此产品真正的卖点是：

> **“如果我进入这本小说，故事会变成什么样？”**

---

# 4. 产品模块

## 4.1 用户系统

- 注册 / 登录
- 用户资料
- 游戏存档
- 上传小说
- 最近游戏
- 收藏世界
- 删除游戏
- 隐私设置

---

## 4.2 小说上传

支持：

- TXT
- UTF-8
- GBK / GB18030
- 自动编码检测
- 超大 TXT 分块读取
- 自动章节识别

后续可扩展：

- EPUB
- Markdown
- PDF（需要版权与解析策略）
- 用户自己的结构化剧本

### 上传流程

```text
TXT
 ↓
Encoding Detection
 ↓
Text Cleaning
 ↓
Chapter Detection
 ↓
Chapter Segmentation
 ↓
Document Store
```

---

# 5. 小说 AI 解析系统

不要直接把整本小说长期作为 Prompt。

应该先建立结构化世界模型。

## 5.1 提取内容

### Characters

```text
姓名
别名
性别
年龄
身份
性格
外貌
背景
能力
目标
恐惧
秘密
人物关系
首次出现章节
死亡状态
```

### Locations

```text
名称
类型
地理关系
所属势力
重要人物
重要事件
```

### Factions

```text
名称
领导者
成员
目标
敌对势力
友好势力
资源
```

### Items

```text
名称
类型
功能
持有者
来源
重要程度
```

### Timeline

```text
事件 ID
时间
地点
参与人物
事件描述
前置条件
后续影响
原著章节
```

### World Rules

例如：

```text
魔法体系
科技水平
政治体系
经济体系
社会规则
特殊能力
世界限制
```

---

# 6. Character Card

自动生成角色卡。

示例：

```yaml
name: 史强
role: 警察

personality:
  - 直接
  - 敏锐
  - 粗犷

speech_style:
  - 口语化
  - 简洁

background:
  ...

relationships:
  汪淼:
    type: 同事/合作
    value: 50

goals:
  ...

secrets:
  ...

knowledge:
  ...
```

---

# 7. 玩家角色选择

用户可以选择：

### 原著角色

```text
叶文洁
汪淼
史强
...
```

### 自定义角色

用户可以创建：

```text
姓名
身份
性格
背景
初始能力
与原著人物的关系
```

### 游戏模式

建议提供：

- 原著角色模式
- 自定义魂穿模式
- 多角色模式
- 旁观者模式

---

# 8. AI 扮演系统

AI 不应该只有一个角色。

建议抽象为：

## Story AI

负责：

- 场景描述
- NPC 对话
- 选项生成
- 情节推进
- 叙事风格

## Game Master AI

负责：

- 判断玩家行为是否符合世界规则
- 推演 NPC 可能反应
- 生成事件
- 处理剧情冲突

## State Engine

负责：

- 金钱
- HP
- 道具
- 关系
- 任务
- Flag
- 时间
- 地点
- 状态

**状态不要完全交给 LLM 决定。**

---

# 9. 对话系统

每一轮：

```text
Scene Description

NPC Dialogue

Current Situation

Choices:
A. ...
B. ...
C. ...

[自由输入]
```

### 选项类型

- 安全选项
- 高风险选项
- 探索选项
- 社交选项
- 战斗选项
- 隐藏选项

可以让选项具有：

```text
risk
expected_effect
required_state
hidden_consequence
```

---

# 10. Game State

游戏必须拥有独立状态，而不是只保存聊天记录。

示例：

```json
{
  "player": {
    "character_id": "character_001",
    "location": "beijing",
    "money": 500,
    "hp": 100
  },
  "relationships": {
    "npc_001": 35
  },
  "inventory": [],
  "quests": [],
  "flags": {
    "met_npc_001": true
  },
  "world_time": "2007-08-20T18:30:00",
  "timeline_position": 12
}
```

---

# 11. NPC Memory

NPC 不应该知道所有事情。

每个 NPC 应该有独立知识范围：

```text
NPC A
├── 已知事件
├── 不知道的秘密
├── 对玩家的记忆
├── 对其他 NPC 的认知
└── 当前目标
```

例如：

```text
玩家骗过 NPC A

A 记得：
“玩家曾经骗过我。”

B 不知道这件事情。
```

这样可以产生更真实的世界。

---

# 12. Memory System

聊天历史过长后：

```text
完整聊天
    ↓
重要事件提取
    ↓
Memory
```

Memory 应保存：

- 玩家做出的重大决定
- 人物关系变化
- 重要承诺
- 获得/失去的物品
- 世界状态变化
- NPC 对玩家的印象
- 未完成任务
- 关键秘密

---

# 13. Context Engine

每次请求不要把整本小说塞给模型。

建议：

```text
System Rules
+
Character
+
Current Scene
+
Game State
+
Relevant World Info
+
Relevant NPC Memory
+
Recent Chat
+
Long-term Memory
+
Relevant Original Novel Text
+
Player Input
```

---

# 14. 小说全文与百万 Context

如果模型支持 1M Context：

可以用于：

- 初次小说解析
- 时间线分析
- 世界观分析
- 复杂剧情推演
- 关键剧情回溯

但不要每回合都发送整本小说。

正确方式：

```text
原著全文
    ↓
World Model
    +
Vector / Full-text Index
    +
Timeline
    +
Chapter Index
```

游戏过程中只检索相关内容。

---

# 15. RAG

建议建立：

```text
Novel Chunk
    ↓
Embedding
    ↓
Vector Store
```

检索维度：

- 当前人物
- 当前地点
- 当前事件
- 当前章节
- 玩家问题
- 当前剧情

同时保留全文索引，用于精确检索。

---

# 16. 剧情分支系统

每个剧情节点：

```yaml
scene_id: scene_001

conditions:
  - relationship.npc_001 >= 30

choices:
  - id: choice_a
    text: ...
    effects:
      relationship.npc_001: +10

  - id: choice_b
    text: ...
    effects:
      relationship.npc_001: -20
```

AI 可以生成候选剧情，但最终状态变化由 Game Engine 执行。

---

# 17. Event System

统一定义：

```text
StoryEvent
StateEvent
RelationshipEvent
QuestEvent
RewardEvent
PenaltyEvent
DeviceEvent
```

例如：

```json
{
  "type": "relationship_event",
  "target": "npc_001",
  "change": -10
}
```

---

# 18. 外部设备控制层

成人设备仅作为可选硬件输出层。

核心游戏不直接认识品牌。

正确架构：

```text
Game Event
    ↓
Toy Abstraction API
    ↓
Toy Plugin
    ↓
Brand SDK / API / BLE Adapter
    ↓
Device
```

---

# 19. Universal Toy API

建议定义统一接口：

```typescript
interface ToyPlugin {
  id: string
  name: string
  version: string

  discover(): Promise<Device[]>

  connect(deviceId: string): Promise<void>

  disconnect(deviceId: string): Promise<void>

  capabilities(deviceId: string): ToyCapabilities

  execute(
    deviceId: string,
    command: ToyCommand
  ): Promise<void>

  stop(deviceId: string): Promise<void>
}
```

---

# 20. Capability System

不同设备能力不同。

例如：

```json
{
  "intensity": true,
  "pattern": true,
  "duration": true,
  "rotation": false
}
```

AI / Scenario Engine 只允许使用设备支持的能力。

---

# 21. Toy Plugin

每个品牌作为独立插件：

```text
plugins/
├── brand-a/
├── brand-b/
├── brand-c/
└── local-ble/
```

插件负责：

- 设备发现
- 连接
- 身份验证
- API 转换
- 能力描述
- 状态读取
- 停止操作

---

# 22. Plugin Manifest

示例：

```json
{
  "id": "toy-brand-a",
  "name": "Brand A Adapter",
  "version": "1.0.0",
  "capabilities": [
    "intensity",
    "pattern",
    "duration"
  ],
  "permissions": [
    "device.control"
  ]
}
```

---

# 23. 插件安全

必须加入：

- 权限系统
- 插件签名
- 版本管理
- Sandbox
- 用户授权
- 日志
- 紧急停止
- 设备断连自动停止

**任何设备控制都必须有最高优先级的 Stop。**

---

# 24. AI 不直接控制设备

不要：

```text
LLM
 ↓
Brand API
```

必须：

```text
LLM
 ↓
Structured Event
 ↓
Game Engine
 ↓
Permission Check
 ↓
Capability Check
 ↓
Toy API
 ↓
Plugin
 ↓
Device
```

AI 只提出游戏事件。

---

# 25. 成人设备事件设计

第一版可以抽象为：

```text
DeviceEvent
├── target_device
├── action
├── duration
├── intensity
└── metadata
```

但不要允许模型绕过 Game Engine 直接执行。

建议加入：

```text
max_duration
max_intensity
cooldown
user_consent
session_permission
emergency_stop
```

---

# 26. 用户控制

用户必须始终拥有：

- Start / Stop
- 设备断开
- 总开关
- 最大强度限制
- 最大持续时间
- 场景中禁止设备事件
- 一键退出游戏

---

# 27. AI 剧本设计

AI 可以根据小说生成：

```text
Scene
Dialogue
Choices
Conditions
Consequences
Events
```

但输出必须 Structured Output。

例如：

```json
{
  "scene": {
    "description": "...",
    "dialogue": []
  },
  "choices": [
    {
      "id": "A",
      "text": "...",
      "risk": "low"
    }
  ],
  "state_effects": [],
  "events": []
}
```

---

# 28. 推荐的 Agent 分工

```text
Novel Analyst
    ↓
World Builder
    ↓
Character Builder
    ↓
Game Master
    ↓
Story Writer
    ↓
State Validator
    ↓
Memory Manager
```

不是所有步骤都需要独立模型。

MVP 可以先：

```text
Novel Analyzer
Game Master
State Engine
Memory Manager
```

---

# 29. 数据库设计

推荐：

```text
users
novels
novel_chapters

characters
locations
factions
items
events
timelines

games
game_players
game_states

npc_memories
player_memories
relationships

scenes
choices
game_events

toy_plugins
devices
device_sessions
```

---

# 30. 推荐技术栈

如果使用你熟悉的技术：

### Frontend

- Nuxt
- Vue
- Nuxt UI / Tailwind
- PWA

### Backend

- Nuxt Server / Nitro
- Cloudflare Workers 或 Node.js

### Database

MVP：

- PostgreSQL

如果强依赖 Cloudflare：

- D1

长期复杂 RPG 状态更推荐 PostgreSQL。

### Storage

- R2
- S3-compatible storage

用于：

- TXT
- 原始小说
- 解析结果
- 图片
- 用户生成资源

### Vector Search

可以选择：

- pgvector
- Cloudflare Vectorize
- Qdrant

### Queue

小说解析建议异步：

```text
Upload
 ↓
Queue
 ↓
Parser
 ↓
AI Analysis
 ↓
World Builder
 ↓
Ready
```

---

# 31. 推荐 API

## Novel

```text
POST   /api/novels
GET    /api/novels/:id
POST   /api/novels/:id/analyze
GET    /api/novels/:id/characters
GET    /api/novels/:id/world
GET    /api/novels/:id/timeline
```

## Game

```text
POST   /api/games
GET    /api/games/:id
POST   /api/games/:id/start
POST   /api/games/:id/input
POST   /api/games/:id/choice
GET    /api/games/:id/state
```

## Memory

```text
GET    /api/games/:id/memories
POST   /api/games/:id/memories
```

## Device

```text
GET    /api/devices
POST   /api/devices/:id/connect
POST   /api/devices/:id/stop
GET    /api/devices/:id/status
```

## Plugin

```text
GET    /api/plugins
POST   /api/plugins/install
DELETE /api/plugins/:id
```

---

# 32. 前端页面

## 首页

```text
上传小说
我的世界
继续游戏
插件
```

## 小说分析页

```text
解析进度
人物
世界
地点
势力
时间线
```

## 角色选择

```text
Character Cards
```

## 游戏大厅

```text
当前世界
当前角色
当前章节
存档
设置
设备
```

## 游戏页面

```text
┌─────────────────────────────┐
│ 场景                         │
│                             │
│ NPC 对话                    │
│                             │
│ AI生成的剧情                │
│                             │
├─────────────────────────────┤
│ ① 选择                      │
│ ② 选择                      │
│ ③ 选择                      │
│                             │
│ [ 自由输入 ]                │
└─────────────────────────────┘
```

---

# 33. 游戏页面必须显示状态

建议：

```text
角色
地点
时间
HP
金钱
关系
任务
重要 Flag
```

但不要把所有数据暴露给玩家。

可以设置：

```text
公开状态
隐藏状态
AI内部状态
```

---

# 34. MVP

第一阶段不要做所有功能。

## MVP-1

只实现：

```text
TXT 上传
↓
章节解析
↓
AI人物提取
↓
人物卡
↓
选择角色
↓
AI对话
↓
3个选项
↓
剧情分支
↓
保存游戏
```

目标：

> **验证“小说 → 可玩的 AI RPG”是否真的好玩。**

---

# 35. MVP-2

加入：

```text
World Model
NPC Memory
Relationship
Timeline
Game State
RAG
```

目标：

> 长时间游戏不失忆。

---

# 36. MVP-3

加入：

```text
Event Engine
Plugin System
Toy API
Device Adapter
```

目标：

> 把游戏事件与外部设备连接。

---

# 37. MVP-4

开放：

```text
Plugin SDK
Plugin Marketplace
Scenario Marketplace
Character Marketplace
```

目标：

> 从一个游戏变成平台。

---

# 38. 最终产品形态

最终可以形成：

```text
                    AI Novel RPG Platform
                             │
        ┌────────────────────┼────────────────────┐
        ↓                    ↓                    ↓
    Novel Engine        Scenario Engine       Plugin System
        │                    │                    │
   TXT / EPUB          Story / Choice          Toy / API
        │                    │                    │
        ↓                    ↓                    ↓
 Character Cards        Game State             Devices
 World Model            Memory
 Timeline               Events
```

---

# 39. 最重要的产品壁垒

真正的技术壁垒不是：

> “调用一个 AI API。”

而是：

### ① Novel → World Model

从任意小说自动构建可玩的世界。

### ② Persistent NPC Memory

NPC 真正记得玩家。

### ③ Dynamic Timeline

玩家可以改变原著。

### ④ Deterministic Game State

AI 不会随便改变游戏规则。

### ⑤ Scenario Engine

AI负责生成剧情，程序负责执行游戏规则。

### ⑥ Device Plugin Ecosystem

不同硬件可以通过插件进入同一个游戏。

---

# 40. 最终定位

不建议把产品定位成：

> AI Chat

也不建议只定位成：

> AI 成人玩具控制器

更适合：

> **AI Interactive Fiction / AI RPG Platform**

核心价值：

> **把小说变成一个可以真正进入、行动、改变剧情的世界。**

设备则作为：

> **Immersive Hardware / Optional Feedback Layer**

---

# 41. 开发优先级

```text
P0
├── TXT Upload
├── Chapter Parser
├── Character Extraction
├── Character Card
├── Game Session
├── LLM Chat
└── Choice System

P1
├── World Model
├── Game State
├── Relationship
├── Memory
├── Timeline
└── RAG

P2
├── Event Engine
├── Structured Output
├── Scenario Engine
├── Device Abstraction
└── First Toy Plugin

P3
├── Plugin SDK
├── Plugin Marketplace
├── Scenario Marketplace
└── Community

P4
├── Multiplayer
├── Voice
├── Image Generation
├── VR
└── More Hardware
```

---

# 42. 最终技术原则

1. **LLM 不直接修改数据库**
2. **LLM 不直接控制设备**
3. **Game State 必须由程序验证**
4. **小说原文与游戏状态分离**
5. **Memory 与 Chat History 分离**
6. **NPC 有独立记忆和知识范围**
7. **设备通过统一 API 抽象**
8. **品牌通过 Plugin 接入**
9. **所有外部设备都有 Stop / Permission / Limit**
10. **百万 Context 用于分析和复杂推理，而不是每轮重复发送整本小说**
11. **先做 Web 游戏闭环，再做设备**
12. **先验证玩法，再扩展插件生态**

---

# 43. 最小可行产品的核心闭环

如果只允许做一个版本：

```text
用户上传一本小说
        ↓
AI 自动提取人物
        ↓
用户选择角色
        ↓
AI 扮演其他角色
        ↓
进入小说世界
        ↓
AI 描述场景
        ↓
AI 提供 3 个选择
        ↓
玩家选择
        ↓
Game State 更新
        ↓
AI 根据新状态继续剧情
        ↓
产生分支
        ↓
保存记忆
        ↓
继续游戏
```

只要这个闭环足够好玩，后面的：

```text
RAG
长期 Memory
原著时间线
设备插件
插件市场
```

都有自然的扩展价值。

---

# 44. 产品核心一句话

> **上传一本小说，选择一个身份，进入故事，并亲手改变原本的结局。**

