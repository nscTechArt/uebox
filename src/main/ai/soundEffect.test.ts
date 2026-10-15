/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from './types'
vi.mock('./credentials', () => ({ resolveApiKey: vi.fn(async () => 'test-key') }))
import { generateSoundEffect, soundEffectRequest } from './soundEffect'

const provider: ProviderConfig = {
  id: 'elevenlabs-sfx',
  displayName: 'ElevenLabs 音效',
  kind: 'sfx',
  baseUrl: 'https://sfx.example/v1/',
  protocol: 'openai-completions',
  apiKey: { kind: 'literal', id: 'k' },
  models: [{ id: 'eleven_text_to_sound_v2' }]
}
const request = { prompt: 'footstep on wood', loop: false }
const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'sfx-test-'))
  dirs.push(dir)
  return dir
}
function pcm(samples: number): Response {
  return new Response(new Uint8Array(samples * 2))
}

describe('sound effects', () => {
  it('asks for PCM and only sends duration when given', () => {
    const auto = soundEffectRequest(provider, 'm', request, 44100)
    expect(auto.endpoint).toBe('https://sfx.example/v1/sound-generation?output_format=pcm_44100')
    expect(auto.body).toEqual({ text: 'footstep on wood', model_id: 'm', loop: false })
    expect(soundEffectRequest(provider, 'm', { ...request, seconds: 2 }, 22050).body).toMatchObject(
      {
        duration_seconds: 2
      }
    )
  })

  it('writes a WAV with the real sample rate and reuses it without another request', async () => {
    const dir = await directory()
    const fetchMock = vi.fn(async () => pcm(44100))
    vi.stubGlobal('fetch', fetchMock)
    const first = await generateSoundEffect(provider, 'm', request, 0, dir)
    expect(first).toMatchObject({ seconds: 1, reused: false })
    const wav = await fs.readFile(first.path)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(44100)
    const again = await generateSoundEffect(provider, 'm', request, 0, dir)
    expect(again).toEqual({ path: first.path, seconds: 1, reused: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives each variant its own file', async () => {
    const dir = await directory()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pcm(100))
    )
    const a = await generateSoundEffect(provider, 'm', request, 0, dir)
    const b = await generateSoundEffect(provider, 'm', request, 1, dir)
    expect(a.path).not.toBe(b.path)
  })

  it('falls back to 22.05 kHz when the account tier rejects 44.1 kHz', async () => {
    const dir = await directory()
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('pcm_44100') ? new Response('tier', { status: 403 }) : pcm(22050)
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateSoundEffect(provider, 'm', request, 0, dir)
    expect(result.seconds).toBe(1)
    expect((await fs.readFile(result.path)).readUInt32LE(24)).toBe(22050)
  })

  it('clears the receipt when every format is rejected so a fixed request can retry', async () => {
    const dir = await directory()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad test-key', { status: 422 }))
    )
    const error = await generateSoundEffect(provider, 'm', request, 0, dir).catch((e) => e)
    expect(String(error)).toContain('HTTP 422')
    expect(String(error)).not.toContain('test-key')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('refuses to resubmit after an unconfirmed attempt', async () => {
    const dir = await directory()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up')
      })
    )
    await expect(generateSoundEffect(provider, 'm', request, 0, dir)).rejects.toThrow('socket')
    const fetchMock = vi.fn(async () => pcm(10))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateSoundEffect(provider, 'm', request, 0, dir)).rejects.toThrow('未确认')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
