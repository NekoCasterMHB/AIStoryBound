// shared/invite.ts
// 邀请码 shared 常量(格式复用兑换码字符集,长度区分;前后端共用)

/** 邀请码长度(兑换码 10 位,邀请码 8 位) */
export const INVITE_CODE_LENGTH = 8

/** 绑定奖励:双方各得 token 数 */
export const INVITE_REWARD_TOKENS = 200_000

/** 充值返利比例:被邀请人每次充值到账后,邀请人获得该比例的 token(取整) */
export const INVITE_REBATE_RATIO = 0.15
