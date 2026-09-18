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

/**
 * 主窗口。
 *
 * 判据是「非置顶的大窗口」—— MiniChat 固定 400×600 且置顶，Spotlight 680×90
 * 且置顶，主窗口 minWidth 1350 / minHeight 800。
 *
 * 原来散在各处的版本为了躲开 Agent 浏览器，把门槛抬到了 1000×900 —— 那是把
 * 「区分窗口种类」和「排除远程页面」两件事混在一条尺寸判据上，而用户既能把
 * 浏览器窗口拉大，也能把主窗口拉到 1400×850。现在排除交给上面的登记表，
 * 尺寸判据回到只需要区分盒子自己那几种窗口的宽松值。
 */
export function findMainWindow(): BrowserWindow | undefined {
  return getAppWindows().find((window) => {
    if (window.isAlwaysOnTop()) return false
    const [width, height] = window.getSize()
    return width >= 800 && height >= 600
  })
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

/** 测试用：清掉登记表 */
export function resetNonAppWindowsForTest(): void {
  nonAppWindowIds.clear()
}
