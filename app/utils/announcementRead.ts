// app/utils/announcementRead.ts
// 公告已读游标(本地偏好):记录用户已看到的最近一条公告的 createdAt(毫秒时间戳)。
// 客户端据此过滤未读公告(只弹 createdAt 大于游标的);用户勾选「有新公告前不再提示」时游标更新到最新公告。
// 新发布公告的 createdAt 更大 → 下次访问重新弹出。
const KEY = 'announcement-read-until'

export function getAnnouncementReadUntil(): number {
  if (typeof localStorage === 'undefined') return 0
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

export function setAnnouncementReadUntil(ts: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (ts > 0) localStorage.setItem(KEY, String(ts))
    else localStorage.removeItem(KEY)
  } catch {
    // 隐私模式等写入失败时静默忽略,仅本次会话不再提示
  }
}
