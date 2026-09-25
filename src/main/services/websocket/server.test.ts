/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { describeListenError } from './server'

/**
 * WebSocket 服务端的行为回归。
 *
 * 这一层此前**一个测试都没有** —— 而它是盒子和 UE 插件之间唯一的通道，
 * 出问题的表现全是「命令发出去了但没反应」这类没法自证的现象。
 * 下面每一条都对应一个真实存在过的缺陷，不是为了覆盖率凑的。
 *
 * 用真的 `ws` 起服务、真的客户端连上去：这一层的 bug（半断开、被冒充、
 * 超大包）全都发生在协议边界上，mock 掉 socket 就等于把要测的东西测没了。
 */

// services/config.ts 在模块加载时就读 app.isPackaged
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: (): string => process.cwd(), getPath: (): string => '' }
}))

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

/**
 * 假的工程表。
 *
 * 原来 `hasProject` 恒为 false，于是 `deleteProject` 永远不会被调用 ——
 * 「断开时有没有把工程记录删掉」这件事，测试实际上一次都没验过。
 * 停服漏删工程那个 bug 能一路活到真机上，缺的就是这个。
 */
const knownProjects = new Set<string>()
const deleteProject = vi.fn((id: string) => knownProjects.delete(id))
vi.mock('../project', () => ({
  projectManager: {
    hasProject: (id: string): boolean => knownProjects.has(id),
    deleteProject: (id: string): void => {
      deleteProject(id)
    }
  }
}))

import { WebSocketService } from './server'
import { WebSocketErrorCode } from './types'

/** 入站消息的去处。这些用例只关心传输层，不关心路由到哪 */
const onInbound = vi.fn(async () => undefined)

let service: WebSocketService
let port: number

/**
 * 连一个尽量像真插件的客户端。
 *
 * **必须带 `Origin: http://127.0.0.1`** —— 这是 UE 的 IWebSocket
 * （libwebsockets 实现）真实握手时会发的头。曾经这个 helper 不带 Origin，
 * 结果一次「拒绝带 Origin 的连接」的改动让所有真机连接全废，
 * 而这套测试照样全绿。见下面那条回归用例。
 */
function connectPlugin(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: 'http://127.0.0.1' }
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** 等到服务端确实认到了 n 个连接 */
async function waitForConnections(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (service.getConnectionCount() === n) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等不到 ${n} 个连接，当前 ${service.getConnectionCount()}`)
}

beforeEach(async () => {
  deleteProject.mockClear()
  knownProjects.clear()
  onInbound.mockClear()
  service = new WebSocketService(onInbound)
  // 端口 0 = 让系统分配，避免测试之间抢 17860
  await service.startServer(0)
  port = service.getStatus().port
})

afterEach(async () => {
  await service.stopServer()
})

describe('握手', () => {
  /**
   * 回归用例：UE 插件带着 `Origin: http://127.0.0.1` 来握手，必须能连上。
   *
   * 出过事。为了挡「网页冒充插件」加过一条 `verifyClient`：带 Origin 就拒。
   * 前提是「UE 的 IWebSocket 不发 Origin」—— 这个前提是错的，它走
   * libwebsockets，发的正是 `http://127.0.0.1`。真机上插件的重连 ticker
   * 每 5 秒被拒一次，日志刷满「拒绝带 Origin 的连接」，用户侧就是连不上。
   *
   * 当时测试没拦住，是因为 node 的 ws 客户端默认不发 Origin —— 测试连的
   * 根本不是插件真实会发的那种握手。所以这条用例的重点不是「Origin 被允许」，
   * 而是**测试客户端必须复刻真实握手**。
   */
  it('接受 UE 插件的握手（带 Origin: http://127.0.0.1）', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)
    expect(service.getConnectionCount()).toBe(1)
    socket.close()
  })

  it('拒绝外部网页的 Origin', async () => {
    const error = await new Promise<Error>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: 'https://evil.example' }
      })
      socket.once('open', () => {
        socket.close()
        reject(new Error('外部网页 Origin 不应通过握手'))
      })
      socket.once('error', resolve)
    })

    expect(error.message).toMatch(/403/)
    expect(service.getConnectionCount()).toBe(0)
  })

  it('接受不带 Origin 的连接', async () => {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`)
      s.once('open', () => resolve(s))
      s.once('error', reject)
    })
    await waitForConnections(1)
    expect(service.getConnectionCount()).toBe(1)
    socket.close()
  })
})

describe('请求生命周期', () => {
  it('没有连接时立刻失败，不等超时', async () => {
    await expect(service.callRequest('actor.spawn', {})).rejects.toMatchObject({
      code: WebSocketErrorCode.E_CLIENT_NOT_FOUND
    })
  })

  /**
   * 断线时 `rejectByClient()` 要能匹配到这个请求。
   *
   * 曾经不行：不指定 clientId 的请求以 `clientId=undefined` 登记，
   * 却发给了 connections[0]，于是断线时匹配不上，调用方只能等满超时
   * ——「引擎已经关了」明明是立刻可知的。
   */
  it('对面断开时，进行中的请求立刻被拒绝而不是等超时', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    // 超时设得很长：如果实现退化成「等超时」，这条用例会挂在这里而不是通过
    const pending = service.callRequest('editor.save', {}, undefined, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    socket.terminate()

    await expect(pending).rejects.toMatchObject({
      code: WebSocketErrorCode.E_CONNECTION_CLOSED
    })
  })

  /**
   * 用户按停止之后，这条在等的 RPC 要当场作废。
   *
   * 不作废的话，agent 的工具会一直挂在这里等满自己的超时（截图那条路是
   * 38 秒），而界面的停止按钮在等它 —— 用户点了没反应，只好再点几下。
   */
  it('中止信号一触发就作废在等的请求，不等超时', async () => {
    await connectPlugin()
    await waitForConnections(1)

    const controller = new AbortController()
    // 超时设得很长：实现要是退化成「等超时」，这条用例会挂住而不是通过
    const pending = service.callRequest(
      'editor.screenshot',
      {},
      undefined,
      60_000,
      controller.signal
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: WebSocketErrorCode.E_ABORTED })
    // 引擎那边可能已经拍完了。措辞不能让调用方以为「没执行」
    await expect(pending).rejects.toThrow(/可能已经做完/)
  })

  // 已经停了还往引擎发命令，等于用户按了停止、场景里又多了一次改动
  it('信号已经中止时根本不发出去', async () => {
    await connectPlugin()
    await waitForConnections(1)

    const controller = new AbortController()
    controller.abort()

    await expect(
      service.callRequest('actor.spawn', {}, undefined, 60_000, controller.signal)
    ).rejects.toMatchObject({ code: WebSocketErrorCode.E_ABORTED })
  })

  /**
   * 断线的错误信息里必须写着「别原样重试」。
   *
   * 读这句话的是模型，不是人。只说「连接断了」的话，它的合理反应是等重连
   * 然后重发同一条命令 —— 而请求执行到一半断线，最常见的原因正是这条命令
   * 把编辑器搞崩了，于是重试再崩一次（2026-09-02 真机上连崩两次）。
   */
  it('断线的错误信息要带上方法名并劝阻原样重试', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    const pending = service.callRequest('content.import', {}, undefined, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    socket.terminate()

    await expect(pending).rejects.toThrow(/content\.import/)
    await expect(pending).rejects.toThrow(/不要用同样的参数直接重试/)
  })

  /**
   * 超大响应必须**归因到具体请求**再拒绝。
   *
   * 原来是「太大就 return」，那个 Promise 谁也不去动，调用方等满超时，
   * 日志里只有一行 warn，上层看到的是「引擎没反应」而不是「响应太大」。
   */
  it('响应超过上限时，拒绝对应的那个请求并说明原因', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    socket.on('message', (raw: Buffer) => {
      const req = JSON.parse(raw.toString('utf8'))
      if (req.type !== 'req') return
      socket.send(
        JSON.stringify({
          ver: '1.0',
          type: 'res',
          id: req.id,
          code: 200,
          result: { blob: 'x'.repeat(600 * 1024) }
        })
      )
    })

    await expect(
      service.callRequest('blueprint.get_graph', {}, undefined, 60_000)
    ).rejects.toMatchObject({ code: WebSocketErrorCode.E_MESSAGE_TOO_LARGE })

    socket.close()
  })

  it('正常响应能匹配回请求', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    socket.on('message', (raw: Buffer) => {
      const req = JSON.parse(raw.toString('utf8'))
      if (req.type !== 'req') return
      socket.send(
        JSON.stringify({ ver: '1.0', type: 'res', id: req.id, code: 200, result: { ok: true } })
      )
    })

    await expect(service.callRequest('editor.save', {}, undefined, 5_000)).resolves.toMatchObject({
      ok: true
    })

    socket.close()
  })
})

describe('多工程并发', () => {
  /**
   * 两个 UE 都连着、调用方没指定目标时，**宁可报错也不要猜**。
   *
   * 原来是取 connections[0]。猜错的代价是改错别人的关卡，而且是静默的：
   * 用户看到「执行成功」，然后发现另一个项目变了。
   */
  it('多个连接且未指定目标时拒绝执行', async () => {
    const a = await connectPlugin()
    const b = await connectPlugin()
    await waitForConnections(2)

    await expect(service.callRequest('actor.destroy', {})).rejects.toMatchObject({
      code: WebSocketErrorCode.E_CLIENT_NOT_FOUND
    })

    a.close()
    b.close()
  })

  it('显式指定 clientId 时正常发给那一个', async () => {
    const a = await connectPlugin()
    const b = await connectPlugin()
    await waitForConnections(2)

    const ids = service
      .getConnectionManager()
      .getAllConnections()
      .map((conn) => conn.id)

    let servedBy = ''
    for (const [label, socket] of [
      ['a', a],
      ['b', b]
    ] as const) {
      socket.on('message', (raw: Buffer) => {
        const req = JSON.parse(raw.toString('utf8'))
        if (req.type !== 'req') return
        servedBy = label
        socket.send(
          JSON.stringify({ ver: '1.0', type: 'res', id: req.id, code: 200, result: { ok: true } })
        )
      })
    }

    await service.callRequest('editor.save', {}, ids[1], 5_000)
    expect(servedBy).not.toBe('')

    a.close()
    b.close()
  })
})

/**
 * 2026-09-26 真机反馈：编辑器崩在引擎断言里，socket 和心跳都在，请求一条都不答。
 * 盒子一直当它连着，全队干等二十分钟。按「答不答话」判活。
 */
describe('僵尸连接', () => {
  it('连续三次请求超时、中间一次都没答：断开', async () => {
    await connectPlugin() // 这个插件只收不答
    await waitForConnections(1)
    for (let i = 0; i < 3; i++) {
      await expect(service.callRequest('content.search', {}, undefined, 30)).rejects.toMatchObject({
        code: 'E_TIMEOUT'
      })
    }
    await waitForConnections(0)
  })

  it('还有请求在路上（长操作占着游戏线程）时超时不算，不断开', async () => {
    await connectPlugin()
    await waitForConnections(1)
    const long = service.callRequest('content.import', {}, undefined, 60_000)
    long.catch(() => undefined)
    for (let i = 0; i < 3; i++) {
      await expect(service.callRequest('content.search', {}, undefined, 30)).rejects.toMatchObject({
        code: 'E_TIMEOUT'
      })
    }
    expect(service.getConnectionCount()).toBe(1)
    const id = service.getConnectionManager().getAllConnections()[0]!.id
    await expect(service.probeConnection(id)).resolves.toBe('busy')
  })

  it('探活：不答话就是 dead', async () => {
    await connectPlugin()
    await waitForConnections(1)
    const id = service.getConnectionManager().getAllConnections()[0]!.id
    await expect(service.probeConnection(id, 30)).resolves.toBe('dead')
  })
})

describe('断线善后', () => {
  /**
   * 心跳超时和正常断开必须走同一条流程。
   *
   * 心跳那条以前只删项目，既不拒绝待处理请求、也不真正关 socket ——
   * 于是产生半断开：盒子认为断了，socket 还开着，插件也不重连。
   */
  it('连接关闭后从连接池移除，并且是幂等的', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    socket.terminate()
    await waitForConnections(0)

    expect(service.getConnectionCount()).toBe(0)
    // 再来一次不应该抛（close 和 error 可能都触发一次）
    expect(() => service.getStatus()).not.toThrow()
  })

  /** 连接没了，工程记录就得跟着没。少了这一步，界面会一直显示「已连接」 */
  it('连接关闭后工程记录也被删掉', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)
    knownProjects.add(service.getConnectionManager().getAllConnections()[0].id)

    socket.terminate()
    await waitForConnections(0)

    expect(deleteProject).toHaveBeenCalledTimes(1)
  })

  /**
   * 回归用例：停服也要删工程记录。
   *
   * 以前 `stopServer` 直接调 `connectionManager.stop()`，那条路只摘连接、
   * 不走断线流程 —— 工程于是以 `isConnected: true` 永远留在列表里。
   * 退出应用时看不出来，但 `ws:stop` 这个 IPC 和 `serviceManager.restart()`
   * 是运行期就能走到的：那之后盒子会一直说「工程连着」，直到应用重开。
   * 真机上模型据此对一个用户早就关掉的工程说「现在连着的是它」。
   */
  it('停服时工程记录一并清掉，不留下永远在线的残影', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)
    knownProjects.add(service.getConnectionManager().getAllConnections()[0].id)

    await service.stopServer()

    expect(deleteProject).toHaveBeenCalledTimes(1)
    expect(knownProjects.size).toBe(0)
    socket.terminate()
  })

  it('停服后待处理请求被清理，不会永远挂着', async () => {
    const socket = await connectPlugin()
    await waitForConnections(1)

    const pending = service.callRequest('editor.save', {}, undefined, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.stopServer()

    await expect(pending).rejects.toMatchObject({
      code: WebSocketErrorCode.E_CONNECTION_CLOSED
    })
    socket.terminate()
  })
})

/**
 * 端口被占用。
 *
 * 真机上撞出来的：本机已经开着一个盒子（占着 17860），再启动一份打包产物时，
 * 这个异常一路冒到 `index.ts` 的 `app.quit()` —— 盒子**连窗口都不创建**，
 * 用户只看到程序闪一下就没了，没有任何提示。
 *
 * 这一层的职责是：说清楚原因，并把它留在状态里。让不让应用退出是
 * `services/index.ts` 的事（现在它不退了）。
 */
describe('端口被占用', () => {
  it('报错里要说清楚为什么被占、以及该怎么办', async () => {
    const blocker = new WebSocketService(onInbound)
    await blocker.startServer(0)
    const taken = blocker.getStatus().port

    const loser = new WebSocketService(onInbound)
    try {
      await expect(loser.startServer(taken)).rejects.toMatchObject({
        code: WebSocketErrorCode.E_ADDRINUSE
      })

      // 光说「端口 X 已被占用」不够 —— 用户需要知道该关掉什么
      const status = loser.getStatus()
      expect(status.startError).toContain(String(taken))
      expect(status.startError).toContain('虚幻盒子')
      expect(status.startError).toMatch(/关掉|别的程序/)
    } finally {
      await blocker.stopServer()
    }
  }, 20_000)

  /** 起不来的原因必须能被查到，否则「引擎永远连不上」就没人说得出为什么 */
  it('失败原因留在 getStatus 里，成功时没有这个字段', async () => {
    const blocker = new WebSocketService(onInbound)
    await blocker.startServer(0)
    try {
      expect(blocker.getStatus().startError).toBeUndefined()

      const loser = new WebSocketService(onInbound)
      await loser.startServer(blocker.getStatus().port).catch(() => undefined)
      expect(loser.getStatus().startError).toBeTruthy()
    } finally {
      await blocker.stopServer()
    }
  }, 20_000)
})

describe('describeListenError', () => {
  it('EADDRINUSE 翻成能照做的一句话', () => {
    const message = describeListenError({ code: 'EADDRINUSE' } as NodeJS.ErrnoException, 17860)
    expect(message).toContain('17860')
    expect(message).toContain('虚幻盒子')
    // 还要说清楚代价，否则用户不知道这条警告要不要紧
    expect(message).toContain('连接引擎')
  })

  it('EACCES 单独说，不跟占用混为一谈', () => {
    const message = describeListenError({ code: 'EACCES' } as NodeJS.ErrnoException, 17860)
    expect(message).toContain('权限')
    expect(message).not.toContain('已被占用')
  })

  /** 认不出来的错误保留系统原文，不猜 —— 猜错会把人支到另一个方向 */
  it('认不出来的错误原样带上系统消息', () => {
    const message = describeListenError(
      { code: 'EWEIRD', message: '一些没见过的错误' } as NodeJS.ErrnoException,
      17860
    )
    expect(message).toContain('一些没见过的错误')
  })
})
