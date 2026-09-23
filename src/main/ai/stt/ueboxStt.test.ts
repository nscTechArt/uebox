/** @vitest-environment node */
/**
 * 创作者 Token Plan 的流式识别（协议 06-audio「流式识别」）。起一个本机 WebSocket 服务当对面。
 */
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'

vi.mock('../creatorPlan/planState', () => ({
  readPlanState: async () => ({ unauthorized: false }),
  updatePlanState: async () => undefined
}))

const { openUeboxSttSession, ueboxSttErrorMessage, ueboxSttEvent, ueboxSttUrl } = await import(
  './ueboxStt'
)
const { hasSttAdapter } = await import('./index')
import type { SttEvent } from './types'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** 起服务：握手时交给 onUpgrade 决定放不放行，连上后交给 onSocket */
async function listen(
  onSocket: (
    socket: ServerSocket,
    request: { url?: string; headers: Record<string, unknown> }
  ) => void,
  rejectWith?: number
): Promise<string> {
  const http = createServer()
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    if (rejectWith) {
      socket.end(`HTTP/1.1 ${rejectWith} Nope\r\n\r\n`)
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => onSocket(ws, request))
  })
  server = http
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`
}

function collect(): { events: SttEvent[]; closed: Promise<void>; onEvent: (e: SttEvent) => void } {
  const events: SttEvent[] = []
  let done!: () => void
  const closed = new Promise<void>((resolve) => (done = resolve))
  return {
    events,
    closed,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'closed') done()
    }
  }
}

describe('协议形状', () => {
  it('地址：https → wss，带 model', () => {
    expect(ueboxSttUrl('https://plan.example/v1/', 'uebox-stt')).toBe(
      'wss://plan.example/v1/audio/transcriptions/stream?model=uebox-stt'
    )
  })

  it('事件一一对应：started → ready，partial / final → user-text', () => {
    expect(ueboxSttEvent({ type: 'session.started' })).toEqual({ type: 'ready' })
    expect(ueboxSttEvent({ type: 'transcript.partial', text: '今天' })).toEqual({
      type: 'user-text',
      text: '今天',
      final: false
    })
    expect(ueboxSttEvent({ type: 'transcript.final', text: '今天天气不错。' })).toEqual({
      type: 'user-text',
      text: '今天天气不错。',
      final: true
    })
    expect(ueboxSttEvent({ type: 'transcript.partial', text: '  ' })).toBeNull()
  })

  it('会话里的套餐错误说清下一步', () => {
    expect(ueboxSttErrorMessage({ code: 'quota_exhausted' })).toContain('额度用完了')
    expect(ueboxSttErrorMessage({ code: 'role_not_in_plan' })).toContain('套餐不含')
    expect(ueboxSttErrorMessage({ code: 'content_blocked', message: 'x' })).toBe(
      'content_blocked：x'
    )
  })

  it('套餐来源按来源 id 认，不看域名', () => {
    expect(hasSttAdapter('https://plan.example/v1')).toBe(false)
    expect(hasSttAdapter('https://plan.example/v1', true)).toBe(true)
  })
})

describe('会话', () => {
  it('带 Authorization 头；首帧 session.start（16k PCM）；音频走二进制帧；松手先 commit 再 finish', async () => {
    const received: Array<string | Buffer> = []
    let auth: unknown
    let path: string | undefined
    const base = await listen((socket, request) => {
      auth = request.headers.authorization
      path = request.url
      socket.on('message', (data, isBinary) => {
        received.push(isBinary ? (data as Buffer) : data.toString())
        const text = isBinary ? '' : data.toString()
        if (text.includes('session.start')) {
          socket.send(JSON.stringify({ type: 'session.started', session_id: 'stt_1' }))
        }
        if (text.includes('session.finish')) {
          socket.send(
            JSON.stringify({ type: 'transcript.final', segment_id: 0, text: '打开蓝图。' })
          )
          socket.send(JSON.stringify({ type: 'session.finished', usage: { seconds: 1 } }))
          socket.close()
        }
      })
    })
    const { events, closed, onEvent } = collect()
    const handle = openUeboxSttSession({
      apiKey: 'ubx-sk-t',
      baseUrl: base,
      model: 'uebox-stt',
      onEvent
    })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'ready' }))
    handle.appendAudio(Buffer.from([1, 2, 3, 4]).toString('base64'))
    await vi.waitFor(() => expect(received.some((item) => Buffer.isBuffer(item))).toBe(true))
    handle.flush()
    await closed

    expect(auth).toBe('Bearer ubx-sk-t')
    expect(path).toBe('/v1/audio/transcriptions/stream?model=uebox-stt')
    const texts = received
      .filter((item): item is string => typeof item === 'string')
      .map((t) => JSON.parse(t))
    expect(texts[0]).toMatchObject({
      type: 'session.start',
      audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 }
    })
    expect(texts.map((t) => t.type)).toEqual(['session.start', 'audio.commit', 'session.finish'])
    expect([...(received.find((item) => Buffer.isBuffer(item)) as Buffer)]).toEqual([1, 2, 3, 4])
    // 松手之后的终稿照样送到
    expect(events).toContainEqual({ type: 'user-text', text: '打开蓝图。', final: true })
    expect(events.at(-1)).toEqual({ type: 'closed' })
  })

  it('连上后收到 quota_exhausted：报一句套餐文案、会话结束', async () => {
    const base = await listen((socket) => {
      socket.send(
        JSON.stringify({ type: 'error', error: { code: 'quota_exhausted', message: 'x' } })
      )
      socket.close(1008, 'quota_exhausted')
    })
    const { events, closed, onEvent } = collect()
    openUeboxSttSession({ apiKey: 'k', baseUrl: base, model: 'uebox-stt', onEvent })
    await closed
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('额度用完了')
  })

  it('握手 401：引导重新连接', async () => {
    const base = await listen(() => undefined, 401)
    const { events, closed, onEvent } = collect()
    openUeboxSttSession({ apiKey: 'k', baseUrl: base, model: 'uebox-stt', onEvent })
    await closed
    expect((events[0] as { message: string }).message).toContain('重新连接')
  })
})
