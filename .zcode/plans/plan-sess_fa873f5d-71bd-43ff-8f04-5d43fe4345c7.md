# 功能插件商城 + 个人中心配置弹窗

## 背景
- 创意工坊「功能插件」tab 目前是"开发中"占位(workshop/index.vue)
- Skill 商城链路完整(三表 + API + 组件),功能插件为**平台官方商品、适配器内置、购买=解锁配置入口**,无文件/版本/卖家,复用 Skill 链路反而要动 6+ 个 API,故新建两张轻量表
- 本地持久化仍是 IndexedDB(/toy 已有),本次新增的只是**云端商品与购买记录**

## 数据模型(D1 两张新表)

- `plugin_products`:id / name / desc / price(0=免费) / icon(emoji) / status(pending|approved|removed) / featured / purchase_count / created_at / updated_at
- `plugin_purchases`:id / plugin_id / buyer_id / price / created_at;唯一(plugin_id, buyer_id)幂等
- 同步 `drizzle/init.sql`(幂等),`pnpm db:migrate:local` 应用

## API(2 个,风格对齐 skills 链路)

- `GET /api/store/plugins` — 公开列表(仅 approved,免费优先/推荐在前),登录用户附带 `owned`
- `POST /api/store/plugins/[id]/purchase` — 幂等购买:0 价直接解锁记录;>0 价条件扣 aiTokenBalance(402 余额不足);官方商品无分成

## 上架(seed 脚本 `scripts/seed-plugins.ts`,幂等)

- 商品 `id=sosexy`,`啵啵贝智能联动 · 限时免费`,price=0,featured=1,icon 用 emoji
- package.json 加 `seed:plugins:local/remote`

## 前端

1. **`app/components/StorePluginsView.vue`** — 创意工坊功能插件商城:卡片(icon/名称/描述/限时免费 badge/价格)、购买按钮(0 价直接解锁)、已购显示"已解锁";未登录引导登录
2. **`app/components/ToyConfigModal.vue`** — 详细配置模态框(复用 toyController/IndexedDB 设置,与 /toy 同源):
   - 设置区:AI 自主控制开关(USwitch)、最大强度(USlider 0-100)、最大时长档位切换(10/30/60/不限)、冷却档位切换(0/3/5/10)
   - 连接区:模拟/真机**切换开关**(USwitch)+ 连接/断开 + 状态徽章
   - 控制区:每个功能一行——强度 USlider 0-100 + 模式档位**切换**(1..modeCount 按钮组)+ 时长档位切换 + 发送/停止
   - 紧急停止大红按钮
3. **个人中心(`profile.vue`)** — 新增「功能插件」tab:已购插件列表(名称/描述/状态),每项「详细配置」按钮打开 ToyConfigModal;未购买引导去创意工坊;支持 `/profile?tab=plugins`
4. **创意工坊(`workshop/index.vue`)** — 功能插件 slot 替换占位为 StorePluginsView
5. **`/toy` 页面控件改造(与模态框一致)**:连接方式改切换开关、模式/时长/冷却从数字输入框改档位切换(强度已是滑块)

## 验收

- `pnpm db:migrate:local` 通过、seed 幂等可重跑
- 购买 API:0 价解锁幂等、未登录 401
- typecheck / lint / demo:toy 全绿
- dev 冒烟:workshop?tab=plugins 商城渲染、个人中心 tab 直达、模态框打开
