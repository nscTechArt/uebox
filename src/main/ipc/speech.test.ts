/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSpeechIPC } from './speech'
import { synthesizeSpeech } from '../ai/speech'
import type { SpeechRequest, SpeechResult } from '../../shared/speech'

type Handler = (
  event: { sender: EventEmitter & { id: number } },
  request: SpeechRequest | string
) => Promise<SpeechResult> | void

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) => handlers.set(name, handler)
  }
}))
vi.mock('../ai/speech', () => ({ synthesizeSpeech: vi.fn() }))
const sender = (
  id: number
): EventEmitter & { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } =>
  Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: () => false })
beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerSpeechIPC()
})

describe('朗读取消请求', () => {
  it('forwards early audio to its owner and suppresses late audio after cancellation', async () => {
    const owner = sender(1)
    let deliver!: () => void
    let finish!: () => void
    const chunk = { base64: 'AAAAAA==', format: 'pcm_s16le' as const, sampleRate: 24000 as const }
    vi.mocked(synthesizeSpeech).mockImplementation(async (_text, _signal, onAudio) => {
      deliver = () => onAudio(chunk)
      deliver()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const run = handlers.get('speech:synthesize')!(
      { sender: owner },
      { requestId: 'a', text: '正文' }
    )
    expect(owner.send).toHaveBeenCalledWith('speech:chunk', { requestId: 'a', ...chunk })
    handlers.get('speech:cancel')!({ sender: owner }, 'a')
    deliver()
    expect(owner.send).toHaveBeenCalledTimes(1)
    finish()
    await run
  })
  it('only the owning window and request can cancel synthesis, then listeners are cleaned up', async () => {
    const owner = sender(1)
    let signal!: AbortSignal
    vi.mocked(synthesizeSpeech).mockImplementation((_text, current) => {
      signal = current
      return new Promise((_resolve, reject) =>
        current.addEventListener('abort', () => reject(new Error('cancelled')))
      )
    })
    const run = handlers.get('speech:synthesize')!(
      { sender: owner },
      { requestId: 'a', text: '正文' }
    )
    handlers.get('speech:cancel')!({ sender: sender(2) }, 'a')
    handlers.get('speech:cancel')!({ sender: owner }, 'b')
    expect(signal.aborted).toBe(false)
    handlers.get('speech:cancel')!({ sender: owner }, 'a')
    expect(signal.aborted).toBe(true)
    await run
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })

  it('aborts requests when the renderer reloads and never exposes raw errors', async () => {
    const owner = sender(1)
    vi.mocked(synthesizeSpeech).mockImplementation(
      (_text, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('private provider details')))
        )
    )
    const run = handlers.get('speech:synthesize')!(
      { sender: owner },
      { requestId: 'a', text: '正文' }
    )
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(await run).toEqual({ success: false, error: 'TTS_FAILED' })
  })

  /**
   * 渲染进程是 hash 路由：切一次标签页 = 一次主框架的同文档导航。念到一半的话
   * 不能因为用户去看了眼素材库就被掐掉（真机上表现为「朗读失败」的红条）。
   * 子框架（比如预览用的 iframe）加载同理。
   */
  it('keeps synthesizing across tab switches and subframe loads', async () => {
    const owner = sender(1)
    let signal!: AbortSignal
    vi.mocked(synthesizeSpeech).mockImplementation((_text, current) => {
      signal = current
      return new Promise(() => {})
    })
    void handlers.get('speech:synthesize')!({ sender: owner }, { requestId: 'a', text: '正文' })
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(signal.aborted).toBe(false)
  })
})
