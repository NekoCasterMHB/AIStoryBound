// v-reveal 全局指令:元素滚动进入视口时淡入上移,一次性触发。
// 隐藏态只由指令在客户端标记(SSR 首屏/无 JS 时内容始终可见),首屏已可见的元素不做入场动画。
const observers = new WeakMap<HTMLElement, IntersectionObserver>()

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('reveal', {
    mounted(el: HTMLElement) {
      if (!('IntersectionObserver' in window)) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

      const rect = el.getBoundingClientRect()
      if (rect.top < window.innerHeight && rect.bottom > 0) return

      el.dataset.reveal = ''
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('is-revealed')
            io.disconnect()
            observers.delete(el)
          }
        }
      }, { threshold: 0.12 })
      observers.set(el, io)
      io.observe(el)
    },
    unmounted(el: HTMLElement) {
      observers.get(el)?.disconnect()
      observers.delete(el)
    }
  })
})
