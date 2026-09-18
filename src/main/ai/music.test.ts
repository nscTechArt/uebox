/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from './types'
vi.mock('./credentials', () => ({ resolveApiKey: vi.fn(async () => 'test-key') }))
import { generateTaskMusic, musicRequest } from './music'
import { normalizeSettings } from './store'
import { testProvider } from './probe'

const provider: ProviderConfig = {
  id: 'music',
  displayName: 'Music',
  kind: 'music',
  musicApi: 'elevenlabs-music',
  baseUrl: 'https://music.example/v1',
  protocol: 'openai-completions',
  apiKey: { kind: 'none' },
  models: [{ id: 'music_v2' }]
}
const dirs: string[] = []
const suno: ProviderConfig = {
  ...provider,
  musicApi: 'sunoapi-music',
  models: [{ id: 'V6' }]
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'music-test-'))
  dirs.push(dir)
  return dir
}

describe('music providers', () => {
  it('recovers a submitted task from a legacy temporary receipt without another POST', async () => {
    const dir = await directory()
    const musicDir = path.join(dir, 'music')
    await fs.mkdir(musicDir)
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          endpoint: `${suno.baseUrl}/generate`,
          provider: suno.id,
          model: 'V6',
          prompt: 'recover',
          seconds: 30
        })
      )
      .digest('hex')
    const receipt = path.join(musicDir, `${hash}.json`)
    await fs.writeFile(receipt, JSON.stringify({ status: 'submitting' }))
    await fs.writeFile(
      `${receipt}.legacy.tmp`,
      JSON.stringify({
        status: 'submitted',
        taskId: 'orphan',
        providerId: suno.id,
        model: 'V6',
        prompt: 'recover',
        requestedSeconds: 30
      })
    )
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              status: 'SUCCESS',
              response: { sunoData: [{ audio_url: 'https://cdn.example/recovered.mp3' }] }
            }
          })
        )
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 2])))
    vi.stubGlobal('fetch', fetch)
    const result = await generateTaskMusic(suno, 'V6', 'recover', 30, dir)
    expect((await fs.stat(result.path)).size).toBe(4)
    expect(fetch.mock.calls[0][0]).toContain('taskId=orphan')
    expect(fetch.mock.calls.some((args) => args[1]?.method === 'POST')).toBe(false)
  })
  it('round-trips SUNO settings and builds a pure instrumental request', () => {
    const saved = normalizeSettings({
      version: 3,
      providers: [{ ...suno, musicCallbackUrl: 'https://previous.example/callback' }],
      roles: {}
    }).providers[0]
    expect(saved.musicApi).toBe('sunoapi-music')
    expect(saved).not.toHaveProperty('musicCallbackUrl')
    expect(musicRequest(saved, 'V6', 'calm piano', 30)).toEqual({
      endpoint: 'https://music.example/v1/generate',
      body: {
        model: 'V6',
        prompt: 'calm piano',
        customMode: false,
        instrumental: true,
        callBackUrl: 'https://api.example.com/callback'
      }
    })
  })
  it('resumes SUNO polling after an outage and downloads only the completed audio', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { taskId: 'task/123' } }))
      )
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow('offline')
    fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              status: 'SUCCESS',
              response: {
                sunoData: [
                  {
                    audio_url: 'https://cdn.example/complete.mp3',
                    stream_audio_url: 'https://cdn.example/stream'
                  }
                ]
              }
            }
          })
        )
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 2])))
    const result = await generateTaskMusic(suno, 'V6', 'calm', 30, dir)
    expect(await fs.readFile(result.path)).toEqual(Buffer.from([73, 68, 51, 2]))
    expect(fetch.mock.calls[2][0]).toBe(
      'https://music.example/v1/generate/record-info?taskId=task%2F123'
    )
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key')
    expect(JSON.parse(fetch.mock.calls[0][1].body).callBackUrl).toBe(
      'https://api.example.com/callback'
    )
    expect(fetch.mock.calls[3][0]).toBe('https://cdn.example/complete.mp3')
    expect(fetch.mock.calls[3][1].headers).toBeUndefined()
    expect((await generateTaskMusic(suno, 'V6', 'calm', 30, dir)).reused).toBe(true)
    expect(fetch.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1)
  })
  it('handles HTTP-200 business errors without resubmitting', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 429, msg: 'credits' })))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow('429')
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow('可能已收费')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves the provider reason, redacts credentials, and keeps it for a later retry', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 400,
          msg: 'callBackUrl cannot be empty; token=test-key'
        })
      )
    )
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    let message = ''
    try {
      await generateTaskMusic(suno, 'V6', 'calm', 30, dir)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('callBackUrl cannot be empty')
    expect(message).toContain('停止自动重试')
    expect(message).not.toContain('test-key')
    const [receipt] = await fs.readdir(path.join(dir, 'music'))
    const saved = await fs.readFile(path.join(dir, 'music', receipt), 'utf8')
    expect(saved).toContain('callBackUrl cannot be empty')
    expect(saved).not.toContain('test-key')
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow(
      'callBackUrl cannot be empty'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not download a partial SUNO result and cancellation preserves the task for polling', async () => {
    const controller = new AbortController()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { taskId: 'partial' } }))
      )
      .mockImplementationOnce(async () => {
        controller.abort()
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              status: 'FIRST_SUCCESS',
              response: { sunoData: [{ audio_url: 'https://cdn.example/partial.mp3' }] }
            }
          })
        )
      })
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    await expect(
      generateTaskMusic(suno, 'V6', 'calm', 30, dir, controller.signal)
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
    const files = await fs.readdir(path.join(dir, 'music'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'music', files[0]), 'utf8'))).toMatchObject({
      status: 'submitted',
      taskId: 'partial'
    })
  })
  it.each([
    'CREATE_TASK_FAILED',
    'GENERATE_AUDIO_FAILED',
    'CALLBACK_EXCEPTION',
    'SENSITIVE_WORD_ERROR'
  ])('stops on SUNO terminal state %s without another paid submission', async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { taskId: '123' } })))
      .mockImplementation(async () => new Response(JSON.stringify({ code: 200, data: { status } })))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow(status)
    await expect(generateTaskMusic(suno, 'V6', 'calm', 30, dir)).rejects.toThrow(status)
    expect(fetch.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1)
  })
  it('round-trips music configuration and never spends credits for a connection test', async () => {
    const settings = normalizeSettings({
      version: 3,
      providers: [provider],
      roles: { music: { providerId: 'music', modelId: 'music_v2' } }
    })
    expect(settings.providers[0].musicApi).toBe('elevenlabs-music')
    expect(settings.roles.music?.modelId).toBe('music_v2')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await testProvider(provider, 'music_v2')).toEqual({
      ok: true,
      skipped: 'generativeNoCheapCall'
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses official instrumental request formats without invented Mureka duration fields', () => {
    expect(musicRequest(provider, 'music_v2', 'calm', 30).body).toEqual({
      model_id: 'music_v2',
      prompt: 'calm',
      music_length_ms: 30000,
      force_instrumental: true
    })
    expect(
      musicRequest({ ...provider, musicApi: 'mureka-music' }, 'auto', 'calm', 30).body
    ).toEqual({ model: 'auto', prompt: 'calm' })
    expect(() => musicRequest({ ...provider, musicApi: undefined }, 'auto', 'calm', 30)).toThrow(
      '选择'
    )
  })
  it('saves and reuses ElevenLabs audio without resubmitting', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([73, 68, 51, 1])))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    const first = await generateTaskMusic(provider, 'music_v2', 'calm', 30, dir)
    expect((await fs.stat(first.path)).size).toBe(4)
    expect(first.tracks).toEqual([{ path: first.path }])
    expect((await generateTaskMusic(provider, 'music_v2', 'calm', 30, dir)).reused).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('persists Mureka task id before polling and resumes after network failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123' })))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    const mureka = { ...provider, musicApi: 'mureka-music' as const }
    await expect(generateTaskMusic(mureka, 'auto', 'calm', 30, dir)).rejects.toThrow('offline')
    fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'succeeded',
            choices: [{ url: 'https://cdn.example/audio.mp3' }]
          })
        )
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 2])))
    expect((await generateTaskMusic(mureka, 'auto', 'calm', 30, dir)).path).toMatch(/\.mp3$/)
    expect(fetch.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1)
    expect(fetch.mock.calls[3][1].headers).toBeUndefined()
  })
  it.each(['sunoapi-music', 'mureka-music'] as const)(
    'keeps all %s tracks and resumes only a failed download',
    async (musicApi) => {
      const selected = { ...provider, musicApi }
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 200, data: { taskId: 'multi' }, id: 'multi' }))
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: 200,
              data: {
                status: 'SUCCESS',
                response: {
                  sunoData: [
                    { audio_url: 'https://cdn.example/1.mp3', title: 'First' },
                    { audioUrl: 'https://cdn.example/2.mp3', title: 'Second' }
                  ]
                }
              },
              status: 'succeeded',
              choices: [
                { url: 'https://cdn.example/1.mp3', title: 'First' },
                { url: 'https://cdn.example/2.mp3', title: 'Second' }
              ]
            })
          )
        )
        .mockResolvedValueOnce(new Response(new Uint8Array([1])))
        .mockRejectedValueOnce(new Error('download offline'))
      vi.stubGlobal('fetch', fetch)
      const dir = await directory()
      await expect(generateTaskMusic(selected, 'auto', 'calm', 30, dir)).rejects.toThrow(
        'download offline'
      )
      fetch.mockResolvedValueOnce(new Response(new Uint8Array([2])))
      const result = await generateTaskMusic(selected, 'auto', 'calm', 30, dir)
      expect(result.tracks).toHaveLength(2)
      expect(result.path).toBe(result.tracks[0].path)
      expect(result.tracks.map((track) => track.title)).toEqual(['First', 'Second'])
      expect(await fs.readFile(result.tracks[0].path)).toEqual(Buffer.from([1]))
      expect(await fs.readFile(result.tracks[1].path)).toEqual(Buffer.from([2]))
      expect(fetch.mock.calls[4][0]).toBe('https://cdn.example/2.mp3')
      expect(await generateTaskMusic(selected, 'auto', 'calm', 30, dir)).toEqual({
        ...result,
        reused: true
      })
      expect(fetch).toHaveBeenCalledTimes(5)
      expect(fetch.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1)
      // Legacy complete receipt: recover the list by querying, keeping the first local file.
      const receipt = (await fs.readdir(path.join(dir, 'music'))).find((name) =>
        name.endsWith('.json')
      )!
      const receiptPath = path.join(dir, 'music', receipt)
      const saved = JSON.parse(await fs.readFile(receiptPath, 'utf8'))
      delete saved.tracks
      await fs.writeFile(receiptPath, JSON.stringify(saved))
      await fs.unlink(result.tracks[1].path)
      fetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: 200,
              data: {
                status: 'SUCCESS',
                response: {
                  sunoData: [
                    { audio_url: 'https://cdn.example/1.mp3' },
                    { audio_url: 'https://cdn.example/2.mp3' }
                  ]
                }
              },
              status: 'succeeded',
              choices: [{ url: 'https://cdn.example/1.mp3' }, { url: 'https://cdn.example/2.mp3' }]
            })
          )
        )
        .mockResolvedValueOnce(new Response(new Uint8Array([2])))
      expect((await generateTaskMusic(selected, 'auto', 'calm', 30, dir)).tracks).toHaveLength(2)
      expect(fetch.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1)
      expect(fetch).toHaveBeenCalledTimes(7)
    }
  )
  it('does not resubmit an ambiguous paid request', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connection lost'))
    vi.stubGlobal('fetch', fetch)
    const dir = await directory()
    await expect(generateTaskMusic(provider, 'music_v2', 'calm', 30, dir)).rejects.toThrow(
      'connection lost'
    )
    await expect(generateTaskMusic(provider, 'music_v2', 'calm', 30, dir)).rejects.toThrow(
      '可能已收费'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
