// server/api/admin/recharge/config.put.ts
// 充值开关(管理端):管理员开启/关闭充值入口,配置存 app_config 表,即时生效无需重新部署。
// 手动关闭记录原因「管理员手动关闭」,重新开启清除原因,便于区分是健康检查还是人工干预进入的维护。
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import {
  CONFIG_KEY_PAYMENT_DISABLED, CONFIG_KEY_PAYMENT_DISABLED_REASON,
  getAppConfig, setAppConfig, deleteAppConfig
} from '../../../utils/config'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<{ paymentDisabled?: boolean }>(event).catch(() => ({} as { paymentDisabled?: boolean }))
  const { paymentDisabled } = body
  if (typeof paymentDisabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'paymentDisabled 必须为布尔值' })
  }

  const db = useD1(event)
  await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED, paymentDisabled ? '1' : '0')
  if (paymentDisabled) {
    await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON, '管理员手动关闭')
  } else {
    await deleteAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON)
  }

  return {
    paymentDisabled: (await getAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED)) === '1',
    reason: paymentDisabled ? '管理员手动关闭' : undefined
  }
})
