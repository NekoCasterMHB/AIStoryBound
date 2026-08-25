// server/api/admin/me.get.ts
// 当前用户是否为管理员(供前端路由中间件做管理员守卫;登录即可调用,只返回布尔,
// 真正的读写鉴权仍由各管理接口的 requireAdmin 保证)
import { isAdmin } from '../../utils/authz'

export default defineEventHandler(async (event) => {
  return { isAdmin: await isAdmin(event) }
})
