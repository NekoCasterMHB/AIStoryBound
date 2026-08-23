<script setup lang="ts">
// AuthModal — 全局登录/注册模态框(顶部右上角"登录/生成"入口弹出):
// 邮箱+密码 / 邮箱+验证码 双 tab;注册为验证码模态框(用户名/邮箱/密码/确认密码)。
// 登录成功回调 useAuthModal().onLoginSuccess()(关闭 + 让 await requireLogin() 的调用方继续)。
import type { TabsItem } from '@nuxt/ui'
import { authClient } from '~/utils/auth-client'
import { useAuthModal } from '~/composables/useAuthModal'

const { open, onLoginSuccess } = useAuthModal()

const errorMsg = ref('')
const busy = ref(false)

// ---- 邮箱+密码登录 ----
const pwForm = reactive({ email: '', password: '' })
const showPwLogin = ref(false)
async function onPasswordLogin() {
  errorMsg.value = ''
  busy.value = true
  try {
    const { error } = await authClient.signIn.email({ email: pwForm.email, password: pwForm.password })
    if (error) {
      errorMsg.value = friendlyAuthError(error.message)
      return
    }
    onLoginSuccess()
  } finally {
    busy.value = false
  }
}

// ---- 邮箱+验证码登录 ----
const otpForm = reactive({ email: '', otp: '' })
const otpSent = ref(false)
const otpCountdown = ref(0)
let otpTimer: ReturnType<typeof setInterval> | null = null

function startCountdown(sec = 60) {
  otpCountdown.value = sec
  if (otpTimer) clearInterval(otpTimer)
  otpTimer = setInterval(() => {
    otpCountdown.value--
    if (otpCountdown.value <= 0 && otpTimer) clearInterval(otpTimer)
  }, 1000)
}

async function sendOtp() {
  errorMsg.value = ''
  if (!otpForm.email.trim()) {
    errorMsg.value = '请输入邮箱'
    return
  }
  busy.value = true
  try {
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: otpForm.email, type: 'sign-in' })
    if (error) {
      errorMsg.value = friendlyAuthError(error.message)
      return
    }
    otpSent.value = true
    startCountdown()
  } finally {
    busy.value = false
  }
}

async function onOtpLogin() {
  errorMsg.value = ''
  busy.value = true
  try {
    const { error } = await authClient.signIn.emailOtp({ email: otpForm.email, otp: otpForm.otp })
    if (error) {
      errorMsg.value = friendlyAuthError(error.message)
      return
    }
    onLoginSuccess()
  } finally {
    busy.value = false
  }
}

// ---- 注册(验证码模态框内两步:填表+发码 → 输码完成) ----
const regStep = ref<'form' | 'code'>('form')
const regForm = reactive({ username: '', email: '', password: '', confirm: '', otp: '' })
const showPwReg = ref(false)
const showPwConfirm = ref(false)
const regError = ref('')
const regBusy = ref(false)
const regCountdown = ref(0)
let regTimer: ReturnType<typeof setInterval> | null = null

function regCountdownTick() {
  regCountdown.value = 60
  if (regTimer) clearInterval(regTimer)
  regTimer = setInterval(() => {
    regCountdown.value--
    if (regCountdown.value <= 0 && regTimer) clearInterval(regTimer)
  }, 1000)
}

function validateRegForm(): string | null {
  if (!regForm.username.trim()) return '请输入用户名'
  if (regForm.username.trim().length < 2) return '用户名至少 2 个字符'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regForm.email)) return '请输入正确的邮箱'
  if (regForm.password.length < 8) return '密码至少 8 位'
  if (regForm.password !== regForm.confirm) return '两次输入的密码不一致'
  return null
}

async function onSendRegOtp() {
  regError.value = ''
  const err = validateRegForm()
  if (err) {
    regError.value = err
    return
  }
  regBusy.value = true
  try {
    const { error } = await authClient.signUp.email({
      name: regForm.username.trim(),
      email: regForm.email,
      password: regForm.password
    })
    if (error) {
      regError.value = friendlyAuthError(error.message)
      return
    }
    const otpRes = await authClient.emailOtp.sendVerificationOtp({ email: regForm.email, type: 'email-verification' })
    if (otpRes.error) {
      regError.value = friendlyAuthError(otpRes.error.message)
      return
    }
    regStep.value = 'code'
    regCountdownTick()
  } finally {
    regBusy.value = false
  }
}

async function onResendRegOtp() {
  regBusy.value = true
  try {
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: regForm.email, type: 'email-verification' })
    if (error) {
      regError.value = friendlyAuthError(error.message)
      return
    }
    regCountdownTick()
  } finally {
    regBusy.value = false
  }
}

async function onFinishRegister() {
  regError.value = ''
  if (!/^\d{6}$/.test(regForm.otp)) {
    regError.value = '请输入 6 位验证码'
    return
  }
  regBusy.value = true
  try {
    const { error: verifyErr } = await authClient.emailOtp.verifyEmail({ email: regForm.email, otp: regForm.otp })
    if (verifyErr) {
      regError.value = friendlyAuthError(verifyErr.message)
      return
    }
    const { error: signInErr } = await authClient.signIn.email({ email: regForm.email, password: regForm.password })
    if (signInErr) {
      regError.value = friendlyAuthError(signInErr.message)
      return
    }
    onLoginSuccess()
  } finally {
    regBusy.value = false
  }
}

function resetRegister() {
  regError.value = ''
  regStep.value = 'form'
  regForm.username = ''
  regForm.email = ''
  regForm.password = ''
  regForm.confirm = ''
  regForm.otp = ''
}

// ---- 视图切换:登录 ⇄ 注册(互不混排) ----
const view = ref<'login' | 'register'>('login')
const modalTitle = computed(() => view.value === 'login' ? '登录 AI StoryBound' : '注册账号')
const modalDescription = computed(() => view.value === 'login'
  ? '未登录仅可预览;登录后生成世界并保存作品'
  : '注册即赠送 10 万 token,生成世界与游戏回合按实际用量消耗')

function switchToRegister() {
  errorMsg.value = ''
  resetRegister()
  view.value = 'register'
}

function switchToLogin() {
  regError.value = ''
  view.value = 'login'
}

function friendlyAuthError(code: string | undefined): string {
  const map: Record<string, string> = {
    USER_ALREADY_EXISTS: '该邮箱已注册,请直接登录',
    INVALID_EMAIL_OR_PASSWORD: '邮箱或密码错误',
    USER_NOT_FOUND: '该邮箱未注册,请先注册',
    INVALID_OTP: '验证码错误或已过期',
    TOO_MANY_ATTEMPTS: '尝试次数过多,请稍后再试',
    EMAIL_NOT_VERIFIED: '邮箱未验证,请先通过注册流程完成验证'
  }
  return map[code ?? ''] || (code ? `操作失败:${code}` : '操作失败,请稍后再试')
}

function onOpenChange(v: boolean) {
  // 从外部关闭(遮罩/ESC)→ 未成功的等待者视为放弃,并复位到登录视图
  if (!v) {
    resetRegister()
    view.value = 'login'
  }
}

const tabs = ref<TabsItem[]>([
  { label: '邮箱+密码', slot: 'password' },
  { label: '邮箱+验证码', slot: 'otp' }
])
</script>

<template>
  <UModal
    v-model:open="open"
    :title="modalTitle"
    :description="modalDescription"
    :dismissible="!busy && !regBusy"
    :ui="{ content: 'sm:max-w-sm' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <!-- 登录视图:邮箱+密码 / 邮箱+验证码 双 tab -->
      <template v-if="view === 'login'">
        <UTabs
          :items="tabs"
          class="w-full"
          variant="pill"
          color="primary"
        >
          <template #password>
            <div class="space-y-4 mt-4">
              <UFormField
                label="邮箱"
                required
              >
                <UInput
                  v-model="pwForm.email"
                  type="email"
                  placeholder="you@example.com"
                  class="w-full"
                  :disabled="busy"
                />
              </UFormField>
              <UFormField
                label="密码"
                required
              >
                <UInput
                  v-model="pwForm.password"
                  :type="showPwLogin ? 'text' : 'password'"
                  placeholder="密码"
                  class="w-full"
                  :disabled="busy"
                  :ui="{ trailing: 'pe-1' }"
                  @keyup.enter="onPasswordLogin"
                >
                  <template #trailing>
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      tabindex="-1"
                      :icon="showPwLogin ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      :aria-label="showPwLogin ? '隐藏密码' : '显示密码'"
                      :aria-pressed="showPwLogin"
                      @click="showPwLogin = !showPwLogin"
                    />
                  </template>
                </UInput>
              </UFormField>
              <UButton
                block
                color="primary"
                :loading="busy"
                @click="onPasswordLogin"
              >
                登录
              </UButton>
            </div>
          </template>

          <template #otp>
            <div class="space-y-4 mt-4">
              <UFormField
                label="邮箱"
                required
              >
                <UInput
                  v-model="otpForm.email"
                  type="email"
                  placeholder="you@example.com"
                  class="w-full"
                  :disabled="busy"
                />
              </UFormField>
              <div class="flex gap-2">
                <UInput
                  v-model="otpForm.otp"
                  placeholder="6 位验证码"
                  class="flex-1"
                  :disabled="busy || !otpSent"
                  inputmode="numeric"
                  maxlength="6"
                />
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="busy || otpCountdown > 0"
                  @click="sendOtp"
                >
                  {{ otpCountdown > 0 ? `${otpCountdown}s` : (otpSent ? '重新发送' : '获取验证码') }}
                </UButton>
              </div>
              <UButton
                block
                color="primary"
                :loading="busy"
                :disabled="!otpSent"
                @click="onOtpLogin"
              >
                登录
              </UButton>
            </div>
          </template>
        </UTabs>

        <p
          v-if="errorMsg"
          class="mt-4 text-sm text-red-400 text-center"
        >
          {{ errorMsg }}
        </p>

        <!-- 登录按钮下方:注册入口 -->
        <div class="mt-5 text-center text-sm text-neutral-500">
          没有账号?
          <UButton
            label="点此注册"
            color="primary"
            variant="link"
            size="sm"
            class="font-semibold"
            @click="switchToRegister"
          />
        </div>
      </template>

      <!-- 注册视图:填表发码 → 输验证码完成 -->
      <template v-else>
        <template v-if="regStep === 'form'">
          <div class="space-y-3">
            <UFormField
              label="用户名"
              required
            >
              <UInput
                v-model="regForm.username"
                placeholder="怎么称呼你"
                class="w-full"
                :disabled="regBusy"
              />
            </UFormField>
            <UFormField
              label="邮箱"
              required
            >
              <UInput
                v-model="regForm.email"
                type="email"
                placeholder="you@example.com"
                class="w-full"
                :disabled="regBusy"
              />
            </UFormField>
            <div class="flex gap-2">
              <UFormField
                label="密码"
                required
                class="flex-1"
              >
                <UInput
                  v-model="regForm.password"
                  :type="showPwReg ? 'text' : 'password'"
                  placeholder="至少 8 位"
                  :disabled="regBusy"
                  :ui="{ trailing: 'pe-1' }"
                >
                  <template #trailing>
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      tabindex="-1"
                      :icon="showPwReg ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      :aria-label="showPwReg ? '隐藏密码' : '显示密码'"
                      :aria-pressed="showPwReg"
                      @click="showPwReg = !showPwReg"
                    />
                  </template>
                </UInput>
              </UFormField>
              <UFormField
                label="确认密码"
                required
                class="flex-1"
              >
                <UInput
                  v-model="regForm.confirm"
                  :type="showPwConfirm ? 'text' : 'password'"
                  placeholder="再输入一次"
                  :disabled="regBusy"
                  :ui="{ trailing: 'pe-1' }"
                  @keyup.enter="onSendRegOtp"
                >
                  <template #trailing>
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      tabindex="-1"
                      :icon="showPwConfirm ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      :aria-label="showPwConfirm ? '隐藏密码' : '显示密码'"
                      :aria-pressed="showPwConfirm"
                      @click="showPwConfirm = !showPwConfirm"
                    />
                  </template>
                </UInput>
              </UFormField>
            </div>
            <UButton
              block
              color="primary"
              :loading="regBusy"
              @click="onSendRegOtp"
            >
              注册并发送邮箱验证码
            </UButton>
          </div>
        </template>

        <div
          v-else
          class="space-y-3"
        >
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            验证码已发送至 <b class="font-semibold text-(--ui-text-highlighted)">{{ regForm.email }}</b>,5 分钟内有效。
          </p>
          <div class="flex gap-2">
            <UInput
              v-model="regForm.otp"
              placeholder="6 位验证码"
              class="flex-1"
              :disabled="regBusy"
              inputmode="numeric"
              maxlength="6"
            />
            <UButton
              color="neutral"
              variant="outline"
              :disabled="regBusy || regCountdown > 0"
              @click="onResendRegOtp"
            >
              {{ regCountdown > 0 ? `${regCountdown}s` : '重新发送' }}
            </UButton>
          </div>
          <UButton
            block
            color="primary"
            :loading="regBusy"
            @click="onFinishRegister"
          >
            完成注册
          </UButton>
        </div>
        <p
          v-if="regError"
          class="mt-3 text-sm text-red-400"
        >
          {{ regError }}
        </p>

        <!-- 注册视图底部:返回登录 -->
        <div class="mt-5 text-center text-sm text-neutral-500">
          已有账号?
          <UButton
            label="去登录"
            color="primary"
            variant="link"
            size="sm"
            class="font-semibold"
            @click="switchToLogin"
          />
        </div>
      </template>
    </template>
  </UModal>
</template>
