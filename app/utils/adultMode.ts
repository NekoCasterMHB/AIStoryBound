// app/utils/adultMode.ts
// 「成人模式」开关(本地偏好,默认关闭):开启后游玩时成人向内容出现频率大幅上升。
// 设置入口:选角页「选择身份」与个人中心;游戏页每回合读取本值注入叙事提示词。
const KEY = 'adult-mode-enabled'

export function isAdultModeEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(KEY) === '1'
}

export function setAdultModeEnabled(v: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (v) localStorage.setItem(KEY, '1')
  else localStorage.removeItem(KEY)
}
