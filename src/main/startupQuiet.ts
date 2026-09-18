/**
 * 启动期安静模式（仅开发环境）。
 *
 * `pnpm dev` 的控制台在主窗口出现之前会刷出一百多行「XX 已注册」「XX 表初始化完成」，
 * 全是各处随手写的 `console.log`。它们对排查具体问题有用，但每次启动都全量打印，
 * 结果是真正要看的东西（端口、报错、UE 工程连上没有）被埋在里面。
 *
 * 这里在启动期间把 `console.log` 收起来，结束时报一句折叠了多少条。
 *
 * 三条边界，都是有意的：
 *   · 只动 `console.log`。`console.warn` / `console.error` 一律照常输出 —— 出问题时
 *     绝不能是静悄悄的。
 *   · 不影响 electron-log。它在自己模块加载时就抓走了 console 各方法的原始引用，
 *     而且 info 走的是 `console.info`，跟这里补丁的 `console.log` 不是同一个函数。
 *   · 只在开发环境生效，`UA_VERBOSE=1` 可完全关闭。
 */
import { is } from '@electron-toolkit/utils'

/** 兜底：万一启动流程异常退出没走到 endQuietStartup，也不能让控制台永久哑掉 */
const FORCE_RESTORE_MS = 30_000

let restore: (() => void) | null = null
let suppressedCount = 0

/**
 * 开始折叠启动期的 console.log 输出
 */
export function beginQuietStartup(): void {
  if (restore) return
  if (!is.dev || process.env.UA_VERBOSE === '1') return

  const originalLog = console.log
  suppressedCount = 0

  console.log = (...args: unknown[]): void => {
    suppressedCount += 1
    void args
  }

  const timer = setTimeout(() => {
    endQuietStartup()
  }, FORCE_RESTORE_MS)
  // 别因为这个兜底定时器把进程拖住不退出
  timer.unref?.()

  restore = () => {
    clearTimeout(timer)
    console.log = originalLog
  }
}

/**
 * 恢复 console.log，并说明折叠了多少条
 *
 * @returns 本次折叠的条数（没启用安静模式时为 0）
 */
export function endQuietStartup(): number {
  if (!restore) return 0

  restore()
  restore = null

  const count = suppressedCount
  suppressedCount = 0

  if (count > 0) {
    console.log(`[启动] 已折叠 ${count} 条启动日志，需要看全部请用 UA_VERBOSE=1 pnpm dev`)
  }

  return count
}
