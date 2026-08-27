# 商城上架配置(shop/)

本目录存放 3 个技能包的上架配置 json(与商城发布接口字段对齐),供上架时对照填写或脚本消费。

## 字段说明

| 字段 | 说明 |
|---|---|
| `name` | 商城展示名(发布表单 name) |
| `desc` | 商城说明文(旧接口 desc;不填时发布接口会用标签串派生) |
| `price` | 售价,整数 token;`0` 表示免费。按运营定价修改 |
| `tags` | 展示标签,≤6 个、每个 ≤12 字;发布时与 SKILL.md frontmatter 的 tags 合并去重 |
| `icon` | 展示图标 emoji(已同步写入 SKILL.md frontmatter,发布时自动读取) |
| `file` | 上传的 zip 相对路径(用 `scripts/build-skill-zips.mjs` 重建产物) |
| `readme` | README 相对路径;zip 内已含 README.md,发布接口自动提取为商城说明区 |

## 上架步骤

1. 改动技能内容后运行 `node scripts/build-skill-zips.mjs`(需 tsx:`npx tsx scripts/build-skill-zips.mjs`)重建 zip;
2. 在商城「发布」页上传对应 zip,名称/标签按 json 填写(或直接改 json 的 price 后作为发布依据);
3. 提交后进入待审核状态,由管理端审核通过后上架展示。
