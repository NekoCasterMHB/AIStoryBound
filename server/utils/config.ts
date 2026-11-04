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

/** 进入维护的原因(健康检查自动关闭/管理员手动关闭时写入;恢复开放时清除) */
export const CONFIG_KEY_PAYMENT_DISABLED_REASON = 'payment_disabled_reason'

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

/** 删除一条配置(用于恢复开放时清除维护原因) */
export async function deleteAppConfig(db: Db, key: string): Promise<void> {
  await db.delete(appConfig).where(eq(appConfig.key, key)).run()
}

/** 充值是否处于关闭(维护)状态:读取配置,缺省开放 */
export async function isPaymentDisabled(db: Db): Promise<boolean> {
  const v = await getAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED)
  return v === '1'
}

/** 当前维护原因(未维护/无原因返回 undefined) */
export function getPaymentDisabledReason(db: Db): Promise<string | undefined> {
  return getAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON)
}

/** 微信支付渠道开关:1=单独禁用,0/缺省=开放(管理员后台可改) */
export const CONFIG_KEY_WXPAY_DISABLED = 'payment_disabled_wxpay'

/** 支付宝渠道开关:1=单独禁用,0/缺省=开放(管理员后台可改) */
export const CONFIG_KEY_ALIPAY_DISABLED = 'payment_disabled_alipay'

/** 渠道单独禁用的原因(管理员手动关闭时写入,恢复开放时清除) */
export const CONFIG_KEY_WXPAY_DISABLED_REASON = 'payment_disabled_wxpay_reason'
export const CONFIG_KEY_ALIPAY_DISABLED_REASON = 'payment_disabled_alipay_reason'

export type PayChannel = 'wxpay' | 'alipay'

/** 渠道是否有效禁用:渠道开关为 1,或全局维护(健康检查自动关闭)时对所有渠道生效 */
export async function isChannelDisabled(db: Db, channel: PayChannel): Promise<boolean> {
  if (await isPaymentDisabled(db)) return true
  const key = channel === 'wxpay' ? CONFIG_KEY_WXPAY_DISABLED : CONFIG_KEY_ALIPAY_DISABLED
  return (await getAppConfig(db, key)) === '1'
}

/** 渠道是否有效禁用(带 event 便捷版) */
export function isChannelDisabledEvent(event: H3Event, channel: PayChannel): Promise<boolean> {
  return isChannelDisabled(useD1(event), channel)
}

/** 渠道单独禁用原因(未单独禁用/无原因返回 undefined;全局维护不算渠道单独禁用) */
export async function getChannelDisabledReason(db: Db, channel: PayChannel): Promise<string | undefined> {
  const key = channel === 'wxpay' ? CONFIG_KEY_WXPAY_DISABLED : CONFIG_KEY_ALIPAY_DISABLED
  if ((await getAppConfig(db, key)) !== '1') return undefined
  const reasonKey = channel === 'wxpay' ? CONFIG_KEY_WXPAY_DISABLED_REASON : CONFIG_KEY_ALIPAY_DISABLED_REASON
  return (await getAppConfig(db, reasonKey)) ?? undefined
}
