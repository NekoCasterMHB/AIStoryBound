// server/utils/config.ts
// 站点运行时配置(app_config 表,key-value):管理员在后台可改,无需重新部署。
// 约定:配置未写入时返回默认值(表为空也能正常工作)。
import type { H3Event } from 'h3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { appConfig } from '../db/schema'
import { eq } from 'drizzle-orm'
import { useD1 } from './d1'

/** 充值开关:1=关闭(维护中),0/缺省=开放 */
export const CONFIG_KEY_PAYMENT_DISABLED = 'payment_disabled'

type Db = DrizzleD1Database<Record<string, unknown>>

export async function getAppConfig(db: Db, key: string): Promise<string | undefined> {
  const row = await db.select({ value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .get()
  return row?.value
}

export async function setAppConfig(db: Db, key: string, value: string): Promise<void> {
  await db.insert(appConfig).values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } })
    .run()
}

/** 充值是否处于关闭(维护)状态:读取配置,缺省开放 */
export async function isPaymentDisabled(db: Db): Promise<boolean> {
  const v = await getAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED)
  return v === '1'
}

/** 充值是否处于关闭状态(带 event 便捷版,供支付相关接口使用) */
export function isPaymentDisabledEvent(event: H3Event): Promise<boolean> {
  return isPaymentDisabled(useD1(event))
}
