import type { RouteLocationRaw } from 'vue-router'

/**
 * 这个标签页是不是这条会话开出来的。
 *
 * 会话页的 key 是 fullPath，会话 id 挂在 `?sid=` 上（见 SideMenu 的 openChat）。
 *
 * **空 id 一律不算命中。** 少了这一条，「这个标签页没带 sid」和「要找的会话没有
 * id」会撞成同一个 `''`，于是空 id 能匹配上任意一个标签页 —— 调用方以为自己
 * 拿到了那条会话的标签页，其实拿到的是列表里的第一个。
 */
export function isSessionTab(path: string, chatSid: string): boolean {
  if (!chatSid) return false
  if (!path.startsWith('/dev-assistant')) return false

  const query = path.split('?')[1] || ''
  return new URLSearchParams(query).get('sid') === chatSid
}

/** 这个标签页开的是哪条对话；不是对话标签页（或者没带 sid）就是空串 */
export function chatSidOfTab(path: string): string {
  if (!path.startsWith('/dev-assistant')) return ''
  const query = path.split('?')[1] || ''
  return new URLSearchParams(query).get('sid')?.trim() || ''
}

/**
 * 「打开某条会话」该跳到哪 —— 侧边栏、归档列表和系统通知共用。
 *
 * 各写一遍的话必然分叉：一边复用已经开着的标签页，另一边每点一次
 * 新开一个，用户会收获一排指向同一条对话的标签。
 */
export function chatSessionRoute(sid: string, openTabPaths: string[]): RouteLocationRaw {
  const existing = openTabPaths.find((path) => isSessionTab(path, sid))
  return existing ?? { name: 'AssistantWelcome', query: { sid } }
}

/**
 * 造一个新的会话 id（时间戳 base36 + 随机串）——
 * 侧边栏、标签页头和托盘菜单的「新对话」共用这一个实现。
 */
export function generateChatSessionId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${t}${r}`
}
