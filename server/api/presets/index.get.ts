// server/api/presets/index.get.ts
// 首页推荐列表:预置小说(featured=1,按 sort_order)。
// 预置世界(0 token 直接进入)已下线:预置小说只提供阅读/下载/自定义生成入口。
import { listFeaturedPresets } from '../../utils/db'

export default defineEventHandler(async (event) => {
  return await listFeaturedPresets(event)
})
