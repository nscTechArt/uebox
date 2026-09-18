import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/common/http', () => ({ default: {} }))

vi.mock('../i18n', () => ({
  default: { global: { t: (key: string) => key } }
}))

import { aiAPI, ChatAbortedError } from './ai'

type ChunkHandler = (payload: { sessionId: string; delta: string }) => void
type DoneHandler = (payload: { sessionId: string; text: string; aborted: boolean }) => void
type ErrorHandler = (payload: { sessionId: string; message: string }) => void

interface Harness {
  chatStream: ReturnType<typeof vi.fn>
  abortStream: ReturnType<typeof vi.fn>
  emitChunk: (delta: string) => void
  emitDone: (text: string, aborted?: boolean) => void
  emitError: (message: string) => void
  listenerCount: () => number
}

/**
 * 装一套假的流式通道。
 *
 * sessionId 是 `chatText` 内部生成的，测试拿不到，所以这里从 `chatStream` 的
 * 入参里把它捞出来 —— 事件按 sessionId 过滤，发错 id 的事件会被忽略。
 */
function install(streamResult: unknown | Promise<unknown> = { success: true }): Harness {
  const chunkHandlers: ChunkHandler[] = []
  const doneHandlers: DoneHandler[] = []
  const errorHandlers: ErrorHandler[] = []
  let sessionId = ''

  const off =
    <T>(list: T[], handler: T) =>
    (): void => {
      const index = list.indexOf(handler)
      if (index !== -1) list.splice(index, 1)
    }

  const chatStream = vi.fn(async (args: { sessionId: string }) => {
    // sessionId 必须在 await 之前抓住：调用方可能拿一个迟迟不落地的 invoke 进来
    sessionId = args.sessionId
    return await streamResult
  })
  const abortStream = vi.fn(async () => ({ success: true }))

  window.api = {
    ai: {
      chatStream,
      abortStream,
      onStreamChunk: (handler: ChunkHandler) => {
        chunkHandlers.push(handler)
        return off(chunkHandlers, handler)
      },
      onStreamDone: (handler: DoneHandler) => {
        doneHandlers.push(handler)
        return off(doneHandlers, handler)
      },
      onStreamError: (handler: ErrorHandler) => {
        errorHandlers.push(handler)
        return off(errorHandlers, handler)
      }
    }
  } as unknown as typeof window.api

  return {
    chatStream,
    abortStream,
    emitChunk: (delta) => chunkHandlers.forEach((h) => h({ sessionId, delta })),
    emitDone: (text, aborted = false) =>
      doneHandlers.forEach((h) => h({ sessionId, text, aborted })),
    emitError: (message) => errorHandlers.forEach((h) => h({ sessionId, message })),
    listenerCount: () => chunkHandlers.length + doneHandlers.length + errorHandlers.length
  }
}

/** 让 chatText 走完「挂监听 + 发起请求」这一步 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('aiAPI.chatText', () => {
  beforeEach(() => vi.clearAllMocks())

  it('把增量攒成全文，并逐段回调', async () => {
    const harness = install()
    const deltas: string[] = []

    const pending = aiAPI.chatText({
      messages: [{ role: 'user', content: '写一份报告' }],
      onDelta: (delta) => deltas.push(delta)
    })
    await settle()

    harness.emitChunk('前半')
    harness.emitChunk('后半')
    harness.emitDone('前半后半')

    await expect(pending).resolves.toBe('前半后半')
    expect(deltas).toEqual(['前半', '后半'])
    // 监听必须摘干净，否则下一次生成会收到上一次的残留事件
    expect(harness.listenerCount()).toBe(0)
  })

  it('中止时抛 ChatAbortedError，而不是把半截文本当成结果', async () => {
    const harness = install()
    const controller = new AbortController()

    const pending = aiAPI.chatText({
      messages: [{ role: 'user', content: '写一份报告' }],
      signal: controller.signal
    })
    await settle()

    harness.emitChunk('写到一半')
    controller.abort()
    harness.emitDone('写到一半', true)

    await expect(pending).rejects.toBeInstanceOf(ChatAbortedError)
    // 真的掐断，而不是只让界面别等了 —— 否则用户的 token 照扣
    expect(harness.abortStream).toHaveBeenCalledTimes(1)
  })

  /**
   * 这里守的是**挂死**，不是错误文案。
   *
   * invoke 本身被拒时不会有任何流事件，之前只挂了 `.then` —— Promise 既不
   * resolve 也不 reject，界面上是一根停在 10% 的进度条，连取消都救不回来。
   */
  it('invoke 本身被拒时立刻抛出，而不是永远挂着', async () => {
    install(Promise.reject(new Error('Blocked invoke channel')))

    await expect(
      aiAPI.chatText({ messages: [{ role: 'user', content: '写一份报告' }] })
    ).rejects.toThrow('Blocked invoke channel')
  })

  /**
   * 主进程是在 chat-stream 的处理函数里才把 controller 记进 activeStreams 的，
   * 抢在这次 invoke 落地之前调 abortStream 会找不到会话、变成空操作 ——
   * 模型照跑完，用户的 token 照扣。
   */
  it('中止赶在 invoke 落地之前时，要等它落地再掐', async () => {
    let landInvoke: () => void = () => undefined
    const dispatched = new Promise<{ success: boolean }>((resolve) => {
      landInvoke = () => resolve({ success: true })
    })
    const harness = install(dispatched)
    const controller = new AbortController()

    const pending = aiAPI.chatText({
      messages: [{ role: 'user', content: '写一份报告' }],
      signal: controller.signal
    })
    await settle()

    controller.abort()
    await settle()
    expect(harness.abortStream).not.toHaveBeenCalled()

    landInvoke()
    await settle()
    expect(harness.abortStream).toHaveBeenCalledTimes(1)

    harness.emitDone('', true)
    await expect(pending).rejects.toBeInstanceOf(ChatAbortedError)
  })

  it('发起阶段就失败（没配模型）时把原因抛出来', async () => {
    install({ success: false, error: '还没有配置可用的 AI 模型' })

    await expect(
      aiAPI.chatText({ messages: [{ role: 'user', content: '写一份报告' }] })
    ).rejects.toThrow('还没有配置可用的 AI 模型')
  })

  it('生成中途出错时抛出主进程给的原因', async () => {
    const harness = install()

    const pending = aiAPI.chatText({ messages: [{ role: 'user', content: '写一份报告' }] })
    await settle()
    harness.emitError('上游返回 429')

    await expect(pending).rejects.toThrow('上游返回 429')
  })

  it('结构化输出的诉求要传到主进程', async () => {
    const harness = install()

    const pending = aiAPI.chatText({
      messages: [{ role: 'user', content: '出题' }],
      responseFormat: { type: 'json_object' }
    })
    await settle()
    harness.emitDone('{}')
    await pending

    expect(harness.chatStream.mock.calls[0][0]).toMatchObject({
      responseFormat: { type: 'json_object' }
    })
  })
})
