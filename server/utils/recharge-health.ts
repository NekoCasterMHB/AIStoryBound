// server/utils/recharge-health.ts
// 充值健康检查(每小时 cron 触发):验证支付配置完整 + 网关签名链路。
// 用最近的「已支付订单」做真实订单查询(网关对真实订单返回平台签名响应),再平台公钥验签:
// 网关侧平台密钥轮换 / 公钥配置错误时验签必然失败 → 自动进维护并记录原因(旧实现只查 HTTP 2xx,发现不了这类故障)。
// 失败且当前开放 → 置为维护 + 写原因;成功且当前维护 → 恢复开放 + 清原因。状态存 app_config。
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc } from 'drizzle-orm'
import * as schema from '../db/schema'
import { quotaPackageOrder } from '../db/schema'
import { buildSignStr, signRSA, generateOutTradeNo, verifyRSA, isTimestampFresh } from './micropay'
import {
  isPaymentDisabled, setAppConfig, deleteAppConfig,
  CONFIG_KEY_PAYMENT_DISABLED, CONFIG_KEY_PAYMENT_DISABLED_REASON
} from './config'

/** 网关订单查询地址(与 scripts/query-order.mjs 一致) */
const GATEWAY_QUERY_URL = 'https://pay.microgg.cn/api/pay/query'

export interface RechargeHealthEnv {
  DB: D1Database
  MICROPAY_PID?: string
  MICROPAY_PRIVATE_KEY?: string
  MICROPAY_PUBLIC_KEY?: string
}

export interface RechargeHealthResult {
  ok: boolean
  reason?: string
  /** 本次是否翻转了充值开关(维护⇄开放) */
  flipped?: 'open' | 'closed' | null
  paymentDisabled: boolean
}

/** 网关查询:返回 {status,text};网络层失败返回 'unreachable' */
async function queryGateway(params: Record<string, string>): Promise<{ status: number, text: string } | 'unreachable'> {
  try {
    const res = await fetch(GATEWAY_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return 'unreachable'
  }
}

/** 单次健康检查:返回结果;不抛错(任何异常按失败处理并尝试进维护) */
export async function runRechargeHealthCheck(env: RechargeHealthEnv): Promise<RechargeHealthResult> {
  const db = drizzle(env.DB, { schema })
  const currentlyDisabled = await isPaymentDisabled(db)

  try {
    // 1) 配置检查:商户号 + 商户私钥 + 平台公钥齐备是充值/验签链路的前提
    const pid = env.MICROPAY_PID?.trim()
    const privateKey = env.MICROPAY_PRIVATE_KEY?.trim()
    const publicKey = env.MICROPAY_PUBLIC_KEY?.trim()
    if (!pid || !privateKey || !publicKey) {
      return await flipIfNeeded(db, currentlyDisabled, false,
        '支付未配置(缺少 MICROPAY_PID / MICROPAY_PRIVATE_KEY / MICROPAY_PUBLIC_KEY)')
    }

    // 2) 用最近的已支付订单做真实查询 + 验签(真实订单在网关必然存在,返回平台签名)
    const latestPaid = await db.select({ orderNo: quotaPackageOrder.orderNo })
      .from(quotaPackageOrder)
      .where(eq(quotaPackageOrder.status, 'paid'))
      .orderBy(desc(quotaPackageOrder.createdAt))
      .get()
    const outTradeNo = latestPaid?.orderNo

    if (!outTradeNo) {
      // 无已支付订单(新站/从未成单):退化为连通性探测。网关对不存在订单号返回 HTTP 5xx 属正常,
      // 有任意 HTTP 响应即视为网关可达;此路径无法验签,不做维护翻转避免误伤。
      const probe = await queryGateway(await signQueryParams(pid, privateKey, generateOutTradeNo()))
      if (probe === 'unreachable') {
        return await flipIfNeeded(db, currentlyDisabled, false, '网关不可达(网络请求失败)')
      }
      console.log('[recharge-health] 无已支付订单,仅连通性探测通过,跳过验签')
      return await flipIfNeeded(db, currentlyDisabled, true)
    }

    // 3) 真实订单查询
    const res = await queryGateway(await signQueryParams(pid, privateKey, outTradeNo))
    if (res === 'unreachable') {
      return await flipIfNeeded(db, currentlyDisabled, false, '网关不可达(网络请求失败)')
    }
    if (res.status !== 200) {
      return await flipIfNeeded(db, currentlyDisabled, false, `网关查询 HTTP ${res.status}`)
    }

    // 4) 解析 + 验签
    let data: Record<string, unknown>
    try {
      data = JSON.parse(res.text) as Record<string, unknown>
    } catch {
      return await flipIfNeeded(db, currentlyDisabled, false, '网关响应不是有效 JSON')
    }
    if (data.code !== 0 || typeof data.sign !== 'string') {
      return await flipIfNeeded(db, currentlyDisabled, false, `网关返回异常(code=${String(data.code)})或无签名`)
    }
    if (!isTimestampFresh(data.timestamp)) {
      return await flipIfNeeded(db, currentlyDisabled, false, '网关响应时间戳过期')
    }
    const signParams: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number') signParams[k] = v
    }
    const sigOk = await verifyRSA(buildSignStr(signParams), data.sign, publicKey)
    if (!sigOk) {
      return await flipIfNeeded(db, currentlyDisabled, false,
        '网关响应验签失败(平台公钥可能已轮换或配置错误)')
    }

    return await flipIfNeeded(db, currentlyDisabled, true)
  } catch (e) {
    return await flipIfNeeded(db, currentlyDisabled, false, e instanceof Error ? e.message : String(e))
  }
}

/** 构造网关查询参数并签名(查询只读、无副作用);sign_type 需随表单提交,但不参与签名 */
async function signQueryParams(pid: string, privateKey: string, outTradeNo: string): Promise<Record<string, string>> {
  const params: Record<string, string> = {
    pid,
    out_trade_no: outTradeNo,
    timestamp: String(Math.floor(Date.now() / 1000))
  }
  params.sign = await signRSA(buildSignStr(params), privateKey)
  params.sign_type = 'RSA'
  return params
}

/**
 * 按检查结果翻转开关 + 同步维护原因(失败且开放→关闭并写原因;成功且维护→开放并清原因;状态未变化不写)
 */
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
    await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON, reason ?? '未知原因')
    flipped = 'closed'
    paymentDisabled = true
  } else if (ok && currentlyDisabled) {
    await setAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED, '0')
    await deleteAppConfig(db, CONFIG_KEY_PAYMENT_DISABLED_REASON)
    flipped = 'open'
    paymentDisabled = false
  }
  console.log('[recharge-health]', { ok, reason, flipped, paymentDisabled })
  return { ok, reason, flipped, paymentDisabled }
}
