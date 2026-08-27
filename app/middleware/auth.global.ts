// app/middleware/auth.global.ts
// 登录守卫(介绍页 / 登录页 / 生成页 / 预置预览 / 沉浸式阅读 / 创意工坊对游客开放;其余页面需要登录):
// - 游客可浏览:首页介绍、/generate(页面内引导登录)、/presets 预览、/read 沉浸阅读、/edit 本地编辑、
//   /workshop 创意工坊(书架/Skill包可浏览,购买/发布页面内再引导登录;均不消耗平台配额)
// - 未登录访问作品库/个人中心/游戏 → 跳 /login 并带 redirect 回跳参数
const PUBLIC_PREFIXES = ['/login', '/generate', '/presets', '/read', '/edit', '/workshop', '/store', '/demand']

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/') return
  if (PUBLIC_PREFIXES.some(p => to.path === p || to.path.startsWith(`${p}/`))) return

  const { data } = await authClient.useSession(useFetch)
  if (!data.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }
})
