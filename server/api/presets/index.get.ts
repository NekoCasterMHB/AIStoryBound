// server/api/presets/index.get.ts
// 首页推荐列表:预置小说(featured=1,按 sort_order),附加 hasWorld 标记
// (该书是否已有预生成世界,前端据此显示「直接开始」入口)
import { listFeaturedPresets } from '../../utils/db'
import { hasPresetWorld } from '../../utils/preset-world'

export default defineEventHandler(async (event) => {
  const rows = await listFeaturedPresets(event)
  const withWorld = await Promise.all(rows.map(async (p) => ({
    ...p,
    hasWorld: await hasPresetWorld(event, p.id)
  })))
  return withWorld
})
