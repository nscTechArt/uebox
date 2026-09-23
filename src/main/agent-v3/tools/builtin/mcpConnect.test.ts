/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { runConnect, type ConnectDeps } from './mcpConnect'
import type { McpServerConfig } from '../../capabilities/mcp/types'

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    connect: async () => ({
      status: { id: 'x', connected: true, toolCount: 1, serverName: 'echo' },
      toolNames: ['mcp_x_echo']
    }),
    existingIds: async () => [],
    persist: async () => undefined,
    settingsPath: () => 'C:/u/mcp.json',
    ...over
  }
}

describe('接一台 server', () => {
  it('连通了才写配置，写进去的正是连通的那条', async () => {
    const persist = vi.fn(async () => undefined)
    const outcome = await runConnect(
      { id: 'fs', command: 'npx', args: ['-y', 'server-filesystem'] },
      deps({ persist })
    )

    expect(outcome.isError).toBeFalsy()
    expect(persist).toHaveBeenCalledTimes(1)
    const [id, config] = persist.mock.calls[0] as unknown as [string, McpServerConfig]
    expect(id).toBe('fs')
    expect(config).toMatchObject({ type: 'stdio', command: 'npx' })
  })

  /**
   * 顺序反了就是这条测试要挡的事故：写进去再说连不上，用户盘上多一条永远
   * 报错的配置，而且是盒子替他写的 —— 他既不知道改哪里，也不敢删。
   */
  it('连不上时一个字都不写盘', async () => {
    const persist = vi.fn(async () => undefined)
    const outcome = await runConnect(
      { id: 'fs', url: '9876' },
      deps({
        persist,
        connect: async () => {
          throw new Error('fetch failed')
        }
      })
    )

    expect(outcome.isError).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(outcome.text).toContain('fetch failed')
  })

  // 只给端口时有两条候选，第一条不通要接着试第二条 —— 否则 /mcp 是约定、
  // 不是规矩这件事就白说了
  it('第一条候选不通就试下一条，报的是真正连上的那条', async () => {
    const tried: string[] = []
    const outcome = await runConnect(
      { id: 'x', url: '9876' },
      deps({
        connect: async (_id, config) => {
          const url = (config as { url: string }).url
          tried.push(url)
          if (url.endsWith('/mcp')) throw new Error('404')
          return {
            status: { id: 'x', connected: true, toolCount: 2 },
            toolNames: ['mcp_x_a', 'mcp_x_b']
          }
        }
      })
    )

    expect(tried).toEqual(['http://127.0.0.1:9876/mcp', 'http://127.0.0.1:9876/'])
    expect(outcome.isError).toBeFalsy()
    expect(outcome.details?.target).toBe('http://127.0.0.1:9876/')
  })

  it('全部候选都不通时，每条的原因都带回去', async () => {
    const outcome = await runConnect(
      { id: 'x', url: '9876' },
      deps({
        connect: async (_id, config) => {
          throw new Error(`爆了 ${(config as { url: string }).url}`)
        }
      })
    )

    expect(outcome.isError).toBe(true)
    expect(outcome.details?.attempts).toHaveLength(2)
    expect(outcome.text).toContain('爆了 http://127.0.0.1:9876/mcp')
  })

  /**
   * 同名不能默默盖掉：那条可能是用户自己调了半天参数的，而这次调用的理由
   * 往往只是模型随手起了个一样的短名字（filesystem、github）。
   */
  it('同名已存在时什么都不做，也不去连', async () => {
    const connect = vi.fn()
    const outcome = await runConnect(
      { id: 'fs', url: '9876' },
      deps({ existingIds: async () => ['fs'], connect })
    )

    expect(outcome.isError).toBe(true)
    expect(connect).not.toHaveBeenCalled()
    expect(outcome.text).toContain('overwrite')
  })

  /**
   * 引擎发现的、插件带的 server 不在 mcp.json 里，原来的同名检查看不见它们：撞名会把正在用的
   * 那台断掉，写进 mcp.json 还会永久盖住引擎发现。overwrite 也不行
   */
  it('撞上引擎 / 插件自带的 server 名：不连不写，overwrite 也不行', async () => {
    const connect = vi.fn()
    for (const id of ['ue-official', 'blender_tools']) {
      const outcome = await runConnect(
        { id, url: '9876', overwrite: true },
        deps({ reservedIds: async () => ['blender_tools'], connect })
      )
      expect(outcome.isError).toBe(true)
    }
    expect(connect).not.toHaveBeenCalled()
  })

  // 工具检索开着时第三方组不常驻，下一条消息靠这份名单把它们装回来
  it('接上之后把新工具登记成「这一步加载的」', async () => {
    const outcome = await runConnect({ id: 'fs', url: '9876' }, deps())
    expect(outcome.addedToolNames).toEqual(['mcp_x_echo'])
  })

  /** 握手那十几秒里用户按了停止：界面说停了，它就不能还连着、还写进配置 */
  it('握手途中按了停止：接上的断开，配置不写', async () => {
    const controller = new AbortController()
    const persist = vi.fn(async () => undefined)
    const disconnect = vi.fn(async () => undefined)
    const outcome = await runConnect(
      { id: 'fs', url: '9876' },
      deps({
        persist,
        disconnect,
        connect: async () => {
          controller.abort()
          return {
            status: { id: 'fs', connected: true, toolCount: 1 },
            toolNames: ['mcp_fs_read']
          }
        }
      }),
      controller.signal
    )

    expect(outcome.isError).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledWith('fs')
  })

  // 替换要先断开旧连接；新地址接不上时不能把一台好好的 server 弄没
  it('替换没接上：按原配置把旧的接回去，并说清楚', async () => {
    const restore = vi.fn(async () => true)
    const outcome = await runConnect(
      { id: 'fs', url: '9876', overwrite: true },
      deps({
        existingIds: async () => ['fs'],
        restore,
        connect: async () => {
          throw new Error('fetch failed')
        }
      })
    )

    expect(outcome.isError).toBe(true)
    expect(restore).toHaveBeenCalledWith('fs')
    expect(outcome.text).toContain('重新接回去')
  })

  it('新接一台失败时没有旧的可恢复，不去碰', async () => {
    const restore = vi.fn(async () => true)
    await runConnect(
      { id: 'fs', url: '9876' },
      deps({
        restore,
        connect: async () => {
          throw new Error('fetch failed')
        }
      })
    )

    expect(restore).not.toHaveBeenCalled()
  })

  it('明确 overwrite 才替换', async () => {
    const persist = vi.fn(async () => undefined)
    const outcome = await runConnect(
      { id: 'fs', url: '9876', overwrite: true },
      deps({ existingIds: async () => ['fs'], persist })
    )

    expect(outcome.isError).toBeFalsy()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  // 连是真连上了。谎称失败更糟 —— 用户会去重做一件已经做成的事
  it('写盘失败不当成接入失败，但把「重启后就没了」说清楚', async () => {
    const outcome = await runConnect(
      { id: 'fs', url: '9876' },
      deps({
        persist: async () => {
          throw new Error('EACCES')
        }
      })
    )

    expect(outcome.isError).toBeFalsy()
    expect(outcome.details?.connected).toBe(true)
    expect(outcome.text).toContain('EACCES')
  })

  it('参数不成形时既不连也不写', async () => {
    const connect = vi.fn()
    const persist = vi.fn()
    const outcome = await runConnect({ id: 'bad id', url: '9876' }, deps({ connect, persist }))

    expect(outcome.isError).toBe(true)
    expect(connect).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
})
