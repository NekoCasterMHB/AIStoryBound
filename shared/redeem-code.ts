// shared/redeem-code.ts
// 兑换码字符集与生成/规范化(前后端共用)
// 32 字符大写字母数字,去掉易混淆的 0O1I;码空间 32^10 ≈ 1.1e15,不可暴力枚举
export const REDEEM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const REDEEM_CODE_LENGTH = 10

/** 生成一个随机兑换码(无连字符;2^32 可被 32 整除,取模无偏差) */
export function generateRedeemCode(length: number = REDEEM_CODE_LENGTH): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0
    out += REDEEM_CODE_ALPHABET.charAt(byte % REDEEM_CODE_ALPHABET.length)
  }
  return out
}

/** 输入规范化:去空白与连字符并转大写(用户输入与码比对共用) */
export function normalizeRedeemCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase()
}
