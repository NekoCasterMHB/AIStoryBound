// server/api/admin/skills/[id]/review.post.ts
// Skill 审核(管理端):作用于该商品最新待审核版本 —
// 通过:版本 approved,并把名称/说明/售价同步到主表(成为新的在售快照),主表 status=approved;
// 拒绝:版本 rejected + 原因;主表保持旧的已上架版本在售(若存在),否则主表 status=rejected;
// 推荐开关(featured 0/1,仅优质 skill 打"平台推荐"标)。
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { skillProducts, skillProductVersions } from '../../../../db/schema'
import { eq, desc, sql } from 'drizzle-orm'

interface ReviewBody {
  status?: 'approved' | 'rejected'
  reason?: string
  featured?: boolean
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const body = await readBody<ReviewBody>(event).catch(() => null)
  if (body === null) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const mainRows = await db.select({ id: skillProducts.id }).from(skillProducts).where(eq(skillProducts.id, id)).all()
  if (mainRows.length === 0) throw createError({ statusCode: 404, statusMessage: 'Skill 不存在' })

  const hasStatus = body.status === 'approved' || body.status === 'rejected'
  const hasFeatured = typeof body.featured === 'boolean'
  if (!hasStatus && !hasFeatured) {
    throw createError({ statusCode: 400, statusMessage: '请提供审核状态或推荐标记' })
  }

  const now = new Date()

  // 最新待审核版本(没有待审版本时退化为最新版本,保证 featured 等操作仍可执行)
  const latestRows = await db.select({
    id: skillProductVersions.id,
    version: skillProductVersions.version,
    name: skillProductVersions.name,
    desc: skillProductVersions.desc,
    price: skillProductVersions.price
  })
    .from(skillProductVersions)
    .where(eq(skillProductVersions.skillId, id))
    .orderBy(desc(skillProductVersions.version))
    .limit(1)
    .all()
  const latest = latestRows[0]
  if (!latest) throw createError({ statusCode: 404, statusMessage: '该 Skill 还没有任何版本' })

  if (body.status === 'approved') {
    await db.update(skillProductVersions)
      .set({ status: 'approved', rejectReason: null, reviewedBy: admin.id, reviewedAt: now })
      .where(eq(skillProductVersions.id, latest.id))
      .run()
    // 最新版本通过 → 同步为新的在售快照
    await db.update(skillProducts)
      .set({
        name: latest.name,
        desc: latest.desc,
        price: latest.price,
        status: 'approved',
        rejectReason: null,
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(skillProducts.id, id))
      .run()
  } else if (body.status === 'rejected') {
    const reason = (body.reason ?? '').trim().slice(0, 200) || null
    await db.update(skillProductVersions)
      .set({ status: 'rejected', rejectReason: reason, reviewedBy: admin.id, reviewedAt: now })
      .where(eq(skillProductVersions.id, latest.id))
      .run()
    // 主表:仍有已上架版本则继续在售,否则回退为 rejected
    const approvedRows = await db.select({ id: skillProductVersions.id })
      .from(skillProductVersions)
      .where(sql`${skillProductVersions.skillId} = ${id} AND ${skillProductVersions.status} = 'approved'`)
      .all()
    await db.update(skillProducts)
      .set({
        status: approvedRows.length > 0 ? 'approved' : 'rejected',
        ...(approvedRows.length === 0 ? { rejectReason: reason } : {}),
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(skillProducts.id, id))
      .run()
  }

  if (hasFeatured) {
    await db.update(skillProducts)
      .set({ featured: body.featured ? 1 : 0, updatedAt: now })
      .where(eq(skillProducts.id, id))
      .run()
  }

  return { ok: true }
})