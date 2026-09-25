/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  buildCrashNotice,
  expectEditorClose,
  watchEditorCrashes,
  type EditorWatchDeps,
  type EditorWatchEvent
} from './editorWatch'

/**
 * 看护要答对的是一件事：这次断开要不要重开编辑器。
 * 重开错了（人家自己关的、卡住了其实还活着、不是这一局的工程）比不重开更糟 ——
 * 那是替用户多开一个他没要的编辑器。
 */

type Handler = (payload: unknown, connectionId?: string) => void

interface Harness {
  events: EditorWatchEvent[]
  reopened: string[]
  handlers: Map<string, Handler>
  stop: () => void
  fire: (method: string, payload: unknown, id?: string) => Promise<void>
  setRunning: (value: boolean) => void
}

function harness(over: Partial<EditorWatchDeps> = {}): Harness {
  const handlers = new Map<string, Handler>()
  const events: EditorWatchEvent[] = []
  const reopened: string[] = []
  let running = false
  const deps: EditorWatchDeps = {
    onEvent: (method, callback) => {
      handlers.set(method, callback)
      return () => handlers.delete(method)
    },
    connectedProjects: () => [{ connectionId: 'c1', projectPath: 'I:/Game' }],
    findUproject: async (dir) => `${dir}/Game.uproject`,
    isRunning: async () => running,
    reopen: async (uproject) => void reopened.push(uproject),
    waitLive: async () => true,
    crashReason: async () => 'Access violation',
    isOurs: (dir) => dir === 'I:/Game',
    sleep: async () => undefined,
    ...over
  }
  const stop = watchEditorCrashes(deps, { onEvent: (e) => events.push(e) })
  const fire = async (method: string, payload: unknown, id?: string): Promise<void> => {
    handlers.get(method)?.(payload, id)
    // 让 handleDisconnect 里那串 await 跑完
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return {
    events,
    reopened,
    handlers,
    stop,
    fire,
    setRunning: (value: boolean) => {
      running = value
    }
  }
}

describe('编辑器看护', () => {
  it('没打招呼就断了、进程也没了：算崩溃，重开并等它连回来', async () => {
    const h = harness()
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.reopened).toEqual(['I:/Game/Game.uproject'])
    expect(h.events.map((e) => e.kind)).toEqual(['crashed', 'recovered'])
    expect(h.events[0]).toMatchObject({ reason: 'Access violation' })
  })

  it('插件先说了 project.closed 再断：是人关的，不重开', async () => {
    const h = harness()
    await h.fire('project.closed', {}, 'c1')
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.reopened).toEqual([])
    expect(h.events).toEqual([])
  })

  it('断了但进程还在：卡住或网络抖动，插件自己会连回来，不再开一个', async () => {
    const h = harness()
    h.setRunning(true)
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.reopened).toEqual([])
  })

  it('不是这一局的工程：不管', async () => {
    const h = harness({ isOurs: () => false })
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.reopened).toEqual([])
  })

  it('开跑之后才连上的工程，从 project.info 里记下来', async () => {
    const h = harness({ connectedProjects: () => [] })
    await h.fire('project.info', { projectPath: 'I:/Game' }, 'c2')
    await h.fire('system.disconnected', {}, 'c2')
    expect(h.reopened).toHaveLength(1)
  })

  it('反复崩：一小时内第四次就不再重开，交给人', async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      await h.fire('project.info', { projectPath: 'I:/Game' }, `c${i + 10}`)
      await h.fire('system.disconnected', {}, `c${i + 10}`)
    }
    expect(h.reopened).toHaveLength(3)
    expect(h.events.at(-1)).toMatchObject({ kind: 'gave-up' })
  })

  it('重开了但插件没连回来：报「没恢复」', async () => {
    const h = harness({ waitLive: async () => false })
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.events.map((e) => e.kind)).toEqual(['crashed', 'gave-up'])
  })

  it('盒子自己关的（回滚快照）：事先登记过，就不当崩溃', async () => {
    const h = harness()
    expectEditorClose('I:/Game')
    await h.fire('system.disconnected', {}, 'c1')
    expect(h.reopened).toEqual([])
    expect(h.events).toEqual([])
  })

  it('停了就退订', () => {
    const h = harness()
    h.stop()
    expect(h.handlers.size).toBe(0)
  })

  it('告诉制作人的话说清楚不是用户在说话、丢了什么', () => {
    const text = buildCrashNotice({ kind: 'crashed', projectDir: 'I:/Game', reason: 'boom' })
    expect(text).toMatch(/This is not the user speaking/)
    expect(text).toMatch(/Unsaved editor changes since the last save are lost/)
  })
})
