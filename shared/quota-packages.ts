// shared/quota-packages.ts
// Token 加油包定义(前后端共用,纯 TS):固定五档,价格 = DeepSeek V4 flash 输出价 ×2 向上取整(元)。
// 金额永远以服务端这里的表为准(价格服务端权威,前端传 packageId 即可)。
// 各档均为促销优惠价:priceYuan 为实付价,originalPriceYuan 为划线原价(按基准公式算出)。
export interface TokenPackage {
  id: string
  label: string
  shortLabel: string
  tokens: number
  /** 单位:元(整数,已向上取整) */
  priceYuan: number
  /** 划线原价(优惠档展示用,可选) */
  originalPriceYuan?: number
  /** 折扣文案,如 '7.9 折'(可选) */
  discountLabel?: string
  /** 限购:true 时每个用户最多购买一次(按已支付订单判定) */
  oneTimeOnly?: boolean
  /** 双倍首充包:同价双 token 的限购档,购买 UI 单独分组展示 */
  doublePack?: boolean
}

/** DeepSeek V4 flash 输出单价(USD / 1M tokens,峰值价) */
export const FLASH_OUTPUT_PRICE_PER_M_USD = 1.32
/** 汇率(USD→CNY),可调 */
export const EXCHANGE_RATE = 7.2

/** 每 1M token 的标准人民币价(元,未向上取整;用于对售价做价值估算等展示) */
export const TOKEN_CNY_PER_M = FLASH_OUTPUT_PRICE_PER_M_USD * 2 * EXCHANGE_RATE

/** 价格公式:flash 输出价 ×2,向上取整到整数元 */
export function packPriceYuan(mTokens: number): number {
  return Math.ceil(FLASH_OUTPUT_PRICE_PER_M_USD * 2 * EXCHANGE_RATE * mTokens)
}

export const TOKEN_PACKAGES: TokenPackage[] = [
  {
    id: 'tokens_1m_once',
    label: '新人特惠 1M',
    shortLabel: '新人1M',
    tokens: 1_000_000,
    priceYuan: 6,
    originalPriceYuan: packPriceYuan(1),
    discountLabel: '3 折',
    oneTimeOnly: true
  },
  {
    id: 'tokens_1m',
    label: '1M tokens',
    shortLabel: '1M',
    tokens: 1_000_000,
    priceYuan: 12,
    originalPriceYuan: packPriceYuan(1),
    discountLabel: '6 折'
  },
  {
    id: 'tokens_3m',
    label: '3M tokens',
    shortLabel: '3M',
    tokens: 3_000_000,
    priceYuan: 32,
    originalPriceYuan: packPriceYuan(3),
    discountLabel: '5.5 折'
  },
  {
    id: 'tokens_6m',
    label: '6M tokens',
    shortLabel: '6M',
    tokens: 6_000_000,
    priceYuan: 62,
    originalPriceYuan: packPriceYuan(6),
    discountLabel: '5.4 折'
  },
  {
    id: 'tokens_10m',
    label: '10M tokens',
    shortLabel: '10M',
    tokens: 10_000_000,
    priceYuan: 100,
    originalPriceYuan: packPriceYuan(10),
    discountLabel: '5.2 折'
  },
  {
    id: 'tokens_50m',
    label: '50M tokens',
    shortLabel: '50M',
    tokens: 50_000_000,
    priceYuan: 400,
    originalPriceYuan: packPriceYuan(50),
    discountLabel: '4.2 折'
  },
  // ---- 双倍首充包(同价双 token,每档每人限购一次;与新人包同用 oneTimeOnly 限购机制) ----
  {
    id: 'tokens_2m_once',
    label: '双倍 2M',
    shortLabel: '双倍2M',
    tokens: 2_000_000,
    priceYuan: 12,
    originalPriceYuan: packPriceYuan(2),
    discountLabel: '3.1 折',
    oneTimeOnly: true,
    doublePack: true
  },
  {
    id: 'tokens_6m_once',
    label: '双倍 6M',
    shortLabel: '双倍6M',
    tokens: 6_000_000,
    priceYuan: 32,
    originalPriceYuan: packPriceYuan(6),
    discountLabel: '2.8 折',
    oneTimeOnly: true,
    doublePack: true
  },
  {
    id: 'tokens_12m_once',
    label: '双倍 12M',
    shortLabel: '双倍12M',
    tokens: 12_000_000,
    priceYuan: 62,
    originalPriceYuan: packPriceYuan(12),
    discountLabel: '2.7 折',
    oneTimeOnly: true,
    doublePack: true
  },
  {
    id: 'tokens_20m_once',
    label: '双倍 20M',
    shortLabel: '双倍20M',
    tokens: 20_000_000,
    priceYuan: 100,
    originalPriceYuan: packPriceYuan(20),
    discountLabel: '2.6 折',
    oneTimeOnly: true,
    doublePack: true
  },
  {
    id: 'tokens_100m_once',
    label: '双倍 100M',
    shortLabel: '双倍100M',
    tokens: 100_000_000,
    priceYuan: 400,
    originalPriceYuan: packPriceYuan(100),
    discountLabel: '2.1 折',
    oneTimeOnly: true,
    doublePack: true
  }
]

export function isTokenPackageId(id: string): boolean {
  return TOKEN_PACKAGES.some(p => p.id === id)
}

/**
 * 管理端充值链路测试套餐(0.1 元):仅供 admin/recharge/test-create 下单,
 * 不入 TOKEN_PACKAGES(避免出现在用户购买页),tokens=0 保证回调只验证入账链路、不发放配额。
 * 回调校验(getTokenPackageById)需能查到它,故单独注册。
 */
export const TEST_PACKAGE: TokenPackage = {
  id: 'tokens_test_0_1',
  label: '充值测试 0.1 元',
  shortLabel: '测试0.1',
  tokens: 0,
  priceYuan: 0.1
}

export function getTokenPackageById(id: string): TokenPackage | undefined {
  return TOKEN_PACKAGES.find(p => p.id === id) ?? (id === TEST_PACKAGE.id ? TEST_PACKAGE : undefined)
}
