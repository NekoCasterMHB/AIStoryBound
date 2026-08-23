// server/api/presets/index.get.ts
// 首页推荐列表:预置小说(featured=1,按 sort_order)
import { listFeaturedPresets } from '../../utils/db'

export default defineEventHandler(async (event) => {
  return listFeaturedPresets(event)
})
