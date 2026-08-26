// server/utils/preset-world.ts
// 预置小说「预生成世界」读取:成书结果随站点部署为静态 JSON(public/worlds/<id>.json,
// 由 scripts/prebuild-presets.ts 生成),生产经 ASSETS binding 读取,本地 dev 直接读文件系统。
// 与预置正文 txt 同模式;文件缺失(该书未预生成)返回 null,由调用方决定回退原生成流程。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { H3Event } from 'h3'

/** 预生成世界 JSON 的静态路径约定:public/worlds/<id>.json → /worlds/<id>.json */
function worldStaticPath(id: string): string {
  return `/worlds/${encodeURIComponent(id)}.json`
}

/** 该书是否已有预生成世界 */
export async function hasPresetWorld(event: H3Event, id: string): Promise<boolean> {
  if (import.meta.dev) {
    return existsSync(join(process.cwd(), 'public', 'worlds', `${id}.json`))
  }
  const env = (event.context as unknown as { cloudflare?: { env?: Env } }).cloudflare?.env
  if (!env?.ASSETS) return false
  const url = new URL(worldStaticPath(id), getRequestURL(event))
  const res = await env.ASSETS.fetch(url)
  return res.ok
}

/** 读取预生成世界 JSON;不存在或解析失败返回 null */
export async function readPresetWorld(event: H3Event, id: string): Promise<unknown | null> {
  if (import.meta.dev) {
    try {
      return JSON.parse(readFileSync(join(process.cwd(), 'public', 'worlds', `${id}.json`), 'utf-8'))
    } catch {
      return null
    }
  }
  const env = (event.context as unknown as { cloudflare?: { env?: Env } }).cloudflare?.env
  if (!env?.ASSETS) return null
  const url = new URL(worldStaticPath(id), getRequestURL(event))
  const res = await env.ASSETS.fetch(url)
  if (!res.ok) return null
  return res.json().catch(() => null)
}
