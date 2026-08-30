// server/middleware/admin-auth.ts
// 管理接口统一鉴权(纵深防御):所有 /api/admin/* 请求在进入具体路由前先做管理员校验,
// 防止新增管理路由时遗漏 requireAdmin 导致接口裸奔。各 admin 路由内现有的 requireAdmin
// 保留不动,作为第二道校验。
// 例外:/api/admin/me 是前端守卫的探测接口,登录的非管理员也要拿到 { isAdmin: false },
// 若在此 403 会破坏 app/middleware/admin.ts 的回跳逻辑,故跳过(其内部自行做 isAdmin 判定)。
import { requireAdmin } from '../utils/authz'

export default defineEventHandler(async (event) => {
  if (event.method === 'OPTIONS') return
  const path = event.path.split('?')[0] ?? ''
  if (!path.startsWith('/api/admin/')) return
  if (path === '/api/admin/me') return
  await requireAdmin(event)
})
