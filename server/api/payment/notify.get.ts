// server/api/payment/notify.get.ts
// 微支付网关异步回调(GET):部分网关以 GET 方式回调,与 POST 共用同一处理逻辑
import { handlePaymentNotify } from '../../utils/payment-notify'

export default defineEventHandler(async (event) => {
  return await handlePaymentNotify(event)
})
