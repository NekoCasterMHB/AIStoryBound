// server/api/invite/mine.get.ts
// 我的邀请码信息:懒生成专属码(每用户至多一个,唯一索引兜底)+ 绑定状态 + 已邀请人数。
// 个人主页「邀请码」模态框打开时调用。
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { count, eq } from 'drizzle-orm'
import { user as usersTable, inviteCodes, inviteRelations } from '../../db/schema'
import { generateRedeemCode } from '../../../shared/redeem-code'
import { INVITE_CODE_LENGTH } from '../../../shared/invite'

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const db = useD1(event)

  // 懒生成专属邀请码:查不到则生成并插入(码冲突重试;user_id 唯一索引兜底并发下重复生成)
  let rows = await db.select().from(inviteCodes).where(eq(inviteCodes.userId, me.id)).all()
  if (rows.length === 0) {
    for (let attempt = 0; attempt < 5 && rows.length === 0; attempt++) {
      const code = generateRedeemCode(INVITE_CODE_LENGTH)
      await db.insert(inviteCodes).values({ code, userId: me.id, createdAt: new Date() })
        .onConflictDoNothing().run()
      rows = await db.select().from(inviteCodes).where(eq(inviteCodes.userId, me.id)).all()
    }
    if (rows.length === 0) {
      throw createError({ statusCode: 500, statusMessage: '邀请码生成失败,请稍后重试' })
    }
  }
  const code = rows[0]!.code

  // 绑定状态与邀请人昵称
  const relRows = await db.select({ inviterId: inviteRelations.inviterId })
    .from(inviteRelations)
    .where(eq(inviteRelations.inviteeId, me.id))
    .all()
  let inviterName: string | null = null
  if (relRows.length > 0) {
    const inviterRows = await db.select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, relRows[0]!.inviterId))
      .all()
    inviterName = inviterRows[0]?.name ?? null
  }

  // 我邀请的人数
  const cntRows = await db.select({ n: count() })
    .from(inviteRelations)
    .where(eq(inviteRelations.inviterId, me.id))
    .all()

  return {
    code,
    bound: relRows.length > 0,
    inviterName,
    inviteeCount: cntRows[0]?.n ?? 0
  }
})
