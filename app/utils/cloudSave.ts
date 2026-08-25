// app/utils/cloudSave.ts
// 「本地存档上云」开关(本地偏好,默认关闭):控制游戏会话是否上传云端(跨设备续玩)。
// 默认关闭,与本地优先策略一致;开启后游戏页每回合自动同步,并显示手动同步入口。
const KEY = 'cloud-save-enabled'

export function isCloudSaveEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(KEY) === '1'
}

export function setCloudSaveEnabled(v: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (v) localStorage.setItem(KEY, '1')
  else localStorage.removeItem(KEY)
}
