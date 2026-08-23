// app/composables/useAuthModal.ts
// 全局登录/注册模态框状态(模块级共享,跨页面可用)。
// requireLogin:任意按钮"点击需要登录"时调用——已登录直接返回 true,未登录弹出模态框并等待结果。
import { ref } from 'vue'
import { authClient } from '~/utils/auth-client'

const open = ref(false)
let resolveFn: ((ok: boolean) => void) | null = null

export function useAuthModal() {
  /** 要求登录:未登录时弹出模态框,登录成功 resolve(true),关闭 resolve(false) */
  async function requireLogin(): Promise<boolean> {
    const { data } = await authClient.getSession()
    if (data) return true
    open.value = true
    return new Promise((resolve) => {
      resolveFn = resolve
    })
  }

  /** 关闭模态框(未登录关闭 → resolve(false)) */
  function close() {
    open.value = false
    if (resolveFn) {
      resolveFn(false)
      resolveFn = null
    }
  }

  /** 登录/注册成功 → 关闭并 resolve(true) */
  function onLoginSuccess() {
    open.value = false
    if (resolveFn) {
      resolveFn(true)
      resolveFn = null
    }
  }

  return { open, requireLogin, close, onLoginSuccess }
}
