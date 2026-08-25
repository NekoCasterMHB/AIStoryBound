// server/api/profile/gen-limits.put.ts
// 保存当前用户的生成参数(D1 users 表):整表替换,越界值钳制到合法范围,缺失字段回落默认值。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { user as usersTable } from '../../db/schema'
import { normalizeGenLimits } from '../../../shared/gen-limits'
import type { GenLimits } from '../../../shared/gen-limits'

/** 生成参数对应的 users 表整数列(字面量收窄,避免 drizzle set() 收到宽泛列名类型) */
type GenLimitColumn = 'genUnitMaxChars' | 'genUnitOverlapChars' | 'genExtractMaxTokens' | 'genCheckMaxTokens' | 'genSynthMaxTokens' | 'genRelayTimeoutSec'

/** GenLimits 字段 → users 表列名(GET/PUT 共用,避免两处手写列名漂移) */
export const GEN_LIMIT_COLUMNS: Record<keyof GenLimits, GenLimitColumn> = {
  unitMaxChars: 'genUnitMaxChars',
  unitOverlapChars: 'genUnitOverlapChars',
  extractMaxTokens: 'genExtractMaxTokens',
  checkMaxTokens: 'genCheckMaxTokens',
  synthMaxTokens: 'genSynthMaxTokens',
  relayTimeoutSec: 'genRelayTimeoutSec'
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const body = await readBody<Partial<Record<keyof GenLimits, unknown>>>(event).catch(() => ({}))
  const limits = normalizeGenLimits(body)
  const db = useD1(event)
  const update: Partial<Record<GenLimitColumn, number>> = {}
  for (const key of Object.keys(GEN_LIMIT_COLUMNS) as (keyof GenLimits)[]) {
    update[GEN_LIMIT_COLUMNS[key]] = limits[key]
  }
  await db.update(usersTable).set(update).where(eq(usersTable.id, sessUser.id)).run()
  return { ok: true, ...limits }
})
