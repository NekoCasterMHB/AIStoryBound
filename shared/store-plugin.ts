// shared/store-plugin.ts
// 功能插件商城:类型与常量(浏览器 / 服务器共用)。
// 功能插件 = 平台官方上架的硬件联动能力(如啵啵贝适配器);适配器为平台内置功能,
// 购买记录 = 解锁「详细配置」入口,无文件/版本/卖家分成。
// 上架:scripts/seed-plugins.ts(幂等)。限时免费以 price=0 表达,文案由商品 desc 说明。

export type PluginStatus = 'pending' | 'approved' | 'rejected' | 'removed'

/** 商城列表项(公开字段;owned=是否已购买,仅登录用户有值) */
export interface StorePluginSummary {
  id: string
  name: string
  desc: string
  /** 售价(token;0=免费) */
  price: number
  icon: string | null
  featured: number
  purchaseCount: number
  createdAt: number
  owned: boolean
}
