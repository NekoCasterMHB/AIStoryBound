// server/api/admin/novels/[id]/review.post.ts
// 小说审核(管理端):作用于该商品最新待审核版本 —
// 通过:版本 approved,并把书名/作者/简介/售价/预览字数/全书字数同步到主表(成为新的在售快照),主表 status=approved;
// 拒绝:版本 rejected + 原因;在售商品的新版本被拒 → 维持旧版本在售;整体待审(首次发布/下架后重新上架)被拒 → 主表回退 rejected;
// 推荐开关(featured 0/1,仅优质小说打"平台推荐"标)。
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { novelProducts, novelProductVersions } from '../../../../db/schema'
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
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const body = await readBody<ReviewBody>(event).catch(() => null)
  if (body === null) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const mainRows = await db.select({ id: novelProducts.id, status: novelProducts.status, mainVersion: novelProducts.mainVersion }).from(novelProducts).where(eq(novelProducts.id, id)).all()
  const mainRow = mainRows[0]
  if (!mainRow) throw createError({ statusCode: 404, statusMessage: '小说不存在' })

  const hasStatus = body.status === 'approved' || body.status === 'rejected'
  const hasFeatured = typeof body.featured === 'boolean'
  if (!hasStatus && !hasFeatured) {
    throw createError({ statusCode: 400, statusMessage: '请提供审核状态或推荐标记' })
  }

  const now = new Date()

  // 最新待审核版本(没有待审版本时退化为最新版本,保证 featured 等操作仍可执行)
  const latestRows = await db.select({
    id: novelProductVersions.id,
    version: novelProductVersions.version,
    title: novelProductVersions.title,
    author: novelProductVersions.author,
    desc: novelProductVersions.desc,
    price: novelProductVersions.price,
    previewChars: novelProductVersions.previewChars,
    totalChars: novelProductVersions.totalChars
  })
    .from(novelProductVersions)
    .where(eq(novelProductVersions.novelId, id))
    .orderBy(desc(novelProductVersions.version))
    .limit(1)
    .all()
  const latest = latestRows[0]
  if (!latest) throw createError({ statusCode: 404, statusMessage: '该小说还没有任何版本' })

  if (body.status === 'approved') {
    await db.update(novelProductVersions)
      .set({ status: 'approved', rejectReason: null, reviewedBy: admin.id, reviewedAt: now })
      .where(eq(novelProductVersions.id, latest.id))
      .run()
    // 最新版本通过 → 同步为新的在售快照
    await db.update(novelProducts)
      .set({
        title: latest.title,
        author: latest.author,
        desc: latest.desc,
        price: latest.price,
        previewChars: latest.previewChars,
        totalChars: latest.totalChars,
        status: 'approved',
        rejectReason: null,
        mainVersion: latest.version,
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(novelProducts.id, id))
      .run()
  } else if (body.status === 'rejected') {
    const reason = (body.reason ?? '').trim().slice(0, 200) || null
    await db.update(novelProductVersions)
      .set({ status: 'rejected', rejectReason: reason, reviewedBy: admin.id, reviewedAt: now })
      .where(eq(novelProductVersions.id, latest.id))
      .run()
    // 主表:在售商品的新版本被拒 → 维持旧版本在售;整体待审(首次发布/重新上架)被拒 → 保持未上架
    const approvedRows = await db.select({ id: novelProductVersions.id })
      .from(novelProductVersions)
      .where(sql`${novelProductVersions.novelId} = ${id} AND ${novelProductVersions.status} = 'approved'`)
      .all()
    const keepSelling = mainRow.status === 'approved' && approvedRows.length > 0
    await db.update(novelProducts)
      .set({
        status: keepSelling ? 'approved' : 'rejected',
        ...(keepSelling ? {} : { rejectReason: reason }),
        // 手动设置的主版本若指向被拒版本 → 回退为最新已上架版本
        ...(mainRow.mainVersion === latest.version ? { mainVersion: null } : {}),
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(novelProducts.id, id))
      .run()
  }

  if (hasFeatured) {
    await db.update(novelProducts)
      .set({ featured: body.featured ? 1 : 0, updatedAt: now })
      .where(eq(novelProducts.id, id))
      .run()
  }

  return { ok: true }
})
