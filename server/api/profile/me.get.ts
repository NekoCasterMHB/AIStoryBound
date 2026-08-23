// server/api/profile/me.get.ts
// 当前用户信息 + 平台 token 余额(自建 AI 配置走 /api/profile/ai-config)
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { eq } from 'drizzle-orm'
import { user as usersTable } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const row = await db.select().from(usersTable).where(eq(usersTable.id, sessUser.id)).get()

  return {
    id: sessUser.id,
    name: sessUser.name,
    email: sessUser.email,
    aiTokenBalance: row?.aiTokenBalance ?? 0
  }
})
