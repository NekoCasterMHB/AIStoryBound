// server/api/presets/[id]/world.get.ts
// 预置小说「预生成世界」:管理员用 scripts/prebuild-presets.ts 预先跑好的成书结果
// (角色卡/实体库/概要/冲突/告警,不含章节正文),随站点部署为 public/worlds/<id>.json。
// 用户端直接使用该世界,0 token;未预生成的书返回 404,前端回退自定义生成。
import { readPresetWorld } from '../../../utils/preset-world'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || id.includes('/') || id.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const world = await readPresetWorld(event, id)
  if (!world) {
    throw createError({ statusCode: 404, statusMessage: 'Preset world not found' })
  }
  setResponseHeaders(event, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
  })
  return world
})
