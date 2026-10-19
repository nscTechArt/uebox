/**
 * Express 应用的一次监听尝试，和监听失败时给人看的那句话。
 *
 * 单独成文件是为了能测：`server.ts` 一加载就把 sqlite 和工程工具拉进来，
 * 测试里 import 它会碰到原生模块。这里只依赖 express 的类型。
 *
 * ## 为什么不能照抄 `http.Server.listen` 的写法
 *
 * Express 5 的 `app.listen(port, host, callback)` 把 callback 同时挂在
 * `listening` 和 `error` 上（`server.once('error', done)`）—— 监听失败时
 * callback **也会被调用**，错误作为第一个参数传进来。
 *
 * 原来的写法在 callback 里无条件打「启动成功」：2026-10-19 真机上默认端口 8766
 * 落在 Windows 的保留端口段里，绑定报 EACCES，日志照样写着启动成功，
 * 端口上却什么都没有，查了好一阵才对上。
 */

import type { Server } from 'http'

/** 只要 listen 这一个方法，测试里可以换成假的 */
export interface Listenable {
  listen(port: number, host: string, callback: (error?: Error) => void): Server
}

/**
 * 监听一次。成功给出 server；失败 reject 原始错误（带 `code`），并把半开的 server 关掉，
 * 否则重试会挂在一个坏实例上。
 *
 * 监听成功之后的错误照样要有人接：没有 `error` 监听器的话，Node 会把它当未捕获异常
 * 抛出来，直接带走主进程。接住之后交给 `onLateError` 记下来 —— 默不作声地吞掉，
 * 就又是「服务悄悄不响应、日志里什么都没有」那一类问题。
 */
export function listenOnce(
  app: Listenable,
  port: number,
  host: string,
  onLateError?: (error: Error) => void
): Promise<Server> {
  return new Promise((resolve, reject) => {
    let settled = false
    /** 监听失败时 Express 会把同一个错误同时交给 callback 和 error 事件，第二次不算「运行中出错」 */
    let startupError: Error | undefined
    const fail = (error: Error): void => {
      if (settled) {
        if (error !== startupError) onLateError?.(error)
        return
      }
      settled = true
      startupError = error
      server.close(() => undefined)
      reject(error)
    }
    const server = app.listen(port, host, (error?: Error) => {
      if (error) return fail(error)
      if (settled) return
      settled = true
      resolve(server)
    })
    server.on('error', fail)
  })
}

/** 监听失败时那句话：说清是什么挡住了、下一步改什么。HTTP 服务只给开发者用，可以讲端口和命令 */
export function describeHttpListenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES') {
    return (
      `HTTP 调试服务绑不上端口 ${port}（EACCES）。Windows 上多半是这个端口落在系统保留段里，` +
      '用 `netsh interface ipv4 show excludedportrange protocol=tcp` 可以查；' +
      '设 HTTP_PORT 换一个不在保留段里的端口再启动。'
    )
  }
  if (code === 'EADDRINUSE') {
    return `HTTP 调试服务的端口 ${port} 被别的程序占着（EADDRINUSE），重试后仍然占用。设 HTTP_PORT 换一个端口。`
  }
  return `HTTP 调试服务在端口 ${port} 上启动失败：${error instanceof Error ? error.message : String(error)}`
}
