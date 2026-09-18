/**
 * 会话取名：截断标题先顶上，轻量模型几秒后换成真正的名字。
 *
 * 为什么是两步而不是一步等模型回来：侧边栏那一行**立刻**就要有字。让它空着几秒
 * 再跳出一个标题，用户看到的是界面在抽搐；而模型没配、断网、本地模型卡住这几种
 * 情况都不罕见，一步走的话它们的表现就是「这条会话永远叫未命名」。
 *
 * 所以这一层的全部职责就是：**失败了什么都不做**。截断标题已经在那儿了。
 */

/** 同一条会话同时只起一次名。重复发起不会更准，只会多花一次调用 */
const inFlight = new Set<string>()

export interface AutoNameSessionDeps {
  /** 读当前标题，用来判断这几秒里有没有人动过它 */
  getTitle: (sessionId: string) => string | undefined
  /** 真正落名。侧边栏和标签页都归调用方去改，这一层不认界面 */
  applyTitle: (sessionId: string, title: string) => void
}

/**
 * 发起一次取名。**不返回 Promise**，调用方不该等它。
 *
 * @param placeholderTitle 刚写进去的截断标题。只有标题还等于它时才覆盖 ——
 *   用户在这几秒里手动改了名，那是他的手笔，模型没资格盖掉。
 */
export function autoNameSession(
  sessionId: string,
  firstMessage: string,
  placeholderTitle: string,
  deps: AutoNameSessionDeps
): void {
  // 主进程的桥还没挂上（单测、MiniChat 起来之前）：没有桥就别起名
  if (typeof window === 'undefined' || typeof window.api?.ai?.chatCompletion !== 'function') {
    return
  }
  if (!sessionId || !firstMessage.trim() || inFlight.has(sessionId)) return

  inFlight.add(sessionId)
  void (async () => {
    try {
      // 懒加载：`api/ai` 顶层就把 i18n 实例建起来了，而发消息这条路（
      // `chatSendPrimitives`）是四个入口共用的同步函数，静态 import 会把那一整串
      // 拖进每一个 import 它的模块和单测里去。取名本来就晚几秒，这一步不急
      const { aiAPI } = await import('../../../api/ai')
      const title = await aiAPI.generateSessionTitle({ firstMessage })
      if (!title) return
      if (deps.getTitle(sessionId) !== placeholderTitle) return
      deps.applyTitle(sessionId, title)
    } catch (error) {
      // 轻量任务模型没绑、超时、返回错误，都走这里。截断标题继续用着
      console.warn('[chat] 自动为会话取名失败，保留截断标题:', error)
    } finally {
      inFlight.delete(sessionId)
    }
  })()
}

/** 只给单测用：清掉在途标记，避免用例之间互相串 */
export function resetAutoNameStateForTest(): void {
  inFlight.clear()
}
