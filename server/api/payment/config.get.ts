// server/api/payment/config.get.ts
// 充值配置(公开):前端据此展示充值入口状态(是否维护中)与维护原因,无需登录。
import { useD1 } from '../../utils/d1'
import { isPaymentDisabled, getPaymentDisabledReason } from '../../utils/config'

export default defineEventHandler(async (event) => {
  const db = useD1(event)
  const disabled = await isPaymentDisabled(db)
  return {
    paymentDisabled: disabled,
    // 进入维护的原因(健康检查自动关闭 / 管理员手动关闭时记录;开放时无)
    reason: disabled ? (await getPaymentDisabledReason(db)) ?? undefined : undefined
  }
})
