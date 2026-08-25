# Nuxt Starter Template

[![Nuxt UI](https://img.shields.io/badge/Made%20with-Nuxt%20UI-00DC82?logo=nuxt&labelColor=020420)](https://ui.nuxt.com)

Use this template to get started with [Nuxt UI](https://ui.nuxt.com) quickly.

- [Live demo](https://starter-template.nuxt.dev/)
- [Documentation](https://ui.nuxt.com/docs/getting-started/installation/nuxt)

<a href="https://starter-template.nuxt.dev/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ui.nuxt.com/assets/templates/nuxt/starter-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://ui.nuxt.com/assets/templates/nuxt/starter-light.png">
    <img alt="Nuxt Starter Template" src="https://ui.nuxt.com/assets/templates/nuxt/starter-light.png" width="830" height="466">
  </picture>
</a>

> The starter template for Vue is on https://github.com/nuxt-ui-templates/starter-vue.

## Quick Start

```bash [Terminal]
npm create nuxt@latest -- -t ui
```

## Deploy your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-name=starter&repository-url=https%3A%2F%2Fgithub.com%2Fnuxt-ui-templates%2Fstarter&demo-image=https%3A%2F%2Fui.nuxt.com%2Fassets%2Ftemplates%2Fnuxt%2Fstarter-dark.png&demo-url=https%3A%2F%2Fstarter-template.nuxt.dev%2F&demo-title=Nuxt%20Starter%20Template&demo-description=A%20minimal%20template%20to%20get%20started%20with%20Nuxt%20UI.)

## Setup

Make sure to install the dependencies:

```bash
pnpm install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
pnpm dev
```

## Production

Build the application for production:

```bash
pnpm build
```

Locally preview production build:

```bash
pnpm preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.

## Renovate integration

Install [Renovate GitHub app](https://github.com/apps/renovate/installations/select_target) on your repository and you are good to go.

---

## AI SpankWorld 项目说明

小说驱动互动游戏平台：预置小说（静态部署 public/txt/ + D1 索引）→ 预览阅读（全文自动缓存到浏览器 IndexedDB）→ 一键生成世界观 → 选角色进入 AI 互动故事。

### 本地开发

```bash
pnpm install
pnpm dev            # http://localhost:4569(环境变量模板见 .env.example,复制为 .dev.vars 并填写 AI_API_KEY 等)
pnpm db:migrate:remote   # 应用 drizzle/init.sql 初始化脚本到云端 D1(幂等,可重复执行)
```

> ⚠️ 本地 dev 默认**直连云端真实 D1**(见 `wrangler.toml` 中 `[[d1_databases]]` 的 `remote = true`,Cloudflare Remote Bindings),需要 wrangler 登录态(`npx wrangler whoami` 确认)。`pnpm dev` 启动时日志出现 `Establishing remote connection...` 即表示直连生效;云端库结构变更后执行 `pnpm db:migrate:remote` 同步。

### 预置小说（首页推荐列表）

- 小说 TXT 放 `public/txt/`（随站点静态部署，部署后可直接访问 `/txt/<书名>.txt`），元数据放 `public/txt/index.json`（可选，按文件名覆盖题材/推荐语/封面等；不填则自动从首行解析《标题》与作者、首段作推荐语）。
- 运行种子脚本把元数据写入 D1（正文无需上传，由 wrangler `[assets]` 托管、下载接口经 ASSETS binding 直读）：
  ```bash
  pnpm seed:presets:remote   # 云端 D1(wrangler 需已登录;dev 直连云端,改完 presets 后跑这个)
  pnpm seed:presets:local    # 本地 miniflare D1(仅当临时去掉 remote=true 退回本地模拟时用)
  ```
- 重复执行会幂等更新（下载计数保留）。

### 常用命令

```bash
pnpm db:migrate:remote # 应用 drizzle/init.sql 初始化脚本到云端 D1(幂等)
pnpm db:migrate:local  # 应用到本地 miniflare D1
pnpm build:cf          # cloudflare_module 构建
pnpm deploy:cf         # 构建 + wrangler deploy
pnpm lint / pnpm typecheck
```

> 数据库迁移已统一为单个 `drizzle/init.sql`(全量 schema,所有语句 `IF NOT EXISTS` 幂等,可重复执行)。schema 变更时同步维护该文件,见文件头部注释;请勿再运行 `pnpm db:generate`。
