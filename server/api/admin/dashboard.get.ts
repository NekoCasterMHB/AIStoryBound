// server/api/admin/dashboard.get.ts
// 管理仪表盘(requireAdmin):注册用户数(总量/近24h)、token 消耗(总量/近24h)、DeepSeek 账户余额。
// - 总消耗 = 注册赠送总量 + 已支付订单发放总量 + 兑换码已兑换总量 − 商城购买烧掉的手续费 − 当前全站余额
//   (存量恒等式,含全部历史,精确;商城手续费 = 买家全额扣款 − 卖家 80% 分成,20% 流出系统非 AI 消耗)
// - 近24h 消耗 = ai_usage 表 SUM(ai_usage 自 2026-08-27 起记录,更早的消耗无明细、由上面的恒等式兜底覆盖)
import { requireAdmin } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { getAiConfig } from '../../utils/ai'
import { FREE_TOKEN_GRANT } from '../../utils/auth'
import { getTokenPackageById } from '../../../shared/quota-packages'
import {
  user as usersTable,
  quotaPackageOrder,
  redeemCodeRedemptions,
  skillPurchases,
  novelPurchases,
  aiUsage
} from '../../db/schema'
import { eq, gte, count, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const now = Date.now()
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000)

  // ---- 注册用户 ----
  const totalUsers = await db.select({ n: count() }).from(usersTable).all()
  const dayUsers = await db.select({ n: count() }).from(usersTable)
    .where(gte(usersTable.createdAt, dayAgo)).all()

  // ---- 已支付订单发放总量(订单表未存 tokens,按套餐定义逐单折算) ----
  const paidOrders = await db.select({ packageId: quotaPackageOrder.packageId })
    .from(quotaPackageOrder)
    .where(eq(quotaPackageOrder.status, 'paid'))
    .all()
  const paidTokens = paidOrders.reduce((acc, o) => acc + (getTokenPackageById(o.packageId)?.tokens ?? 0), 0)

  // ---- 兑换码已兑换总量(redemptions 逐条快照,兑换即入账;漏算会让总消耗低估甚至为负) ----
  const redeemed = await db.select({ total: sql<number>`COALESCE(SUM(${redeemCodeRedemptions.tokens}), 0)` })
    .from(redeemCodeRedemptions)
    .all()

  // ---- 商城购买烧掉的手续费(买家全额扣款、卖家只得 80%,20% 手续费流出系统,不是 AI 消耗) ----
  const skillFees = await db.select({ total: sql<number>`COALESCE(SUM(${skillPurchases.platformFee}), 0)` })
    .from(skillPurchases)
    .all()
  const novelFees = await db.select({ total: sql<number>`COALESCE(SUM(${novelPurchases.platformFee}), 0)` })
    .from(novelPurchases)
    .all()

  // ---- 当前全站余额 ----
  const balance = await db.select({ total: sql<number>`COALESCE(SUM(${usersTable.aiTokenBalance}), 0)` }).from(usersTable).all()

  // ---- 近24h 消耗(ai_usage,自部署起记录) ----
  const dayUsage = await db.select({ total: sql<number>`COALESCE(SUM(${aiUsage.tokens}), 0)` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, dayAgo))
    .all()

  const totalUsersN = totalUsers[0]?.n ?? 0
  const totalBalance = balance[0]?.total ?? 0
  const redeemedTokens = redeemed[0]?.total ?? 0
  const platformFees = (skillFees[0]?.total ?? 0) + (novelFees[0]?.total ?? 0)
  const totalConsumed = totalUsersN * FREE_TOKEN_GRANT + paidTokens + redeemedTokens - platformFees - totalBalance

  // ---- 当前生效 AI 配置的账户余额(仅 DeepSeek 官方接口支持 /user/balance) ----
  // 所有分支都会赋值,无需初始值(no-useless-assignment)
  let deepseek: { available: boolean, balanceInfos: { currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string }[], error?: string } | null
  const ai = await getAiConfig(event)
  let deepseekHost = false
  try {
    deepseekHost = /deepseek/i.test(new URL(ai.baseUrl).hostname)
  } catch {
    // baseUrl 无法解析时按非 DeepSeek 处理
  }
  if (!ai.apiKey) {
    deepseek = { available: false, balanceInfos: [], error: '未配置平台 AI Key' }
  } else if (!deepseekHost) {
    deepseek = { available: false, balanceInfos: [], error: '当前生效配置非 DeepSeek 官方接口,不查询余额' }
  } else {
    try {
      // DeepSeek 余额接口在域名根路径(/user/balance),baseUrl 形如 https://api.deepseek.com/v1
      const base = ai.baseUrl.replace(/\/v\d+$/, '')
      const res = await fetch(`${base}/user/balance`, {
        headers: { Authorization: `Bearer ${ai.apiKey}` }
      })
      if (res.ok) {
        const data = await res.json() as {
          is_available?: boolean
          balance_infos?: { currency: string, total_balance: string, granted_balance: string, topped_up_balance: string }[]
        }
        deepseek = {
          available: !!data.is_available,
          balanceInfos: (data.balance_infos ?? []).map(b => ({
            currency: b.currency,
            totalBalance: b.total_balance,
            grantedBalance: b.granted_balance,
            toppedUpBalance: b.topped_up_balance
          }))
        }
      } else {
        deepseek = { available: false, balanceInfos: [], error: `HTTP ${res.status}` }
      }
    } catch (e) {
      deepseek = { available: false, balanceInfos: [], error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    users: {
      total: totalUsersN,
      day24: dayUsers[0]?.n ?? 0
    },
    tokens: {
      totalConsumed: Math.max(0, totalConsumed),
      day24Consumed: dayUsage[0]?.total ?? 0,
      /** 近24h 消耗自 ai_usage 表部署后开始记录(2026-08-27 前无明细,由总消耗恒等式覆盖) */
      day24From: 'ai_usage 表部署后开始记录'
    },
    deepseek,
    aiConfig: {
      name: ai.name ?? null,
      source: ai.source
    }
  }
})
