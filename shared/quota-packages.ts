// shared/quota-packages.ts
// Token 加油包定义(前后端共用,纯 TS):固定三档,价格 = DeepSeek V4 flash 输出价 ×2 向上取整(元)。
// 金额永远以服务端这里的表为准(价格服务端权威,前端传 packageId 即可)。
// 三档均为促销优惠价:priceYuan 为实付价,originalPriceYuan 为划线原价(按基准公式算出)。
export interface TokenPackage {
  id: string
  label: string
  shortLabel: string
  /** 第一行说明(如世界生成次数) */
  description: string
  /** 第二行说明(如文字对话字数) */
  description2: string
  tokens: number
  /** 单位:元(整数,已向上取整) */
  priceYuan: number
  /** 划线原价(优惠档展示用,可选) */
  originalPriceYuan?: number
  /** 折扣文案,如 '7.9 折'(可选) */
  discountLabel?: string
  /** 限购:true 时每个用户最多购买一次(按已支付订单判定) */
  oneTimeOnly?: boolean
}

/** DeepSeek V4 flash 输出单价(USD / 1M tokens,峰值价) */
export const FLASH_OUTPUT_PRICE_PER_M_USD = 1.32
/** 汇率(USD→CNY),可调 */
export const EXCHANGE_RATE = 7.2

/** 价格公式:flash 输出价 ×2,向上取整到整数元 */
export function packPriceYuan(mTokens: number): number {
  return Math.ceil(FLASH_OUTPUT_PRICE_PER_M_USD * 2 * EXCHANGE_RATE * mTokens)
}

export const TOKEN_PACKAGES: TokenPackage[] = [
  {
    id: 'tokens_1m_once',
    label: '新人特惠 1M',
    shortLabel: '新人1M',
    description: '新人福利 · 每人限购 1 次',
    description2: '约 10+ 次世界生成 · 170 万字对话',
    tokens: 1_000_000,
    priceYuan: 3,
    originalPriceYuan: packPriceYuan(1),
    discountLabel: '1.5 折',
    oneTimeOnly: true
  },
  {
    id: 'tokens_1m',
    label: '1M tokens',
    shortLabel: '1M',
    description: '约 10+ 次完整世界生成',
    description2: '文字对话约 170 万字',
    tokens: 1_000_000,
    priceYuan: 18,
    originalPriceYuan: packPriceYuan(1),
    discountLabel: '9 折'
  },
  {
    id: 'tokens_10m',
    label: '10M tokens',
    shortLabel: '10M',
    description: '约 100+ 次完整世界生成',
    description2: '文字对话约 1700 万字',
    tokens: 10_000_000,
    priceYuan: 150,
    originalPriceYuan: packPriceYuan(10),
    discountLabel: '7.9 折'
  },
  {
    id: 'tokens_50m',
    label: '50M tokens',
    shortLabel: '50M',
    description: '约 500+ 次完整世界生成',
    description2: '文字对话约 8500 万字',
    tokens: 50_000_000,
    priceYuan: 599,
    originalPriceYuan: packPriceYuan(50),
    discountLabel: '6.3 折'
  }
]

export function isTokenPackageId(id: string): boolean {
  return TOKEN_PACKAGES.some(p => p.id === id)
}

export function getTokenPackageById(id: string): TokenPackage | undefined {
  return TOKEN_PACKAGES.find(p => p.id === id)
}
