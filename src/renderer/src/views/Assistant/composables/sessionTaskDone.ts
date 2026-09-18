/**
 * 「这条会话此刻是不是正摆在用户眼前」。
 *
 * 判断依据只能是**当前路由**，不能用组件自己的 sid：每个对话标签页都有一份
 * 保活着的 Welcome 实例，它的 sid 永远等于自己那条会话 —— 拿它比对的话，
 * 后台跑完的任务会被当成「用户正在看」，蓝点永远不会亮。
 */
export function isSessionOnScreen(
  routePath: string,
  routeSid: unknown,
  sessionId: string
): boolean {
  if (!sessionId) return false

  const path = String(routePath || '')
  const isAssistantRoute = path === '/dev-assistant' || path.startsWith('/dev-assistant/')
  if (!isAssistantRoute) return false

  const sid = typeof routeSid === 'string' ? routeSid : ''
  return sid === sessionId
}

/** 任务跑完时要不要给这条会话点亮「已完成」蓝点 */
export function shouldMarkTaskDone(
  routePath: string,
  routeSid: unknown,
  sessionId: string
): boolean {
  if (!sessionId) return false
  return !isSessionOnScreen(routePath, routeSid, sessionId)
}
