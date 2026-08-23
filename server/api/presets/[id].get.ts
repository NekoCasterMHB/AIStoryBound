// server/api/presets/[id].get.ts
// 预置小说详情
import { getPresetNovel } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const preset = await getPresetNovel(event, id)
  if (!preset) {
    throw createError({ statusCode: 404, statusMessage: 'Preset novel not found' })
  }
  return preset
})
