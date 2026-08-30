// server/api/admin/dashboard.get.ts
// 管理仪表盘(requireAdmin):注册用户数(总量/近24h)、充值收入(总量/近24h)、token 消耗(总量/近24h)、
// 各模块待审核计数(Skill/小说/待处理需求)、AI 配置生效状态、各已保存 AI 配置的账户余额。
// - 总消耗 = 注册赠送总量 + 已支付订单发放总量 + 兑换码已兑换总量 − 商城购买烧掉的手续费 − 当前全站余额
//   (存量恒等式,含全部历史,精确;商城手续费 = 买家全额扣款 − 卖家 80% 分成,20% 流出系统非 AI 消耗)
// - 近24h 消耗 = ai_usage 表 SUM(ai_usage 自 2026-08-27 起记录,更早的消耗无明细、由上面的恒等式兜底覆盖)
// - 余额:扫描全部已保存配置(含未启用与环境变量),按 baseUrl 识别平台(DeepSeek / MuskAPI),
//   不支持的平台不发请求、由前端显示「不支持」。
import { requireAdmin } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { getAiConfig, getEnvConfig, getAiPurposeRouting } from '../../utils/ai'
import { AI_ROUTE_ENV } from '../../../shared/ai-config'
import { FREE_TOKEN_GRANT } from '../../utils/auth'
import { getTokenPackageById } from '../../../shared/quota-packages'
import { decryptJson } from '../../utils/crypto'
import {
  user as usersTable,
  quotaPackageOrder,
  redeemCodeRedemptions,
  skillPurchases,
  novelPurchases,
  aiUsage,
  aiProviderConfigs,
  skillProducts,
  novelProducts,
  featureRequests
} from '../../db/schema'
import { eq, gte, and, count, sql } from 'drizzle-orm'

export interface DeepseekBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export interface MuskAccountInfo {
  /** 钱包/订阅余额(余额模式) */
  balance: number | null
  /** Key 剩余额度(限额度模式取 quota.remaining) */
  remaining: number | null
  unit: string
  isValid: boolean
  /** unrestricted=钱包/订阅模式 | quota_limited=Key 自带额度 */
  mode: string | null
  /** 累计消费(usage.total.actual_cost) */
  totalCost: number | null
}

export interface AccountBalance {
  label: string
  source: 'db' | 'env'
  provider: 'deepseek' | 'muskapi' | 'unknown'
  /** 平台是否支持余额查询(不支持时前端显示「不支持」) */
  supported: boolean
  available: boolean
  active: boolean
  model: string | null
  balanceInfos?: DeepseekBalanceInfo[]
  musk?: MuskAccountInfo
  error?: string
}

/** 按 baseUrl 识别余额查询支持的平台 */
function detectProvider(baseUrl: string): AccountBalance['provider'] {
  try {
    const host = new URL(baseUrl).hostname
    if (/deepseek/i.test(host)) return 'deepseek'
    if (/muskapi/i.test(host)) return 'muskapi'
  } catch {
    // baseUrl 无法解析按不支持处理
  }
  return 'unknown'
}

/** 余额查询结果(fetchDeepseek / fetchMuskapi 共用返回类型) */
type BalanceFetchResult = Pick<AccountBalance, 'available' | 'error'> & Partial<Pick<AccountBalance, 'balanceInfos' | 'musk'>>

/** 查 DeepSeek 官方余额(/user/balance,域名根路径) */
async function fetchDeepseek(baseUrl: string, apiKey: string): Promise<BalanceFetchResult> {
  const base = baseUrl.replace(/\/v\d+$/, '')
  try {
    const res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` }
    const data = await res.json() as {
      is_available?: boolean
      balance_infos?: { currency: string, total_balance: string, granted_balance: string, topped_up_balance: string }[]
    }
    return {
      available: !!data.is_available,
      balanceInfos: (data.balance_infos ?? []).map(b => ({
        currency: b.currency,
        totalBalance: b.total_balance,
        grantedBalance: b.granted_balance,
        toppedUpBalance: b.topped_up_balance
      }))
    }
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 查 MuskAPI 用量/余额(GET /v1/usage,见 https://docs.muskapi.cc/guide/key-usage-balance) */
async function fetchMuskapi(baseUrl: string, apiKey: string): Promise<BalanceFetchResult> {
  // usage 端点固定为 /v1/usage:baseUrl 已带 /v1 则直接拼 /usage
  const base = baseUrl.replace(/\/v\d+$/, '')
  try {
    const res = await fetch(`${base}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` }
    const data = await res.json() as {
      mode?: string
      isValid?: boolean
      balance?: number
      remaining?: number
      unit?: string
      quota?: { remaining?: number, unit?: string }
      usage?: { total?: { actual_cost?: number } }
    }
    const info: MuskAccountInfo = {
      balance: typeof data.balance === 'number' ? data.balance : null,
      remaining: typeof data.remaining === 'number'
        ? data.remaining
        : typeof data.quota?.remaining === 'number' ? data.quota.remaining : null,
      unit: data.unit ?? data.quota?.unit ?? 'USD',
      isValid: !!data.isValid,
      mode: data.mode ?? null,
      totalCost: typeof data.usage?.total?.actual_cost === 'number' ? data.usage.total.actual_cost : null
    }
    return { available: info.isValid, musk: info }
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const now = Date.now()
  const dayAgoMs = now - 24 * 60 * 60 * 1000
  const dayAgo = new Date(dayAgoMs)

  // ---- 注册用户 ----
  const totalUsers = await db.select({ n: count() }).from(usersTable).all()
  const dayUsers = await db.select({ n: count() }).from(usersTable)
    .where(gte(usersTable.createdAt, dayAgo)).all()

  // ---- 充值收入(已支付订单实付金额,分;支付时间兜底用创建时间,paidAt 可能为空) ----
  const paid = eq(quotaPackageOrder.status, 'paid')
  const paidTime = sql`COALESCE(${quotaPackageOrder.paidAt}, ${quotaPackageOrder.createdAt})`
  const revTotal = await db.select({ total: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)` })
    .from(quotaPackageOrder)
    .where(paid)
    .all()
  const revDay24 = await db.select({ total: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)` })
    .from(quotaPackageOrder)
    .where(and(paid, gte(paidTime, dayAgoMs)))
    .all()

  // ---- 待审核计数(与审核列表同口径:每商品最新提交版本 pending 才算,旧 pending 版本不重复计) ----
  const pendingSkills = await db.select({ n: count() }).from(skillProducts)
    .where(sql`(SELECT status FROM skill_product_versions WHERE skill_id = ${skillProducts.id} ORDER BY version DESC LIMIT 1) = 'pending'`)
    .all()
  const pendingNovels = await db.select({ n: count() }).from(novelProducts)
    .where(sql`(SELECT status FROM novel_product_versions WHERE novel_id = ${novelProducts.id} ORDER BY version DESC LIMIT 1) = 'pending'`)
    .all()
  // 需求墙无审核流,「待处理」= 待实现(open)
  const pendingRequests = await db.select({ n: count() }).from(featureRequests)
    .where(eq(featureRequests.status, 'open'))
    .all()

  // ---- 已支付订单发放总量(订单表未存 tokens,按套餐定义逐单折算) ----
  const paidOrders = await db.select({ packageId: quotaPackageOrder.packageId })
    .from(quotaPackageOrder)
    .where(paid)
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

  // ---- AI 配置生效状态(生效配置 + 用途路由指向 + 启用数) ----
  const configRows = await db.select().from(aiProviderConfigs).all()
  const nameOfConfig = (id: string) => configRows.find(r => r.id === id)?.name ?? id
  const routing = await getAiPurposeRouting(event)
  const resolveRouting = (id: string | null | undefined) => {
    if (!id) return null
    if (id === AI_ROUTE_ENV) return '环境变量'
    return nameOfConfig(id)
  }

  // ---- 各已保存配置的账户余额(扫描全部配置,无论是否启用;环境变量条目也纳入) ----
  const accounts: AccountBalance[] = []
  for (const row of configRows) {
    const provider = detectProvider(row.baseUrl)
    const item: AccountBalance = {
      label: row.name || '未命名配置',
      source: 'db',
      provider,
      supported: provider !== 'unknown',
      available: false,
      active: row.active === 1,
      model: row.model || null
    }
    if (!item.supported) {
      accounts.push(item)
      continue
    }
    const apiKey = await decryptJson<string>(event, row.apiKeyCiphertext, row.apiKeyIv)
    if (!apiKey) {
      item.error = 'apiKey 解密失败(密钥变更?)'
      accounts.push(item)
      continue
    }
    const r = provider === 'deepseek'
      ? await fetchDeepseek(row.baseUrl, apiKey)
      : await fetchMuskapi(row.baseUrl, apiKey)
    item.available = r.available
    if (r.balanceInfos) item.balanceInfos = r.balanceInfos
    if (r.musk) item.musk = r.musk
    if (r.error) item.error = r.error
    accounts.push(item)
  }
  // 环境变量条目:配置了 key 才有可查的账户
  const env = getEnvConfig(event)
  if (env.apiKey) {
    const provider = detectProvider(env.baseUrl)
    const item: AccountBalance = {
      label: '环境变量',
      source: 'env',
      provider,
      supported: provider !== 'unknown',
      available: false,
      active: false,
      model: env.model || null
    }
    if (item.supported) {
      const r = provider === 'deepseek'
        ? await fetchDeepseek(env.baseUrl, env.apiKey)
        : await fetchMuskapi(env.baseUrl, env.apiKey)
      item.available = r.available
      if (r.balanceInfos) item.balanceInfos = r.balanceInfos
      if (r.musk) item.musk = r.musk
      if (r.error) item.error = r.error
    }
    accounts.push(item)
  }

  const effective = await getAiConfig(event)
  return {
    users: {
      total: totalUsersN,
      day24: dayUsers[0]?.n ?? 0
    },
    revenue: {
      /** 已支付订单实付总额(分) */
      total: revTotal[0]?.total ?? 0,
      day24: revDay24[0]?.total ?? 0
    },
    tokens: {
      totalConsumed: Math.max(0, totalConsumed),
      day24Consumed: dayUsage[0]?.total ?? 0,
      /** 近24h 消耗自 ai_usage 表部署后开始记录(2026-08-27 前无明细,由总消耗恒等式覆盖) */
      day24From: 'ai_usage 表部署后开始记录'
    },
    pending: {
      skills: pendingSkills[0]?.n ?? 0,
      novels: pendingNovels[0]?.n ?? 0,
      requests: pendingRequests[0]?.n ?? 0
    },
    accounts,
    aiConfig: {
      name: effective.name ?? null,
      source: effective.source,
      model: effective.model,
      baseUrl: effective.baseUrl,
      activeCount: configRows.filter(r => r.active === 1).length,
      totalCount: configRows.length,
      routing: {
        worldGen: resolveRouting(routing.worldGen),
        chat: resolveRouting(routing.chat)
      }
    }
  }
})
