<script setup lang="ts">
import { useThemeColor, PRIMARY_COLORS, NEUTRAL_COLORS } from '~/composables/useThemeColor'

// 主题色切换:点击调色板按钮弹出 Popover,内部 Tab 切换「主题色 / 中性色」,
// 以调色盘网格展示纯色块(无文字说明),点击即切换并持久化到 localStorage。
// 色块用动态类 bg-<色>-500(深色模式 dark:bg-<色>-400),对应类名已在 main.css 通过
// @source inline safelist 全部生成(Tailwind v4 主题变量按需输出,不 safelist 会摇掉)。
const { primary, neutral } = useThemeColor()

const tabs = [
  { label: '主题色', slot: 'primary' },
  { label: '中性色', slot: 'neutral' }
]
</script>

<template>
  <UPopover :content="{ align: 'end', sideOffset: 8 }">
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-palette"
      size="sm"
      title="主题色"
      aria-label="主题色"
    />

    <template #content>
      <div class="w-64 p-3">
        <UTabs
          :items="tabs"
          variant="pill"
          size="sm"
        >
          <template #primary>
            <div class="grid grid-cols-6 gap-1.5 pt-3">
              <button
                v-for="color in PRIMARY_COLORS"
                :key="color"
                type="button"
                :class="[
                  'aspect-square w-full rounded-lg transition-transform duration-100 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)',
                  `bg-${color}-500 dark:bg-${color}-400`,
                  primary === color ? 'scale-110 ring-2 ring-(--ui-bg)' : 'ring-1 ring-(--ui-border) hover:ring-(--ui-text-muted)'
                ]"
                :aria-label="color"
                :aria-pressed="primary === color"
                @click="primary = color"
              />
            </div>
          </template>

          <template #neutral>
            <div class="grid grid-cols-6 gap-1.5 pt-3">
              <button
                v-for="color in NEUTRAL_COLORS"
                :key="color"
                type="button"
                :class="[
                  'aspect-square w-full rounded-lg transition-transform duration-100 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)',
                  `bg-${color}-500 dark:bg-${color}-400`,
                  neutral === color ? 'scale-110 ring-2 ring-(--ui-bg)' : 'ring-1 ring-(--ui-border) hover:ring-(--ui-text-muted)'
                ]"
                :aria-label="color"
                :aria-pressed="neutral === color"
                @click="neutral = color"
              />
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UPopover>
</template>
