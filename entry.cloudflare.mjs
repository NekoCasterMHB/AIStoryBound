// entry.cloudflare.mjs
// 自定义 cloudflare_module 构建入口:在 Nitro 标准 Worker 入口(fetch)之上,
// 额外导出云端世界生成任务的 Workflows 类 —— wrangler 的 [[workflows]] 绑定要求
// class_name 从主模块(index.mjs)导出,而 Nitro 默认入口只导出 fetch handler。
// 仅在 --preset cloudflare_module 构建时启用(nuxt.config 的 nitro:config hook 按 preset 设置 nitro.entry);
// 除「导出 WorldGenWorkflow」外,入口逻辑与 nitropack presets/cloudflare/runtime/cloudflare-module.mjs 保持一致。
import '#nitro-internal-pollyfills'
import wsAdapter from 'crossws/adapters/cloudflare'
import { useNitroApp } from 'nitropack/runtime'
import { requestHasBody } from 'nitropack/runtime/internal'
import { isPublicAssetURL } from '#nitro-internal-virtual/public-assets'
import { WorldGenWorkflow } from './server/workflows/world-gen'
import { runRechargeHealthCheck } from './server/utils/recharge-health'

const nitroApp = useNitroApp()
const ws = import.meta._websocket ? wsAdapter(nitroApp.h3App.websocket) : undefined

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    if (env.ASSETS && isPublicAssetURL(url.pathname)) {
      return env.ASSETS.fetch(request)
    }
    if (import.meta._websocket && request.headers.get('upgrade') === 'websocket') {
      return ws.handleUpgrade(request, env, context)
    }
    let body
    if (requestHasBody(request)) {
      body = Buffer.from(await request.arrayBuffer())
    }
    globalThis.__env__ = env
    return nitroApp.localFetch(url.pathname + url.search, {
      context: {
        waitUntil: promise => context.waitUntil(promise),
        _platform: { cf: request.cf, cloudflare: { request, env, context, url } }
      },
      host: url.hostname,
      protocol: url.protocol,
      method: request.method,
      headers: request.headers,
      body
    })
  }
}

export { WorldGenWorkflow }

// 定时任务:每小时整点跑一次充值健康检查(失败自动进维护,恢复自动开放)。
// wrangler.toml [triggers] crons 注册;scheduled 事件无 HTTP 上下文,直接复用底层检查函数。
export async function scheduled(event, env, ctx) {
  ctx.waitUntil(runRechargeHealthCheck(env))
}
