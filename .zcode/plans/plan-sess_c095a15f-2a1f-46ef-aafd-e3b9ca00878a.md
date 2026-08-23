删除 app/layouts/default.vue 中整个页脚区域(第 103–122 行):

1. 移除 `<USeparator icon="i-simple-icons-nuxtdotjs" />` 分隔线
2. 移除整个 `<UFooter>` 块(左侧 "Built with Nuxt UI • © {{ year }}" 文字 + 右侧 GitHub 按钮)

保留其余所有内容(<UMain> 插槽、`<AuthModal />` 等)。改动只涉及这一个文件。