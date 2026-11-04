// server/api/payment/config.get.ts
// 充值配置(公开):前端据此展示充值入口状态(是否维护中)与各支付渠道可用性,无需登录。
// 渠道有效禁用 = 渠道单独开关 || 全局维护(健康检查自动关闭);两渠道都禁视为全局维护。
import { useD1 } from '../../utils/d1'
import {
  isPaymentDisabled, getPaymentDisabledReason,
  isChannelDisabled, getChannelDisabledReason
} from '../../utils/config'

export default defineEventHandler(async (event) => {
  const db = useD1(event)
  const [wxpayDisabled, alipayDisabled] = await Promise.all([
    isChannelDisabled(db, 'wxpay'),
    isChannelDisabled(db, 'alipay')
  ])
  // 全局维护 = 两渠道都有效禁用(渠道单独禁用或健康检查自动维护)
  const paymentDisabled = wxpayDisabled && alipayDisabled
  const globalDisabled = await isPaymentDisabled(db)
  const [reason, wxpayReason, alipayReason] = await Promise.all([
    globalDisabled ? getPaymentDisabledReason(db) : Promise.resolve(undefined),
    getChannelDisabledReason(db, 'wxpay'),
    getChannelDisabledReason(db, 'alipay')
  ])
  return {
    // 是否处于全局维护(两渠道都禁):前端据此显示维护横幅并禁用充值入口
    paymentDisabled,
    // 健康检查自动维护的原因(仅健康检查写全局 key 时有值)
    reason: paymentDisabled ? (reason ?? undefined) : undefined,
    wxpayDisabled,
    alipayDisabled,
    // 渠道单独禁用的原因(管理员手动关闭时记录;全局维护不算渠道单独禁用)
    channelReasons: {
      wxpay: wxpayDisabled ? (wxpayReason ?? undefined) : undefined,
      alipay: alipayDisabled ? (alipayReason ?? undefined) : undefined
    }
  }
})
