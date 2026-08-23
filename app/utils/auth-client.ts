// app/utils/auth-client.ts
// Better Auth 前端客户端(vue 集成):useSession 需要传入 Nuxt 的 useFetch 以便 SSR 传递 cookie;
// 注册/登录/验证码接口见 authClient.signUp / authClient.signIn / authClient.emailOtp 系列。
import { createAuthClient } from 'better-auth/vue'
import { emailOTPClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [emailOTPClient()]
})

/** 会话组合式函数(Nuxt 用法:authClient.useSession(useFetch)) */
export function useAuthSession() {
  return authClient.useSession(useFetch)
}
