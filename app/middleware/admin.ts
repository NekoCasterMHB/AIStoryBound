// app/middleware/admin.ts
// 管理员守卫:声明了该中间件的页面(见 admin.vue 的 definePageMeta)在进入前先校验管理员身份。
// 非管理员直接回首页;未登录(理论会被 auth.global.ts 先拦)跳登录并带 redirect 回跳。
// 服务端每个 admin 接口的 requireAdmin 仍是最终安全边界,这里只负责路由层拦截。
export default defineNuxtRouteMiddleware(async (to) => {
  // SSR 首载在服务端执行,需用 useRequestFetch 才能带 cookie 请求相对路径
  const requestFetch = import.meta.server ? useRequestFetch() : $fetch
  try {
    const { isAdmin } = await requestFetch<{ isAdmin: boolean }>('/api/admin/me')
    if (!isAdmin) {
      return navigateTo('/')
    }
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 401) {
      return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
    }
    // 其他错误(如服务器 500):无法确认权限,保守回首页,不展示管理界面
    return navigateTo('/')
  }
})
