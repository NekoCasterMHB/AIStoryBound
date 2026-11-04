// server/api/admin/recharge/config.put.ts
// 支付渠道开关(管理端):管理员按渠道(微信/支付宝)单独开启/关闭充值,
// 配置存 app_config 表,即时生效无需重新部署。两渠道都关闭时用户端即视为全局维护。
// 手动关闭记录渠道原因「管理员手动关闭」,重新开启清除;全局 key 仅由健康检查写入,此处不操作。
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import {
  CONFIG_KEY_WXPAY_DISABLED, CONFIG_KEY_ALIPAY_DISABLED,
  CONFIG_KEY_WXPAY_DISABLED_REASON, CONFIG_KEY_ALIPAY_DISABLED_REASON,
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

  // 回读实际落库状态(未提交的渠道维持原状)
  const [wxpayKey, alipayKey] = await Promise.all([
    getAppConfig(db, CONFIG_KEY_WXPAY_DISABLED),
    getAppConfig(db, CONFIG_KEY_ALIPAY_DISABLED)
  ])
  return { wxpayDisabled: wxpayKey === '1', alipayDisabled: alipayKey === '1' }
})
