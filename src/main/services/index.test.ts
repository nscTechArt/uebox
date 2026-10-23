/**
 * @vitest-environment node
 *
 * ServiceManager 启动时，可选服务起不来不能带走其余服务。
 *
 * HTTP 调试服务以前「从来没失败过」—— 不是因为它不会失败，是因为它一直谎报成功
 * （Express 5 的 listen 回调出错也会被调用，见 `http/listen.ts`）。修好之后，
 * 失败第一次真的冒上来：要是还走原来那条 catch，引擎桥接会被一起停掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ws = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  getStatus: vi.fn(() => ({})),
  getConnectionManager: vi.fn(() => ({})),
  sendToClient: vi.fn()
}))
const http = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(async () => undefined) }))
const warn = vi.hoisted(() => vi.fn())

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./config', () => ({ config: { http: { enabled: true } } }))
vi.mock('./websocket/server', () => ({
  WebSocketService: vi.fn(function WebSocketService() {
    return ws
  })
}))
vi.mock('./http/server', () => ({
  HttpServer: vi.fn(function HttpServer() {
    return {
      start: http.start,
      stop: http.stop,
      setTaskManager: vi.fn(),
      setConnectionManager: vi.fn(),
      getStatus: vi.fn(() => ({ running: true }))
    }
  })
}))
vi.mock('./task/taskManager', () => ({
  TaskManager: vi.fn(function TaskManager() {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getStats: vi.fn(() => ({}))
    }
  })
}))
vi.mock('./messaging/router', () => ({
  MessageRouter: vi.fn(function MessageRouter() {
    return { route: vi.fn() }
  })
}))
vi.mock('./messaging/handlers', () => ({ registerHandlers: vi.fn() }))
vi.mock('./task/executors', () => ({ registerExecutors: vi.fn() }))
vi.mock('./monitoring/metrics', () => ({ metricsCollector: {} }))
vi.mock('./monitoring/healthCheck', () => ({ healthCheckService: {} }))

import { ServiceManager } from './index'

beforeEach(() => {
  vi.clearAllMocks()
  // 启动收尾会往 process 上挂 SIGINT / uncaughtException，测试里不能真挂
  vi.spyOn(process, 'on').mockImplementation(() => process)
})

const manager = (): ServiceManager =>
  new ServiceManager({ enableMetrics: false, enableHealthCheck: false })

describe('ServiceManager.start', () => {
  it('HTTP 调试服务起不来：照常启动完，引擎桥接不被停掉', async () => {
    http.start.mockRejectedValueOnce(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))
    const services = manager()

    await expect(services.start()).resolves.toBeUndefined()

    expect(ws.start).toHaveBeenCalledTimes(1)
    expect(ws.stop).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 调试服务不可用'))
    // 状态里写「开了没起来」和原因，不写成「没开」
    expect(services.getStatus().services.http).toEqual({
      running: false,
      enabled: true,
      startError: 'listen EACCES'
    })
  })

  it('HTTP 起来了就照常记着，停服务时一起停', async () => {
    http.start.mockResolvedValueOnce(undefined)
    const services = manager()

    await services.start()
    await services.stop()

    expect(http.stop).toHaveBeenCalledTimes(1)
  })
})
