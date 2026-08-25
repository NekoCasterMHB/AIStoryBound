// app/composables/useThemeColor.ts
// 主题色(主色 primary / 中性色 neutral)切换:直接读写 appConfig.ui.colors,
// @nuxt/ui 的 colors 插件会响应式重算 CSS 变量(style#nuxt-ui-colors),改值即全站即时变色。
// 变更同时写入 localStorage,由 plugins/theme-color.ts 在下次加载时恢复(含 SSR 首帧防闪回)。

export const PRIMARY_COLORS = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'black'
]

// 不含 'neutral':v4 中该字面值会被 colors 插件特例映射为 old-neutral
export const NEUTRAL_COLORS = ['slate', 'gray', 'zinc', 'stone']

// 各主色 400 号 hex(green 取项目自定义品牌绿 #00DC82),供浏览器地址栏 theme-color 跟随主色;
// PWA manifest 的 theme_color 是静态值,无法动态化,保持不动
export const PRIMARY_HEX: Record<string, string> = {
  red: '#F87171',
  orange: '#FB923C',
  amber: '#FBBF24',
  yellow: '#FACC15',
  lime: '#A3E635',
  green: '#00DC82',
  emerald: '#34D399',
  teal: '#2DD4BF',
  cyan: '#22D3EE',
  sky: '#38BDF8',
  blue: '#60A5FA',
  indigo: '#818CF8',
  violet: '#A78BFA',
  purple: '#C084FC',
  fuchsia: '#E879F9',
  pink: '#F472B6',
  rose: '#FB7185',
  black: '#000000'
}

const PRIMARY_KEY = 'nuxt-ui-primary'
const NEUTRAL_KEY = 'nuxt-ui-neutral'

function persist(key: string, value: string) {
  if (import.meta.client) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // localStorage 不可用(隐私模式/被禁)时静默忽略,仅本次会话生效
    }
  }
}

export function useThemeColor() {
  const appConfig = useAppConfig()

  const primary = computed({
    get: () => appConfig.ui.colors.primary as string,
    set: (value: string) => {
      appConfig.ui.colors.primary = value
      persist(PRIMARY_KEY, value)
    }
  })

  const neutral = computed({
    get: () => appConfig.ui.colors.neutral as string,
    set: (value: string) => {
      appConfig.ui.colors.neutral = value
      persist(NEUTRAL_KEY, value)
    }
  })

  return { primary, neutral }
}
