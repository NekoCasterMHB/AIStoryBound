// server/api/admin/recharge/config.put.ts
// 支付渠道开关(管理端):管理员按渠道(微信/支付宝)单独开启/关闭充值,
// 配置存 app_config 表,即时生效无需重新部署。两渠道都关闭时用户端即视为全局维护。
// 手动关闭记录渠道原因「管理员手动关闭」,重新开启清除;全局 key 仅由健康检查写入,此处不操作。
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import {
  CONFIG_KEY_WXPAY_DISABLED, CONFIG_KEY_ALIPAY_DISABLED,
  CONFIG_KEY_WXPAY_DISABLED_REASON, CONFIG_KEY_ALIPAY_DISABLED_REASON,
  CONFIG_KEY_PAYMENT_DISABLED, CONFIG_KEY_PAYMENT_DISABLED_REASON,
  getAppConfig, setAppConfig, deleteAppConfig
} from '../../../utils/config'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<{ wxpayDisabled?: boolean, alipayDisabled?: boolean }>(event)
    .catch(() => ({}) as { wxpayDisabled?: boolean, alipayDisabled?: boolean })
  const { wxpayDisabled, alipayDisabled } = body
  if (typeof wxpayDisabled !== 'boolean' && typeof alipayDisabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'wxpayDisabled / alipayDisabled 至少需提供一个布尔值' })
  }

  const db = useD1(event)

  async function applyChannel(channel: 'wxpay' | 'alipay', disabled?: boolean) {
    if (typeof disabled !== 'boolean') return
    const key = channel === 'wxpay' ? CONFIG_KEY_WXPAY_DISABLED : CONFIG_KEY_ALIPAY_DISABLED
    const reasonKey = channel === 'wxpay' ? CONFIG_KEY_WXPAY_DISABLED_REASON : CONFIG_KEY_ALIPAY_DISABLED_REASON
    await setAppConfig(db, key, disabled ? '1' : '0')
    if (disabled) {
      await setAppConfig(db, reasonKey, '管理员手动关闭')
    } else {
      await deleteAppConfig(db, reasonKey)
    }
  }

  await applyChannel('wxpay', wxpayDisabled)
  await applyChannel('alipay', alipayDisabled)

  // 迁移旧版全局开关:渠道判定含全局 key(payment_disabled),若其仍是旧管理 UI 写入的
  // 「管理员手动关闭」,管理员的本次渠道操作即最新意图,清除之,否则会永久压住渠道开关。
  // 健康检查写入的自动维护(其他原因)不动,由健康检查成功后自行恢复。
  const globalReason = await getAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON)
  if (globalReason === '管理员手动关闭') {
    await deleteAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED)
    await deleteAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON)
  }

  // 回读实际落库状态(未提交的渠道维持原状)
  const [wxpayKey, alipayKey] = await Promise.all([
    getAppConfig(db, CONFIG_KEY_WXPAY_DISABLED),
    getAppConfig(db, CONFIG_KEY_ALIPAY_DISABLED)
  ])
  return { wxpayDisabled: wxpayKey === '1', alipayDisabled: alipayKey === '1' }
})
