## 收益(earnings)系统设计方案

### 现状(已核实)
skill/novel 成交时,各自的 `server/api/store/*/purchase.post.ts` 在 `db.batch` 里"扣买家款 → 卖家 `ai_token_balance + 80%分成`(直接入账)→ 计数+1 → 插购买行(快照 sellerShare/platformFee)"。无任何挂账/账本/待领取概念;无 admin 直接发 token 端点。收益单位=平台 token。

### 目标机制
一切收益(小说/技能销售分成 + 管理员手动发放)**先进入"待领取收益账本"**,用户在个人主页「收益」按钮看到角标 → 模态框列每笔 → 点「获取」/「一键全部领取」才把 token 加入 `ai_token_balance`。管理员发放带自定义原因,同样进该用户待领取列表。

### 1. 数据模型(新建,零迁移包袱)
`drizzle/init.sql` 末尾追加(幂等 CREATE TABLE/INDEX):
```sql
CREATE TABLE IF NOT EXISTS `earnings` (
  `id` text PRIMARY KEY NOT NULL,                 -- uuid()
  `user_id` text NOT NULL,                        -- 收款人
  `amount` integer NOT NULL,                      -- token,正整数
  `source_type` text NOT NULL,                    -- novel_sale | skill_sale | admin
  `source_id` text,                               -- 对应购买记录 id(admin 发放为空,溯源用)
  `item_title` text NOT NULL,                     -- 快照:《xx》销售分成 / 管理员发放
  `reason` text,                                  -- 自定义原因(仅 admin)
  `status` text DEFAULT 'pending' NOT NULL,       -- pending | claimed
  `created_at` integer NOT NULL,                  -- timestamp_ms
  `claimed_at` integer
);
CREATE INDEX IF NOT EXISTS `idx_earnings_user_status` ON `earnings` (`user_id`, `status`);
CREATE INDEX IF NOT EXISTS `idx_earnings_user_time` ON `earnings` (`user_id`, `created_at`);
```
跑 `node scripts/d1-migrate.mjs --remote`(dev 经 wrangler remote=true 直连云库,必须先建表)与 `--local` 保持两端同步。
新增 `shared/earnings.ts`:类型 + `EARNINGS_SOURCE_LABELS`(novel_sale 小说销售/skill_sale 技能销售/admin 管理员发放)+ 状态文案。

### 2. 服务端改动
**a) 两个 purchase API**(`server/api/store/novels/[id]/purchase.post.ts`、`skills/[id]/purchase.post.ts`,逐行同构)
- batch 里删除"卖家 `+sellerShare`"一条,改为同批插入一条 `earnings(pending, source_type='novel_sale'|'skill_sale', source_id=购买行id, item_title=商品标题, amount=sellerShare)`。
- 顺手修原子性缺口:batch 前先 SELECT 买家余额,不足直接 402;保留条件扣款与 batch 后 changes 校验作并发兜底(现状"0 行扣款仍提交卖家入账+购买行"的隐患一并收窄)。返回结构不变。

**b) 用户领取**(新 `POST /api/earnings/claim`,body `{ ids?: string[] }`,缺省=全部)
- 一次 `db.batch` 完成,利用 D1 batch 串行事务天然防并发双领:
  1) `UPDATE user SET ai_token_balance = ai_token_balance + (SELECT COALESCE(SUM(amount),0) FROM earnings WHERE id IN (ids|该用户全部) AND user_id=? AND status='pending')`(先按待领总额结算,子查询读到的是置 claimed 前的状态);
  2) `UPDATE earnings SET status='claimed', claimed_at=? WHERE 同条件 AND status='pending'`。
- 返回 `{ ok: true, credited, claimedCount }`;幂等(重复请求结算额为 0)。

**c) 列表与角标数据**
- 新 `GET /api/earnings`:本人全部收益(分页 page/pageSize≤50,返回 `{ rows, total }`,行含 item_title/reason/amount/status/created_at/claimed_at)。
- `server/api/profile/me.get.ts` 扩展返回 `pendingEarningsCount`、`pendingEarningsTotal`(COUNT/SUM pending)——profile 页现有 `loadMe()` 一处即可刷余额+角标。

**d) 管理员发放**(admin 中间件自动守护)
- 新 `POST /api/admin/earnings/send`:`{ userId, amount, reason }`;校验 amount 正整数、reason 去空格 ≤200 字、目标用户在 user 表存在;插入 `earnings(source_type='admin', item_title='管理员发放', reason, status='pending')`。返回 ok。
- 新 `GET /api/admin/earnings`:分页历史(join user 带收款人 name/email,可按关键词/状态过滤),格式对齐 admin/cache.get。

### 3. 前端改动
**a) 个人主页** `app/pages/profile.vue`
- 余额卡右上按钮组(约 975-992)加「收益」按钮;`pendingEarningsCount>0` 时按钮角上 `UBadge` 数字角标(样式参考 profile 1680-1698 / admin/index 待处理高亮)。
- 收益模态框(结构参考 profile.vue 2286-2346 购买记录弹窗):顶部"可领取 X token"+「一键全部领取」主按钮;列表每笔一行(item_title/来源/自定义原因、金额 +X token、时间、状态 UBadge 待领取/已领取);待领取行带「获取」单笔按钮;空态/加载态齐全。领取成功 → toast + `loadMe()` 刷新余额与角标 + 重拉列表(参考 submitRedeem 418-448 的刷新式样)。
- 进入页面即 `loadMe()`(已含),无需轮询;模态框每次打开重拉列表。

**b) 管理端**
- `app/layouts/admin.vue:16-28` nav 加「收益发放」项 → 新 `app/pages/admin/earnings.vue`(骨架参考 admin/redeem.vue:1-63):上方发放表单(用户搜索单选复用 `GET /api/admin/users?q=`,参考 admin/mail.vue 搜索/选择式样;金额输入;原因输入;提交)→ 下方发放历史列表(分页)。

**c) 文案同步**(5~8 处,`store/publish.vue`、`workshop/publish.vue`、`NovelStoreView.vue:150,992`、`StoreSkillsView.vue:160,1049`)
"收益在成交时直接进入您的余额" → "收益在成交后进入个人中心「收益」,领取后到账"。

### 4. 边界与不做
- 历史成交已在余额直接入账,**不回填**(避免重复发放),新列表只记机制启用后的收益。
- 不引入提现/退款/人民币钱包;币种维持 token;收益不占任何"池"(纯账本,领取时才产生余额变动)。
- 角标仅个人主页收益入口,不加全局导航(需求原文如此)。

### 5. 验证
1. `npx nuxt typecheck`;`d1-migrate --remote` + `--local`。
2. 本地 dev(4569,按 AGENTS.md 端口流程):a) 管理员页给 testuser 发一笔带原因收益 → testuser 登录个人主页见角标+列表 → 单笔/全部领取 → 余额增加、记录置已领取;b) 购买路径:admin 直发 skill(sellerId=admin)后 testuser 购买 → admin 收益为 pending(不直接入余额)而非即时到账。
3. 改后收尾关闭 dev 并确认端口释放。

### 不做
- 不改 git(需要提交时另说)。
