## 邀请码系统设计方案(奖励调整为:双方各 +20 万 token,返利 15%)

### 机制总览
- 每个注册用户自动拥有一个专属邀请码(首次查看时懒生成,格式复用兑换码字符集,8 位)。
- 填写入口两处共用同一绑定 API:① 注册表单选填项(注册登录成功后自动提交);② 个人主页「邀请码」按钮模态框。每人只能绑定一次(唯一约束兜底)。
- 绑定成功:**双方立刻各 +200,000 token**(直接入 ai_token_balance,同一 D1 batch 原子完成)。
- 被邀请人**后续每次充值到账**时,邀请人获得充值 token 数的 **15%**,以 `earnings(pending, source_type='invite_rebate')` 进入邀请人收益列表,领取后入账。

### 1. 数据模型(新表,追加 init.sql + schema.ts,跑 migrate 两端)
```sql
-- 邀请码(码 → 主人;每用户至多一个码,懒生成)
CREATE TABLE IF NOT EXISTS `invite_codes` (
  `code` text PRIMARY KEY NOT NULL,      -- 8 位大写无易混字符
  `user_id` text NOT NULL,               -- 码主人
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_invite_code_user` ON `invite_codes` (`user_id`);

-- 邀请绑定关系(被邀请人为主键 = 每人只能被邀请一次)
CREATE TABLE IF NOT EXISTS `invite_relations` (
  `invitee_id` text PRIMARY KEY NOT NULL,
  `inviter_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`invitee_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `idx_invite_rel_inviter` ON `invite_relations` (`inviter_id`);
```

### 2. 服务端 API
**a) `GET /api/invite/mine`**(登录):返回 `{ code, bound, inviterName?, inviteeCount }`;无码则生成并插入(主人为自己;码冲突重试)。查 `invite_relations` 得 bound/inviterName(join user),inviteeCount = 我邀请的人数。

**b) `POST /api/invite/bind`** body `{ code }`(登录 + `createRateLimiter` 防爆破,复用 redeem 模式):
- normalize(复用 `shared/redeem-code.ts` 的 `normalizeRedeemCode`)→ 查码得 inviter;校验:码存在、**不能填自己的码**;
- 原子 `db.batch`:`INSERT invite_relations(invitee_id=我, inviter_id, now)`(PK 冲突 = 已绑定 → 409「已填写过邀请码」)+ 双方 `ai_token_balance + 200_000`;
- 预检友好报错(已绑定/码不存在/自己的码),并发竞态由唯一约束兜底转 409;返回 `{ ok: true, inviterName }`。

**c) 充值返利 — 重构 `server/utils/payment-credit.ts` 的 `creditPaidOrder` 为单 `db.batch`**(顺带修复现有并发重复入账窗口):
- 语句 1:订单置 paid 改为**条件更新** `WHERE order_no=? AND status!='paid'`(changes=0 → return 'success' 幂等短路,余额与返利全部跳过);无订单分支改同批 INSERT paid 订单(保留金额校验);
- 语句 2:买家 `+ pkg.tokens`(到账数以包定义 `pkg.tokens` 为准,与现状一致);
- 语句 3(条件):batch 前查 `invite_relations` 得买家邀请人,存在且 `Math.floor(pkg.tokens * 0.15) > 0` 时插 `earnings(inviter, 15%, 'invite_rebate', sourceId=订单 id, itemTitle='邀请返利:'+包名, pending)`;
- 三个充值入口(网关回调/跳回兜底/管理补单)共用此函数,自动全覆盖;余额 update changes=0(用户不存在)仍返回 'fail'。

**d) `shared/earnings.ts`**:`EarningsSourceType` 加 `'invite_rebate'`,`EARNINGS_SOURCE_LABELS.invite_rebate = '邀请返利'`。

### 3. 前端
**a) `app/components/AuthModal.vue` 注册表单**(regStep 'form'):加选填「邀请码」输入(placeholder 说明双方各得 20 万 token);`onFinishRegister` 中 `signIn.email` 成功后、`onLoginSuccess()` 前,若非空则调 bind(失败仅 toast 警告,不阻断登录)。

**b) `app/pages/profile.vue`**:
- 余额卡按钮行(收益/购买记录/兑换码)加第四个「邀请码」按钮(size sm,同款);
- 邀请码模态框:上半部分「我的邀请码」大字 + 复制按钮 + 已邀请 N 人;下半部分未绑定时显示邀请码输入 + 「绑定」按钮(成功 toast「双方已各获得 20 万 token」+ loadMe 刷新余额),已绑定显示「已绑定邀请人:xxx」;底部说明文案(双方各 20 万;好友后续充值的 15% 将以「邀请返利」进入你的收益列表);
- 本地 `EarningsItem.sourceType` 联合类型补 `'invite_rebate'`(该处是手抄副本,须同步);收益列表非 admin 条目走 itemTitle 默认展示,自动生效。

### 4. 边界
- 奖励直接入余额(不走收益列表);返利走收益列表(用户明确要求);返利基于实际到账 tokens(含新人包);退款不追回返利(范围外);绑定后关系不可改;绑定时机=邮箱已验证+已登录,防未验证刷奖励。
- 历史充值不补发返利(仅绑定后新充值)。

### 5. 验证
1. `npx nuxt typecheck`;`node scripts/d1-migrate.mjs --remote` + `--local`。
2. dev(4569,按端口规范)HTTP 级 E2E:注册第二个测试号(或直接用 curl 建)→ GET mine 得码 → testuser bind → 双方余额各 +20 万、重复 bind 返回 409、填自己的码被拒;给被邀请人造一笔 paid 订单走 creditPaidOrder 路径 → 邀请人收益列表出现 15% 邀请返利 pending;重复调用同单不重复入账/返利。
3. 测试数据清理、关 dev、确认端口释放。

### 不做
- 不提交 git;不做邀请排行榜/返利提现等扩展。