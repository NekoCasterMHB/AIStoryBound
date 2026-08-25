// server/api/profile/gen-limits.get.ts
// 读取当前用户的生成参数(D1 users 表,列可空):未设置的字段回落默认值,钳制到合法范围。
// 附 stored 标记:云端正存过非默认配置时为 true(客户端据此做旧 localStorage 一次性迁移,避免重复推送)。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { user as usersTable } from '../../db/schema'
import { DEFAULT_GEN_LIMITS, GEN_LIMIT_KEYS, normalizeGenLimits } from '../../../shared/gen-limits'
import type { GenLimits } from '../../../shared/gen-limits'
import { GEN_LIMIT_COLUMNS } from './gen-limits.put'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const row = await db.select().from(usersTable).where(eq(usersTable.id, sessUser.id)).get()
  const stored = row !== undefined && GEN_LIMIT_KEYS.some(k => row[GEN_LIMIT_COLUMNS[k]] != null)
  const limits: GenLimits = normalizeGenLimits(row ? {
    unitMaxChars: row[GEN_LIMIT_COLUMNS.unitMaxChars],
    unitOverlapChars: row[GEN_LIMIT_COLUMNS.unitOverlapChars],
    extractMaxTokens: row[GEN_LIMIT_COLUMNS.extractMaxTokens],
    checkMaxTokens: row[GEN_LIMIT_COLUMNS.checkMaxTokens],
    synthMaxTokens: row[GEN_LIMIT_COLUMNS.synthMaxTokens],
    relayTimeoutSec: row[GEN_LIMIT_COLUMNS.relayTimeoutSec]
  } : null)
  return { ...limits, stored, hasDefaults: GEN_LIMIT_KEYS.every(k => limits[k] === DEFAULT_GEN_LIMITS[k]) }
})