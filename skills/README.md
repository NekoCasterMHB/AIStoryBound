# AI StoryBound · 玩法技能包总览

本目录将全部玩法技能分为 **3 个大类**，每类一个标准 agent skill 包（SKILL.md + README.md + reference.md + LICENSE.txt），由 `scripts/build-skill-zips.mjs` 打包为可导入商城的 zip。

## 三大类与判定标准

| 目录 | 类名 | 判定标准 | 核心底色 |
|---|---|---|---|
| `01-light` | 小圈 | 管教向、**无性**、强度轻——以"过错→责罚→认错→和解"为叙事核心 | 关怀与纠正，情感陪伴 |
| `02-light-plus` | 小圈微大 | 管教底色 + **边缘性行为**（口舌/小型器具/浅插入），无性器官交合 | 管教之上加点"越界" |
| `03-bdsm` | BDSM | 性行为 + 深度权力交换 + 高强度/侵入/暴露/囚禁，越界程度即张力来源 | 权力与感官的极致 |

**判定口诀**：纯管教无性 → 小圈；有口舌/玩具/手指但不上真身 → 小圈微大；上真身、上强度、上暴露 → BDSM。

## 玩法总清单

### 01-light · 小圈（6 章）
训诫 discipline · 打屁股 spanking（OTK/板子）· 管教监督 supervision · 罚跪 kneeling · 挠痒痒 TK · 善后安抚 aftercare

### 02-light-plus · 小圈微大（9 章）
皮带绑手 belt-hands · 小玩具挑逗 toy-teasing · 阴蒂吮吸 clitoris-suck · 肛塞尾巴 tail-plug · 指奸 fingering · AV棒挑逗 wand-teasing · 震动棒插入 vibrator-insert · 蒙眼 blindfold · 乳首玩弄 nipple-play

### 03-bdsm · BDSM（18 章）
绳缚与束缚 · SM 权力游戏 · 强制高潮与高潮控制 · 鞭打与体罚 · 滴蜡与温度 · 电击 · 呼吸控制 · 针刺与穿孔 · 言语羞辱与脏话 · 宠物调教 · 角色扮演与制服 · 医疗名义调教 · 排泄与体液 · 暴露与公共场合 · 户外与场景性爱 · 性行为与服务 · 强迫剧本 CNC · 心奴与圈养

## 内容边界（仅三条硬性约束）

1. **不含未成年内容、不含兽交**（明确违法项，一律不写）。
2. **非自愿类仅以"强迫剧本 CNC"形式存在**：成人伴侣/主从间事先约定的征服式剧本，抗拒、挣扎、哭喊是剧本要素。
3. 其余全部放开：强度、伤害、暴露、囚禁、体液等越界程度均作为剧情张力服务，不设安全红线。

## 使用方式

- 每包 zip 可单独上架商城/导入本地，frontmatter 兼容 `shared/ai-skills.ts` 的 parseSkillMd（name/description/license），并带商城元数据 `icon`/`tags`（发布接口自动读取）。
- 上架配置见 `shop/` 目录：每包一个 json（name/price/tags/icon/zip 路径），zip 内含 README.md 供商城说明区展示。
- SKILL.md 为注入正文；reference.md 为随附参考（术语与描写词库，注入）；README.md 仅供商城展示，不注入提示词。
- 分类归属调整时，同步更新本文件与对应包的 README。
