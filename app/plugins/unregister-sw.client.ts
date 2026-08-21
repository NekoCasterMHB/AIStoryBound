// 本项目不使用 Service Worker;若浏览器里残留了其它 PWA 项目(如 vite-plugin-pwa)注册在
// 同一源上的 SW,会带来 /dev-sw.js 404 请求与 Vue Router 警告。此插件启动时统一注销,
// 前提约束:本项目将来也不得自行注册 SW,否则会被这里清掉。
export default defineNuxtPlugin(() => {
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister()
    }
  })
})