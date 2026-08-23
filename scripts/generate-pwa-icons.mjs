// 从 public/图标.png 生成 PWA 各尺寸图标(192/512、maskable、apple-touch)。
// 更换图标后重跑:pnpm gen:pwa-icons
import sharp from 'sharp'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'public', '图标.png')

const meta = await sharp(src).metadata()
const { channels } = await sharp(src).stats()
const [r, g, b] = channels.slice(0, 3).map((c) => Math.round(c.mean))
console.log(`源图 ${meta.width}x${meta.height},主色 rgb(${r},${g},${b})`)

// 普通图标:等比缩放,保留透明底
await sharp(src).resize(192, 192).png().toFile(join(root, 'public', 'pwa-192x192.png'))
await sharp(src).resize(512, 512).png().toFile(join(root, 'public', 'pwa-512x512.png'))

// apple-touch-icon(iOS 不接受透明底,合成到白底)
await sharp({
  create: { width: 180, height: 180, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
})
  .composite([{ input: await sharp(src).resize(180, 180).png().toBuffer(), left: 0, top: 0 }])
  .png()
  .toFile(join(root, 'public', 'apple-touch-icon.png'))

// maskable:主色背景 + 内容缩至 70% 居中,保证系统裁切安全区内内容完整
const mask = 512
const contentSize = Math.round(mask * 0.7)
const content = await sharp(src).resize(contentSize, contentSize).png().toBuffer()
const offset = Math.round((mask - contentSize) / 2)
await sharp({
  create: { width: mask, height: mask, channels: 4, background: { r, g, b, alpha: 1 } }
})
  .composite([{ input: content, left: offset, top: offset }])
  .png()
  .toFile(join(root, 'public', 'maskable-512x512.png'))

console.log('已生成: pwa-192x192.png / pwa-512x512.png / apple-touch-icon.png / maskable-512x512.png')