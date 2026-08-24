// server/api/admin/redeem/create.post.ts
// 管理员批量生成兑换码(仅 ADMIN_EMAIL 账号可调用;可配总量上限/每人限次/过期时间)。
// 完整码只在本次响应返回,后续列表接口不再回显完整码以外的信息(码本身仍可见,方便管理)。
import { generateRedeemCode } from '../../../../shared/redeem-code'
import { uuid } from '../../../../shared/novel'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { redeemCodes } from '../../../db/schema'

interface CreateBody {
  /** 每个码可兑换的 token 数 */
  tokens?: number
  /** 生成几个码(1~100) */
  count?: number
  /** 总用量上限,null=不限 */
  maxUses?: number | null
  /** 每人限用次数(默认 1=活动码每人限领一次) */
  perUserLimit?: number
  /** 过期时间(毫秒时间戳),null=永不过期 */
  expiresAt?: number | null
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<CreateBody>(event).catch(() => null)
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }

  const tokens = Math.floor(Number(body.tokens))
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'token 数量必须为正整数' })
  }
  const count = Math.floor(Number(body.count ?? 1))
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    throw createError({ statusCode: 400, statusMessage: '生成数量需在 1~100 之间' })
  }
  let maxUses: number | null = null
  if (body.maxUses !== undefined && body.maxUses !== null) {
    maxUses = Math.floor(Number(body.maxUses))
    if (!Number.isFinite(maxUses) || maxUses < 1) {
      throw createError({ statusCode: 400, statusMessage: '总用量上限必须为正整数' })
    }
  }
  let perUserLimit = 1
  if (body.perUserLimit !== undefined && body.perUserLimit !== null) {
    perUserLimit = Math.floor(Number(body.perUserLimit))
    if (!Number.isFinite(perUserLimit) || perUserLimit < 1) {
      throw createError({ statusCode: 400, statusMessage: '每人限用次数必须为正整数' })
    }
  }
  let expiresAt: Date | null = null
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const t = Number(body.expiresAt)
    if (!Number.isFinite(t) || t <= Date.now()) {
      throw createError({ statusCode: 400, statusMessage: '过期时间必须是未来的毫秒时间戳' })
    }
    expiresAt = new Date(t)
  }

  const db = useD1(event)
  const now = new Date()

  // 去重:与库中已有码撞码则重试(32^10 空间,碰撞概率可忽略)
  const existing = new Set(
    (await db.select({ code: redeemCodes.code }).from(redeemCodes).all()).map(r => r.code)
  )
  const inserted: { code: string, tokens: number, maxUses: number | null, perUserLimit: number, expiresAt: Date | null }[] = []
  while (inserted.length < count) {
    const code = generateRedeemCode()
    if (existing.has(code)) continue
    existing.add(code)
    inserted.push({ code, tokens, maxUses, perUserLimit, expiresAt })
  }

  await db.insert(redeemCodes).values(inserted.map(c => ({
    id: uuid(),
    ...c,
    usedCount: 0,
    disabled: 0,
    createdBy: admin.id,
    createdAt: now,
    updatedAt: now
  }))).run()

  return { ok: true, codes: inserted.map(c => c.code) }
})