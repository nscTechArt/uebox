/**
 * 界面报上来的「最近三条对话」要过一遍手才信。
 *
 * IPC 边界上的一切都按不可信处理：渲染进程是用户能开 DevTools 的地方，
 * 这里收下的东西会原样画进系统菜单。超限的截掉、形状不对的不收 ——
 * 不收不是因为危险，是因为画出来只会是一句看不懂的空白。
 */
import { TRAY_RECENT_LIMIT, type TrayRecentSession } from '../../shared/trayActions'

export function sanitizeTrayRecentSessions(input: unknown): TrayRecentSession[] {
  if (!Array.isArray(input)) return []

  const sessions: TrayRecentSession[] = []
  for (const item of input) {
    if (sessions.length >= TRAY_RECENT_LIMIT) break
    if (typeof item !== 'object' || item === null) continue

    const { id, title } = item as { id?: unknown; title?: unknown }
    // 没有 id 点了也没法跳，收进来只会是个空菜单项
    if (typeof id !== 'string' || id.length === 0) continue

    sessions.push({ id, title: typeof title === 'string' ? title : '' })
  }
  return sessions
}
