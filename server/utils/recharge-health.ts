// server/utils/recharge-health.ts
// 充值健康检查(每小时 cron 触发):验证支付配置完整 + 网关签名查询链路可达,
// 失败且当前开放 → 置为维护;成功且当前维护 → 恢复开放。状态存 app_config.payment_disabled。
// 查询接口无副作用(不建单),仅验证「配置 + 签名 + 网关可达」——充值可用性的核心。
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { buildSignStr, signRSA, generateOutTradeNo } from './micropay'
import { isPaymentDisabled, setAppConfig, CONFIG_KEY_PAYMENT_DISABLED } from './config'

/** 网关订单查询地址(与 scripts/query-order.mjs 一致) */
const GATEWAY_QUERY_URL = 'https://pay.microgg.cn/api/pay/query'

export interface RechargeHealthEnv {
  DB: D1Database
  MICROPAY_PID?: string
  MICROPAY_PRIVATE_KEY?: string
}

export interface RechargeHealthResult {
  ok: boolean
  reason?: string
  /** 本次是否翻转了充值开关(维护⇄开放) */
  flipped?: 'open' | 'closed' | null
  paymentDisabled: boolean
}

/** 单次健康检查:返回结果;不抛错(任何异常按失败处理并尝试进维护) */
export async function runRechargeHealthCheck(env: RechargeHealthEnv): Promise<RechargeHealthResult> {
  const db = drizzle(env.DB, { schema })
  const currentlyDisabled = await isPaymentDisabled(db)

  try {
    // 1) 配置检查:网关所需商户信息缺失时充值链路必然不可用
    const pid = env.MICROPAY_PID?.trim()
    const privateKey = env.MICROPAY_PRIVATE_KEY?.trim()
    if (!pid || !privateKey) {
      return await flipIfNeeded(db, currentlyDisabled, false, '支付未配置(缺少 MICROPAY_PID / MICROPAY_PRIVATE_KEY)')
    }

    // 2) 网关连通 + 签名链路检查:查询一个随机订单号,HTTP 2xx 即链路通
    //    (查不存在的单号网关返回「订单不存在」业务码,但连接/验签路径已验证)
    const params: Record<string, string> = {
      pid,
      out_trade_no: generateOutTradeNo(),
      timestamp: String(Math.floor(Date.now() / 1000))
    }
    params.sign = await signRSA(buildSignStr(params), privateKey)
    const res = await fetch(GATEWAY_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    })
    if (!res.ok) {
      return await flipIfNeeded(db, currentlyDisabled, false, `网关查询 HTTP ${res.status}`)
    }
    return await flipIfNeeded(db, currentlyDisabled, true)
  } catch (e) {
    return await flipIfNeeded(db, currentlyDisabled, false, e instanceof Error ? e.message : String(e))
  }
}

/** 按检查结果翻转开关(失败且开放→关闭;成功且维护→开放);状态未变化不写 */
async function flipIfNeeded(
  db: ReturnType<typeof drizzle>,
  currentlyDisabled: boolean,
  ok: boolean,
  reason?: string
): Promise<RechargeHealthResult> {
  let flipped: RechargeHealthResult['flipped'] = null
  let paymentDisabled = currentlyDisabled
  if (!ok && !currentlyDisabled) {
    await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED, '1')
    flipped = 'closed'
    paymentDisabled = true
  } else if (ok && currentlyDisabled) {
    await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED, '0')
    flipped = 'open'
    paymentDisabled = false
  }
  console.log('[recharge-health]', {
    ok,
    reason,
    flipped,
    paymentDisabled
  })
  return { ok, reason, flipped, paymentDisabled }
}
