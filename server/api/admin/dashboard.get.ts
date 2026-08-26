// server/api/admin/dashboard.get.ts
// 管理仪表盘(requireAdmin):注册用户数(总量/近24h)、token 消耗(总量/近24h)、DeepSeek 账户余额。
// - 总消耗 = 注册赠送总量 + 已支付订单发放总量 - 当前全站余额(存量恒等式,含全部历史,精确)
// - 近24h 消耗 = ai_usage 表 SUM(自 ai_usage 部署起记录,历史数据无时间维度无法回填)
import { requireAdmin } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { getAiConfig } from '../../utils/ai'
import { FREE_TOKEN_GRANT } from '../../utils/auth'
import { getTokenPackageById } from '../../../shared/quota-packages'
import { user as usersTable, quotaPackageOrder, aiUsage } from '../../db/schema'
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

  // ---- 当前全站余额 ----
  const balance = await db.select({ total: sql<number>`COALESCE(SUM(${usersTable.aiTokenBalance}), 0)` }).from(usersTable).all()

  // ---- 近24h 消耗(ai_usage,自部署起记录) ----
  const dayUsage = await db.select({ total: sql<number>`COALESCE(SUM(${aiUsage.tokens}), 0)` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, dayAgo))
    .all()

  const totalUsersN = totalUsers[0]?.n ?? 0
  const totalBalance = balance[0]?.total ?? 0
  const totalConsumed = totalUsersN * FREE_TOKEN_GRANT + paidTokens - totalBalance

  // ---- DeepSeek 账户余额(平台 Key) ----
  let deepseek: { available: boolean, balanceInfos: { currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string }[], error?: string } | null = null
  const ai = getAiConfig(event)
  if (ai.apiKey) {
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
  } else {
    deepseek = { available: false, balanceInfos: [], error: '未配置 AI_API_KEY' }
  }

  return {
    users: {
      total: totalUsersN,
      day24: dayUsers[0]?.n ?? 0
    },
    tokens: {
      totalConsumed: Math.max(0, totalConsumed),
      day24Consumed: dayUsage[0]?.total ?? 0,
      /** 近24h 消耗自 ai_usage 表部署起记录;此前无时间维度数据 */
      day24From: 'ai_usage 表部署后开始记录'
    },
    deepseek
  }
})
