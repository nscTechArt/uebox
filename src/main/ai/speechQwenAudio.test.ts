/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSpeech } from './speech'
import type { ProviderConfig } from './types'

type Socket = EventEmitter & {
  sent: string[]
  terminate: ReturnType<typeof vi.fn>
  url: string
  options: { headers: Record<string, string> }
}
const sockets = vi.hoisted(() => [] as Socket[])
vi.mock('./credentials', () => ({ resolveApiKey: vi.fn(async () => 'test-key') }))
vi.mock('./store', () => ({ readSettings: vi.fn() }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: class extends EventEmitter {
      sent: string[] = []
      terminate = vi.fn()
      constructor(
        readonly url: string,
        readonly options: { headers: Record<string, string> }
      ) {
        super()
        sockets.push(this)
      }
      send(data: string, callback: (error?: Error) => void): void {
        this.sent.push(data)
        callback()
      }
    }
  }
})
const provider: ProviderConfig = {
  id: 'ali',
  kind: 'tts',
  displayName: 'Ali',
  protocol: 'openai-completions',
  baseUrl: 'wss://speech.example/inference',
  apiKey: { kind: 'none' },
  models: []
}
async function start(modelId = 'qwen-audio-3.0-tts-plus'): Promise<{
  socket: Socket
  run: Promise<void>
  controller: AbortController
  onAudio: ReturnType<typeof vi.fn>
  taskId: string
}> {
  const controller = new AbortController()
  const onAudio = vi.fn()
  const run = requestSpeech(provider, modelId, '你好', controller.signal, onAudio)
  await Promise.resolve()
  const socket = sockets.at(-1)!
  socket.emit('open')
  const taskId = JSON.parse(socket.sent[0]).header.task_id as string
  return { socket, run, controller, onAudio, taskId }
}
function event(socket: Socket, taskId: string, name: string): void {
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ header: { task_id: taskId, event: name } })),
    false
  )
}
afterEach(() => {
  sockets.length = 0
  vi.clearAllMocks()
})
describe('Qwen-Audio WebSocket speech', () => {
  it.each([
    ['qwen-audio-3.0-tts-plus', 'longanlingxin'],
    ['qwen-audio-3.0-tts-flash', 'longanfengyue']
  ])(
    'streams %s after task-started using the correct voice and a single task ID',
    async (model, voice) => {
      const { socket, run, taskId, onAudio } = await start(model)
      expect(socket.url).toBe(provider.baseUrl)
      expect(socket.options.headers.Authorization).toBe('Bearer test-key')
      expect(JSON.parse(socket.sent[0]).payload).toMatchObject({
        model,
        parameters: { voice, format: 'pcm', sample_rate: 24000 }
      })
      expect(socket.sent).toHaveLength(1)
      event(socket, 'other-task', 'task-started')
      expect(socket.sent).toHaveLength(1)
      event(socket, taskId, 'task-started')
      expect(socket.sent.map((data) => JSON.parse(data).header)).toEqual(
        ['run-task', 'continue-task', 'finish-task'].map((action) => ({
          action,
          task_id: taskId,
          streaming: 'duplex'
        }))
      )
      expect(JSON.parse(socket.sent[1]).payload.input.text).toBe('你好')
      let done = false
      void run.then(() => {
        done = true
      })
      socket.emit('message', Buffer.from([0, 0, 0, 0]), true)
      expect(onAudio).toHaveBeenCalledExactlyOnceWith({
        base64: 'AAAAAA==',
        format: 'pcm_s16le',
        sampleRate: 24000
      })
      expect(done).toBe(false)
      event(socket, taskId, 'task-finished')
      await run
      expect(socket.terminate).toHaveBeenCalled()
      expect(socket.listenerCount('message')).toBe(0)
    }
  )
  it('cancels and ignores late binary audio', async () => {
    const { socket, controller, onAudio, run } = await start()
    controller.abort()
    await expect(run).rejects.toThrow('TTS_CANCELLED')
    socket.emit('message', Buffer.from([0, 0]), true)
    expect(onAudio).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalled()
  })
  it.each(['task-failed', 'task-finished', 'close'])(
    'rejects %s without complete audio and cleans up',
    async (name) => {
      const { socket, run, taskId } = await start()
      if (name === 'close') socket.emit('close')
      else event(socket, taskId, name)
      await expect(run).rejects.toThrow(/^TTS_/)
      expect(socket.listenerCount('message')).toBe(0)
      expect(socket.terminate).toHaveBeenCalled()
    }
  )
  it('does not open a connection for already cancelled input', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      requestSpeech(provider, 'qwen-audio-3.0-tts-plus', '你好', controller.signal)
    ).rejects.toThrow()
    expect(sockets).toHaveLength(0)
  })
})
