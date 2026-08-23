// server/api/presets/[id]/download.get.ts
// 预置小说 TXT 下载:预置正文随站点部署为静态资源 public/txt/<id>.txt,
// 生产经 ASSETS binding 读取,本地 dev 直接读文件系统;仍走本接口统一设置附件下载头与计数。
// 预览页 fetch 本端点取全文,浏览器直链访问则触发下载,静态文件本身也可直读 /txt/<id>.txt。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { H3Event } from 'h3'
import { getPresetNovel, incrementPresetDownloads } from '../../../utils/db'

/** 预置 txt 的静态路径约定:public/txt/<id>.txt  →  /txt/<id>.txt */
function staticPath(id: string): string {
  return `/txt/${encodeURIComponent(id)}.txt`
}

/** 读取预置 txt 原始字节(UTF-8,含 BOM):生产走 ASSETS binding,dev 走文件系统 */
async function readPresetTxt(event: H3Event, id: string): Promise<Uint8Array> {
  // dev 用 fs 直读 public/txt(dev 的 ASSETS proxy 指向构建产物 .output/public,内容可能滞后)
  if (import.meta.dev) {
    try {
      return new Uint8Array(readFileSync(join(process.cwd(), 'public', 'txt', `${id}.txt`)))
    } catch {
      throw createError({ statusCode: 404, statusMessage: 'Preloaded novel file not found' })
    }
  }
  // 生产(Cloudflare Worker):经 ASSETS binding 读取随站点部署的静态文件
  const env = (event.context as unknown as { cloudflare?: { env?: Env } }).cloudflare?.env
  if (env?.ASSETS) {
    // Workers Static Assets:按路径匹配静态文件,host 无关
    const url = new URL(staticPath(id), getRequestURL(event))
    const res = await env.ASSETS.fetch(url)
    if (!res.ok) {
      throw createError({ statusCode: 404, statusMessage: 'Preloaded novel file not found' })
    }
    return new Uint8Array(await res.arrayBuffer())
  }
  throw createError({ statusCode: 500, statusMessage: 'ASSETS binding not available' })
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || id.includes('/') || id.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const preset = await getPresetNovel(event, id)
  if (!preset) {
    throw createError({ statusCode: 404, statusMessage: 'Preset novel not found' })
  }

  const bytes = await readPresetTxt(event, id)

  await incrementPresetDownloads(event, id)

  const plainName = (preset.title || id).replace(/[\\/:*?"<>|\r\n]/g, '_') + '.txt'
  // ASCII 兜底文件名(Node 的 http 头校验拒绝非 ASCII 字符;浏览器下载名走 filename* 即可)
  const asciiName = /^[\x20-\x7E]*$/.test(id) ? `preset-${id}.txt` : 'preset.txt'
  setResponseHeaders(event, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(plainName)}`,
    'Cache-Control': 'public, max-age=3600'
  })
  return new Response(bytes.buffer as ArrayBuffer)
})
