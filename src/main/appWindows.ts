import { BrowserWindow } from 'electron'

/**
 * 「属于 Unreal Box 自己的窗口」。
 *
 * 在 Agent 浏览器出现之前，主进程里到处写着 `BrowserWindow.getAllWindows()`：
 * 有的拿第一个未销毁的当主窗口，有的按尺寸猜，有的直接给所有窗口广播 IPC。
 * 这些写法都默认「窗口 = 盒子的窗口」，而现在有一个装着**远程网页**的窗口
 * 也在这张表里。
 *
 * 后果分两档：
 *   - 选主窗口的地方会选错。深链接（`uebox://`）和二次实例激活按
 *     「非置顶且足够大」找主窗口 —— 用户把浏览器窗口一拉大就命中它，
 *     于是深链接被送到一个远程页面上，那个页面还会被顶到前台。
 *   - 广播 IPC 的地方会把消息发给远程页面。它没有 preload，收不到也读不到，
 *     所以不是漏洞，但也没有任何理由发过去。
 *
 * 与其逐个文件维护一张「记得排除浏览器窗口」的清单（这种清单一定会随新代码
 * 过期），不如把枚举收在这里一处。新增调用点只要用这两个函数，天然是对的。
 */

/**
 * 不属于盒子界面的窗口（按 `webContents.id` 登记）。
 *
 * 用 id 而不是窗口实例：这个模块在主进程启动早期就会被引用，不该为了一个
 * 判定把 Agent 浏览器整套代码拖进启动路径。谁创建了非界面窗口，谁负责登记。
 */
const nonAppWindowIds = new Set<number>()

export function registerNonAppWindow(webContentsId: number): void {
  nonAppWindowIds.add(webContentsId)
}

export function unregisterNonAppWindow(webContentsId: number): void {
  nonAppWindowIds.delete(webContentsId)
}

/** 这个窗口是不是盒子自己的界面 */
export function isAppWindow(window: BrowserWindow): boolean {
  if (window.isDestroyed()) return false
  return !nonAppWindowIds.has(window.webContents.id)
}

/** 盒子自己的全部窗口（主窗口、MiniChat、Spotlight……不含 Agent 浏览器） */
export function getAppWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => isAppWindow(window))
}

/** 主窗口的 `webContents.id`，由创建主窗口的地方登记 */
let mainWindowId: number | undefined

export function registerMainWindow(webContentsId: number): void {
  mainWindowId = webContentsId
}

/**
 * 主窗口。
 *
 * 认登记过的那一个，不按尺寸猜。原来的判据是「非置顶的大窗口」，可主窗口
 * 能缩到 1024×640，MiniChat 又能取消置顶再拉大 —— 两边尺寸一交叉就认错。
 * 主窗口关掉重建时 id 会变，重建时重新登记即可；登记的窗口没了就返回 undefined，
 * 调用方据此重建。
 */
export function findMainWindow(): BrowserWindow | undefined {
  if (mainWindowId === undefined) return undefined
  return getAppWindows().find((window) => window.webContents.id === mainWindowId)
}

/**
 * 给界面广播。
 *
 * 取代 `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(...)`。
 */
export function sendToAppWindows(channel: string, ...args: unknown[]): void {
  for (const window of getAppWindows()) {
    window.webContents.send(channel, ...args)
  }
}

/**
 * 给单个窗口发消息。
 *
 * 窗口和它的 `webContents` 是**两个独立的销毁标记**：关窗过程中有一段时间
 * `win.isDestroyed()` 还是 false，而 `win.webContents` 已经销毁，这时候 `send`
 * 照样抛。只查窗口那一个标记不够，所以两个都查，并且只查这一处 ——
 * 同上：枚举收在这里，新增调用点天然是对的。
 */
export function sendToWindow(
  window: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, ...args)
}

/** 测试用：清掉登记表 */
export function resetNonAppWindowsForTest(): void {
  nonAppWindowIds.clear()
  mainWindowId = undefined
}
