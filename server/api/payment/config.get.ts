// server/api/payment/config.get.ts
// 充值配置(公开):前端据此展示充值入口状态(是否维护中),无需登录。
import { useD1 } from '../../utils/d1'
import { isPaymentDisabled } from '../../utils/config'

export default defineEventHandler(async (event) => {
  const disabled = await isPaymentDisabled(useD1(event))
  return { paymentDisabled: disabled }
})
