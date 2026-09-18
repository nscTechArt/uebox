import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { SpeechAudio } from '../../shared/speech'
import type { ProviderConfig } from './types'

/** https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api */
export function requestQwenAudioSpeech(
  provider: ProviderConfig,
  modelId: string,
  voice: string,
  text: string,
  key: string,
  signal: AbortSignal,
  onAudio: (chunk: SpeechAudio) => void
): Promise<void> {
  signal.throwIfAborted()
  if (!provider.baseUrl.startsWith('wss://')) throw new Error('TTS_INVALID_ENDPOINT')
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(provider.baseUrl, {
      headers: { ...provider.headers, Authorization: `Bearer ${key}` },
      handshakeTimeout: 15_000,
      maxPayload: 20 * 1024 * 1024
    })
    const taskId = randomUUID()
    let settled = false
    let started = false
    let size = 0
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.removeAllListeners()
      // terminate() can emit an asynchronous error when cancelled during the handshake.
      socket.on('error', () => {})
      socket.terminate()
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => finish(new Error('TTS_CANCELLED'))
    const timer = setTimeout(() => finish(new Error('TTS_TIMEOUT')), 90_000)
    const send = (action: string, payload: Record<string, unknown>): void => {
      socket.send(
        JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }),
        (error) => {
          if (error) finish(new Error('TTS_CONNECTION_FAILED'))
        }
      )
    }
    socket.on('error', () => finish(new Error('TTS_CONNECTION_FAILED')))
    socket.on('close', () => finish(new Error('TTS_INCOMPLETE_AUDIO')))
    socket.on('open', () => {
      if (settled) return
      send('run-task', {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: modelId,
        parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: 24000 },
        input: {}
      })
    })
    socket.on('message', (data, isBinary) => {
      if (settled) return
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        if (isBinary) {
          if (!started) throw new Error('TTS_INVALID_AUDIO')
          size += bytes.length
          if (size > 20 * 1024 * 1024) throw new Error('TTS_AUDIO_TOO_LARGE')
          if (bytes.length)
            onAudio({ base64: bytes.toString('base64'), format: 'pcm_s16le', sampleRate: 24000 })
          return
        }
        const event = JSON.parse(bytes.toString('utf8')) as {
          header?: { task_id?: string; event?: string }
        }
        if (event.header?.task_id !== taskId) return
        switch (event.header.event) {
          case 'task-started':
            if (started) return
            started = true
            send('continue-task', { input: { text } })
            send('finish-task', { input: {} })
            break
          case 'task-finished':
            finish(size ? undefined : new Error('TTS_EMPTY_AUDIO'))
            break
          case 'task-failed':
            finish(new Error('TTS_PROVIDER_FAILED'))
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('TTS_FAILED'))
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
