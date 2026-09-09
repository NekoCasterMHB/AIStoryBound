# AI Word2World(AI StoryBound)

> AI 小说驱动互动游戏平台 —— 上传一本小说,选择一个身份,进入故事,并亲手改变原本的结局。

**在线体验:[https://word2world.orange-trees.com/](https://word2world.orange-trees.com/)**

[![Made with Nuxt UI](https://img.shields.io/badge/Made%20with-Nuxt%20UI-00DC82?logo=nuxt&labelColor=020420)](https://ui.nuxt.com)
[![Deployed on Cloudflare Workers](https://img.shields.io/badge/Deployed%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

把任意一本小说交给 AI:它会拆解出完整的世界观(人物卡、地点、势力、时间线、世界规则、伏笔、剧情细纲),然后你可以**扮演书中的任意角色**进入故事——AI 按原著设定演绎,剧情随你的行动自由演化,结局由你亲手改写。

## ✨ 核心特性

- **🌍 一键生成世界**:按字数切段 → 逐段实体提取 → 合并去重 → AI 一致性检查 → 成书。大部头支持云端异步任务(Cloudflare Workflows),生成中可离开页面,完成后一键写回。
- **🎭 角色卡系统**:中文键值自由属性(约定键按引擎语义参与演绎,自定义键作为「补充设定」注入);配角**独立故事线**(扮演该角色时替代主线);**分段剧情 / 状态**——身份转变、受伤、身亡等随剧情演进的状态存在段文件里,进入对应段落时生效。
- **🕹 互动游戏**:自由输入 + 选项推进;剧情轨道(细纲 / 弧线 / 本段各角色分线)与节点里程碑引导节奏;角色动态状态(处境 / 位置 / 情绪 / 性欲值)随互动演进;卡住时自动混入「推进剧情」引导项。
- **💾 本地优先**:作品、游戏会话与存档存浏览器 IndexedDB,离线可用;一键整包云端备份/恢复,换设备不丢档。
- **📦 作品格式 v2**:标准 zip 作品包(归档全文 + 分段正典 + 角色卡 + 世界情报),支持导入导出与分享;旧格式一键迁移升级。
- **☁️ 平台能力**:邮箱验证码注册登录(Better Auth)、云端生成任务、Skill 商城(创意工坊)、需求墙、充值 / 兑换码、公告、管理员后台。
- **📱 PWA**:可安装到桌面 / 主屏,移动端全量适配。

> **🔞 内容提示**:平台含可选的**成人模式**(默认关闭,需手动开启),面向成年用户的亚文化 / BDSM 题材演绎;开启后内容直白,请确认当地法律与年龄要求。未开启时为一般向叙事。

## 🚀 快速开始

环境要求:**Node.js 20+**、**pnpm 10**、Cloudflare 账号(本地 dev 直连云端 D1/R2 需要 `npx wrangler login` 登录态)。

```bash
pnpm install

# 配置环境变量:复制模板并填写(至少 AI_API_KEY 与 BETTER_AUTH_SECRET)
cp .dev.vars.example .dev.vars

pnpm dev            # 默认 http://localhost:4569
```

> 本地 dev 默认**直连云端真实 D1/R2**(`wrangler.toml` 中 `remote = true`,Cloudflare Remote Bindings),启动日志出现 `Establishing remote connection...` 即生效;未登录 wrangler 时自动回退本地模拟。

### 环境变量

复制 `.dev.vars.example` 为 `.dev.vars` 填写(敏感值不入库;生产用 `wrangler secret put <KEY>`):

| 变量 | 用途 |
| --- | --- |
| `AI_API_KEY` | **必填**。LLM 网关 Key;`AI_BASE_URL` / `AI_MODEL` 已在 `wrangler.toml` 配置(默认 DeepSeek,可换 OpenAI / Moonshot / Groq 等任何兼容网关) |
| `BETTER_AUTH_SECRET` | **必填**。会话签名密钥(≥32 位随机串) |
| `CF_API_TOKEN_SEND_EMAIL` | 验证码邮件(Cloudflare Email Sending);本地留空则验证码打印到服务器日志 |
| `MICROPAY_PID` / `MICROPAY_PRIVATE_KEY` / `MICROPAY_PUBLIC_KEY` | 微支付网关(未配置时购买接口不可用) |
| `ADMIN_EMAIL` | 管理员邮箱(你自己注册的账号),否则 `/admin` 恒 403 |

## ☁️ 部署到 Cloudflare Workers

```bash
# 1. 敏感配置(一次性)
wrangler secret put AI_API_KEY
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put CF_API_TOKEN_SEND_EMAIL   # 可选:线上发验证码邮件
wrangler secret put MICROPAY_PRIVATE_KEY      # 可选:支付
wrangler secret put MICROPAY_PUBLIC_KEY

# 2. 数据库初始化 / 更新(全量 schema,幂等可重复执行)
pnpm db:migrate:remote

# 3. 预置小说元数据入 D1(正文走静态托管,可选)
pnpm seed:presets:remote

# 4. 构建 + 部署
pnpm deploy:cf
```

记得把 `wrangler.toml [vars]` 里的 `ADMIN_EMAIL` 改成你自己的注册邮箱。充值健康检查定时任务(每小时)与 Workflows 绑定已在配置中就绪。

<details>
<summary>预置小说(首页推荐列表)怎么维护</summary>

- 小说 TXT 放 `public/txt/`(随站点静态部署),元数据放 `public/txt/index.json`(可选,按文件名覆盖题材/推荐语/封面;不填则自动从首行解析《标题》与作者)。
- 改完执行 `pnpm seed:presets:remote` 幂等写入云端 D1(下载计数保留)。
- 数据库迁移统一为单个 `drizzle/init.sql`(全量 schema,`IF NOT EXISTS` 幂等);schema 变更时同步维护该文件,**不要**再运行 `pnpm db:generate`。

</details>

## 🗂 项目结构

```
app/                 # Nuxt 前端(页面:生成世界 / 书架 / 阅读 / 游玩 / 创意工坊 / 需求墙 / 后台)
shared/              # 前后端共享核心:世界生成管线(world-build)、游戏引擎(game)、
                     # 作品格式 v2(novel-v2)+ 角色卡解释器(character-interpreter)
server/              # Cloudflare Worker 后端:auth / world-gen(Workflows)/ games / payment /
                     # store / backups / presets / admin 等 API
docs/                # 设计文档:作品包格式 v2(format-v2.md)、支付接入、完整规划
drizzle/             # D1 全量 schema(init.sql,幂等)
public/txt/          # 预置小说静态资源
scripts/             # 种子 / 迁移 / PWA 图标等脚本
```

## 🧪 常用命令

```bash
pnpm dev                # 本地开发(默认 4569 端口)
pnpm test               # shared 核心单元测试(引擎 / 兼容矩阵 / 实体链接)
pnpm lint               # eslint
pnpm typecheck          # vue-tsc 全量类型检查
pnpm build:cf           # Cloudflare Workers 构建
pnpm deploy:cf          # 构建 + wrangler deploy
pnpm db:migrate:remote  # 迁移云端 D1(local 同理)
```

## 📖 作品格式

作品数据以 **v2 zip 作品包**为真源:归档全文 `fulltext` + 分段目录 `segments/`(正典节点 + 每角色「剧情 / 状态」文件)+ 基础角色卡 `characters/` + 世界情报 `world/`(实体库 / 冲突 / 配角弧线)。字段契约、值容忍规则与迁移兼容矩阵见 [docs/format-v2.md](./docs/format-v2.md)。

## ⚠️ 内容与责任声明

本项目生成的所有内容均为 AI 虚构,不代表任何真实人物与事件;成人模式内容仅限 **18+** 用户在合法地区使用。部署者需自行确保服务符合当地法律法规,并对公开部署的内容负责。

## License

[MIT](./LICENSE)
