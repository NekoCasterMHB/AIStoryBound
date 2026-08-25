// app/plugins/theme-color.ts
// 主题色持久化恢复 + SSR 首帧防闪回:
//  - server:注入内联脚本,首帧绘制前把 style#nuxt-ui-colors 里默认色替换成 localStorage 持久化的值
//  - client:hydation 组件渲染前把持久化值回填到 appConfig,使 CSS 直接重算为持久化颜色
// 颜色变量格式由 @nuxt/ui colors 插件生成:
//   --ui-color-<name>-50: var(--color-<默认色>-50, #回退值); → 替换其中的颜色名即可
// 语义色链:--ui-primary → --ui-color-primary-500 → --color-green-500(浅) / 400(深)

// 防闪回脚本(localStorage 在首帧前同步可读;style 标签已就绪则直接替换,否则 MutationObserver 兜底)
const SWAP_SCRIPT = `(function () {
  var keys = { primary: 'nuxt-ui-primary', neutral: 'nuxt-ui-neutral' }
  function read(k) { try { return window.localStorage.getItem(k) } catch (e) { return null } }
  function apply() {
    var el = document.getElementById('nuxt-ui-colors')
    if (!el) return false
    var html = el.innerHTML
    for (var name in keys) {
      var stored = read(keys[name])
      if (!stored) continue
      var re = new RegExp('(--ui-color-' + name + '-\\\\d{2,3}:\\\\s*var\\\\(--color-)[a-z]+(-\\\\d{2,3}(?:,[^)]*)?\\\\))', 'g')
      html = html.replace(re, '$1' + stored + '$2')
    }
    if (html !== el.innerHTML) el.innerHTML = html
    return true
  }
  if (!apply()) {
    var obs = new MutationObserver(function () { if (apply()) obs.disconnect() })
    obs.observe(document.documentElement, { childList: true, subtree: true })
  }
})()`

const PRIMARY_KEY = 'nuxt-ui-primary'
const NEUTRAL_KEY = 'nuxt-ui-neutral'

export default defineNuxtPlugin(() => {
  const appConfig = useAppConfig()

  if (import.meta.server) {
    // tagPriority -1:排在 colors 插件的 critical style 之后,自身在默认(100)之前
    useServerHead({
      script: [{ innerHTML: SWAP_SCRIPT, tagPriority: -1 }]
    })
  } else {
    try {
      const primary = window.localStorage.getItem(PRIMARY_KEY)
      const neutral = window.localStorage.getItem(NEUTRAL_KEY)
      if (primary) appConfig.ui.colors.primary = primary
      if (neutral) appConfig.ui.colors.neutral = neutral
    } catch {
      // localStorage 不可用(隐私模式/被禁)时忽略,使用默认色
    }
  }
})
