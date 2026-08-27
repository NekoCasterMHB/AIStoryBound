// 从 public/pwa/图标.png 生成 PWA 各尺寸图标(192/512、maskable、apple-touch)与根目录 favicon.ico。
// 更换图标后重跑:pnpm gen:pwa-icons
import sharp from 'sharp'
import { join, dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'public', 'pwa', '图标.png')

const meta = await sharp(src).metadata()
const { channels } = await sharp(src).stats()
const [r, g, b] = channels.slice(0, 3).map(c => Math.round(c.mean))
console.log(`源图 ${meta.width}x${meta.height},主色 rgb(${r},${g},${b})`)

// 普通图标:等比缩放,保留透明底
await sharp(src).resize(192, 192).png().toFile(join(root, 'public', 'pwa', 'pwa-192x192.png'))
await sharp(src).resize(512, 512).png().toFile(join(root, 'public', 'pwa', 'pwa-512x512.png'))

// apple-touch-icon(iOS 不接受透明底,合成到白底)
await sharp({
  create: { width: 180, height: 180, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
})
  .composite([{ input: await sharp(src).resize(180, 180).png().toBuffer(), left: 0, top: 0 }])
  .png()
  .toFile(join(root, 'public', 'pwa', 'apple-touch-icon.png'))

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
  .toFile(join(root, 'public', 'pwa', 'maskable-512x512.png'))

console.log('已生成: pwa/pwa-192x192.png / pwa/pwa-512x512.png / pwa/apple-touch-icon.png / pwa/maskable-512x512.png')

// favicon.ico:ICO 容器内嵌 16/32/48 PNG(Vista+ 格式,保留圆角透明,浏览器均支持)
const icoSizes = [16, 32, 48]
const pngs = await Promise.all(icoSizes.map(s => sharp(src).resize(s, s).png().toBuffer()))
const ico = Buffer.alloc(6 + 16 * icoSizes.length)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(icoSizes.length, 4)
let icoOffset = 6 + 16 * icoSizes.length
icoSizes.forEach((s, i) => {
  const entry = 6 + i * 16
  ico.writeUInt8(s, entry) // width(s<256 时直接写尺寸)
  ico.writeUInt8(s, entry + 1) // height
  ico.writeUInt16LE(1, entry + 4) // planes
  ico.writeUInt16LE(32, entry + 6) // bitcount
  ico.writeUInt32LE(pngs[i].length, entry + 8)
  ico.writeUInt32LE(icoOffset, entry + 12)
  icoOffset += pngs[i].length
})
await writeFile(join(root, 'public', 'favicon.ico'), Buffer.concat([ico, ...pngs]))
console.log('已生成: favicon.ico (16/32/48)')
