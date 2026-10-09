/**
 * 独立对话窗口里，存在 localStorage 的那些 store 只读不写。
 *
 * 同一个源的窗口共用一份 localStorage，而持久化插件每次都整份写回：独立窗口启动时
 * 读进来的是那一刻的快照，之后它一写，主窗口在这期间改过的标签页、侧边栏状态、
 * 模型配置就被它那份旧的盖回去了。这些界面状态的主人是主窗口。
 *
 * 对话历史不走这里 —— 它存在磁盘上，只读开关在 `chatHistoryStorage.ts`。
 */

import type { PiniaPluginContext } from 'pinia'

export function readOnlyStorage(storage: Storage): Storage {
  return {
    get length() {
      return storage.length
    },
    key: (index: number) => storage.key(index),
    getItem: (key: string) => storage.getItem(key),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {}
  }
}

type PersistOption = { storage?: unknown } & Record<string, unknown>

/**
 * 把一个 store 的持久化配置里落到 localStorage 的那部分换成只读的。
 *
 * 没写 storage 的也算：插件的缺省就是 localStorage。别的后端（磁盘、sessionStorage）不动。
 */
export function guardPersistForChatWindow(options: PiniaPluginContext['options']): void {
  const persist = (options as { persist?: unknown }).persist
  if (!persist) return

  const guard = (entry: PersistOption): PersistOption =>
    entry.storage === undefined || entry.storage === localStorage
      ? { ...entry, storage: readOnlyStorage(localStorage) }
      : entry

  if (persist === true) {
    ;(options as { persist?: unknown }).persist = { storage: readOnlyStorage(localStorage) }
  } else if (Array.isArray(persist)) {
    ;(options as { persist?: unknown }).persist = persist.map((entry) =>
      guard(entry as PersistOption)
    )
  } else if (typeof persist === 'object') {
    ;(options as { persist?: unknown }).persist = guard(persist as PersistOption)
  }
}
