import { cancelAssetImport } from '../../../services/asset/importControl'
import { ipcMain } from 'electron'

type ImportErrorResolver = (action: string) => void

export interface AssetImportRuntimeState {
  importErrorResolvers: Map<string, ImportErrorResolver[]>
}

export class ImportErrorPromptQueue {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(handler: () => Promise<T> | T): Promise<T> {
    const previous = this.tail
    let releaseCurrent: () => void = () => {}
    this.tail = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })

    await previous
    try {
      return await handler()
    } finally {
      releaseCurrent()
    }
  }
}

const windowPromptQueues = new WeakMap<object, ImportErrorPromptQueue>()
export function getImportPromptQueue(owner: object): ImportErrorPromptQueue {
  let queue = windowPromptQueues.get(owner)
  if (!queue) {
    queue = new ImportErrorPromptQueue()
    windowPromptQueues.set(owner, queue)
  }
  return queue
}

export interface ImportErrorWaitOptions {
  /** 等多久就自己做决定。默认 120 秒 */
  timeoutMs?: number
  /** 轮询「还有人能回答吗」——窗口关了/刷新了就返回 true */
  isAbandoned?: () => boolean
  /** 轮询间隔，默认 1 秒 */
  pollIntervalMs?: number
  /** 超时或没人能回答时替用户做的决定。默认「全部忽略」，让导入继续跑完 */
  fallbackAction?: string
  /** 替用户做了决定时回调一次，调用方据此留痕 */
  onFallback?: (reason: 'timeout' | 'window_gone') => void
}

/**
 * 等用户在「解析出错，忽略还是取消」弹窗上做选择。
 *
 * ⚠️ 必须有超时和「窗口没了」的兜底。原来这里是无限期等待、也不监听窗口关闭：
 * 主进程把事件发出去就原地等，用户此时关掉或刷新窗口 → 这个 Promise 永远不兑现
 * → **导入永远停在预处理阶段，进度条不动，只能重启应用**。
 * 并发工人共用同一个提示队列，所以是一起挂死。
 */
export function waitForImportErrorResolution(
  runtime: AssetImportRuntimeState,
  taskId: string,
  options: ImportErrorWaitOptions = {}
): Promise<string> {
  const {
    timeoutMs = 120_000,
    isAbandoned,
    pollIntervalMs = 1_000,
    fallbackAction = 'ignore_all',
    onFallback
  } = options

  return new Promise<string>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let poller: ReturnType<typeof setInterval> | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (poller) clearInterval(poller)
      timer = null
      poller = null
    }

    const settle = (action: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(action)
    }

    /** 兜底时要把自己从等待队列里摘掉，否则迟到的回答会错位落到下一个提问上 */
    const detach = (): void => {
      const pending = runtime.importErrorResolvers.get(taskId)
      if (!pending) return
      const index = pending.indexOf(onResolved)
      if (index >= 0) pending.splice(index, 1)
      if (pending.length === 0) runtime.importErrorResolvers.delete(taskId)
    }

    const onResolved: ImportErrorResolver = (action) => settle(action)

    const giveUp = (reason: 'timeout' | 'window_gone'): void => {
      if (settled) return
      detach()
      onFallback?.(reason)
      settle(fallbackAction)
    }

    const pendingResolvers = runtime.importErrorResolvers.get(taskId) || []
    pendingResolvers.push(onResolved)
    runtime.importErrorResolvers.set(taskId, pendingResolvers)

    timer = setTimeout(() => giveUp('timeout'), timeoutMs)
    if (isAbandoned) {
      // 先查一次：窗口可能在发事件之前就已经没了
      if (isAbandoned()) {
        giveUp('window_gone')
        return
      }
      poller = setInterval(() => {
        if (isAbandoned()) giveUp('window_gone')
      }, pollIntervalMs)
    }
  })
}

export function resolvePendingImportError(
  runtime: AssetImportRuntimeState,
  taskId: string,
  action: string
): boolean {
  const pendingResolvers = runtime.importErrorResolvers.get(taskId)
  if (!pendingResolvers || pendingResolvers.length === 0) {
    return false
  }

  const resolvers =
    action === 'ignore_all' || action === 'cancel'
      ? pendingResolvers.splice(0)
      : pendingResolvers.splice(0, 1)

  if (pendingResolvers.length === 0) {
    runtime.importErrorResolvers.delete(taskId)
  }

  resolvers.forEach((resolve) => resolve(action))
  return true
}

export function isRecoverablePreprocessWarning(errorMessage: string): boolean {
  return errorMessage.includes('解析超时')
}

export function createAssetImportRuntimeState(): AssetImportRuntimeState {
  const importErrorResolvers = new Map<string, ImportErrorResolver[]>()

  return { importErrorResolvers }
}

/**
 * 「导入并发数」那个可调项删掉了（连同 asset:setImportConcurrency /
 * asset:getImportConcurrency 两个 IPC）。
 *
 * 它是个全局可变值，而渲染层早就按库类型算出了更好的数：远端 HTTP 库 2、
 * 局域网库 1、本地库 3（见 `AssetManagement/index.vue` 里
 * `configuredConcurrency`）。用户在设置页填的那个数**覆盖**这三档 ——
 * 也就是有人把它拉到 10，就是拿 10 路并发去压一个代码里特意限到 1 的 SMB 共享。
 *
 * 现在按库类型那三档直接生效，并发数随导入请求一起传进来，不再有全局旁路。
 */
export function registerAssetImportConfigIPC(runtime: AssetImportRuntimeState): void {
  ipcMain.handle('asset:cancelImport', async (_, taskId: string) => {
    const cancelled = cancelAssetImport(taskId)
    resolvePendingImportError(runtime, taskId, 'cancel')
    return { success: cancelled }
  })
  ipcMain.handle('asset:resolveImportError', async (_, { taskId, action }) => {
    const resolved = resolvePendingImportError(runtime, taskId, action)
    if (!resolved) {
      return { success: false, error: '导入错误处理已失效，请重新发起导入' }
    }
    return { success: true }
  })
}
