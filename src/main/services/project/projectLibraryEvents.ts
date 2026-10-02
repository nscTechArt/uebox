import { sendToAppWindows } from '../../appWindows'
import { logger } from '../logger'

const listeners = new Set<() => void>()

export function onProjectLibraryChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 告诉「我的项目」变了，该重新读一遍：界面广播之外，主进程内部也有订阅者。
 *
 * 为什么需要：项目库现在有三个入口会往里加东西 —— 用户在首页点导入、
 * agent 用 `project_manage` 建工程、UE 连上时补登记。后两个都发生在
 * **用户没在操作首页的时候**，不推一下的话，工程明明进库了，界面上还是空的，
 * 得切个页面或者重启才看得见。用户会认为「它说建好了但其实没有」。
 *
 * 已经有一个 `ws:projects-changed` 了，但那个说的是「哪些工程此刻连着盒子」
 * （卡片上的在线角标），和「库里有哪些工程」是两回事，不能复用。
 */
export function notifyProjectLibraryChanged(): void {
  try {
    sendToAppWindows('db:project:library-changed')
  } catch (error) {
    logger.warn('[项目库] 变更通知广播失败:', error)
  }
  notifyProjectLibraryListeners()
}

/**
 * 只叫醒主进程内部的订阅者（托盘的候选名单缓存），不向界面广播。
 * 给界面自己发起的写用 —— `db:project:create` / `db:project:update`：
 * 广播回去的话首页每收到一次就把整个项目区重读一遍，而拖拽排序
 * 是每个工程各调一次 update，一次拖动就是 N 遍全量刷新。
 */
export function notifyProjectLibraryListeners(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      logger.error('[项目库] 变更订阅者出错:', error)
    }
  }
}
