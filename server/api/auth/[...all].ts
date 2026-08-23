// server/api/auth/[...all].ts
// Better Auth 挂载路由(统一入口:/api/auth/sign-up、/api/auth/sign-in/email、
// /api/auth/email-otp/... 等全部子路径由 auth.handler 分发)
import { getAuth } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const auth = getAuth(event)
  return await auth.handler(toWebRequest(event))
})
