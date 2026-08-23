// scripts/wrangler.mjs
// 跨平台调用 wrangler:直接以 node 运行 node_modules/wrangler/bin/wrangler.js,
// 避免 Windows 上 .cmd 包装器在 execFileSync 下无法解析的问题。d1-migrate / seed-presets 共用。
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/**
 * 执行 wrangler 命令。
 * @param {string[]} args wrangler 参数(如 ['r2','object','put',...])
 * @param {{ inheritStdio?: boolean }} opts inheritStdio=true 时输出直接透传(默认捕获 stdout)
 * @returns {string} stdout(透传模式下为空串)
 */
export function wrangler(args, { inheritStdio = false } = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf-8',
    stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'inherit']
  })
}
