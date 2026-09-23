import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 连接超时之后，那个握手还在跑的客户端要关掉。
 *
 * 超时只是我们不等了：SDK 那边的初始化请求还挂着（它自己的超时是 60 秒），
 * 而这时它还没登记进连接表，上层的 `disconnect(id)` 摸不到它。首次 `npx -y`
 * 要下载半分钟的 server 会在 20~60 秒之间握手成功，然后作为一个没人引用的
 * 子进程一直活到盒子退出 —— 重试一次就再多一个。
 */

const clients = vi.hoisted(() => [] as Array<{ close: ReturnType<typeof vi.fn> }>)

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    close = vi.fn(async () => undefined)
    constructor() {
      clients.push(this)
    }
    // 握手永远不回来：模拟一个还在下载依赖的 server
    connect = (): Promise<void> => new Promise(() => undefined)
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {}
}))

import { McpClientManager } from './McpClientManager'

afterEach(() => {
  vi.useRealTimers()
  clients.length = 0
})

describe('McpClientManager 连接超时', () => {
  it('超时就把还在握手的客户端关掉，不留孤儿进程', async () => {
    vi.useFakeTimers()
    const manager = new McpClientManager()

    const adding = manager.addServer('slow', { type: 'stdio', command: 'npx' })
    const outcome = expect(adding).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(20_000)
    await outcome

    expect(clients).toHaveLength(1)
    expect(clients[0].close).toHaveBeenCalled()
  })
})
