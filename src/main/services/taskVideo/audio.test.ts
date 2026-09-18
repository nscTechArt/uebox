/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../../ai/store', () => ({
  readSettings: vi.fn(async () => ({
    roles: { tts: { providerId: 'voice', modelId: 'model' } },
    providers: [
      {
        id: 'voice',
        kind: 'tts',
        baseUrl: 'https://fixture.invalid',
        models: [{ id: 'model', ttsVoice: 'test' }]
      }
    ]
  }))
}))
vi.mock('../../ai/speech', () => ({
  requestSpeech: vi.fn(async (_p, _m, _t, _s, onAudio) =>
    onAudio({ base64: Buffer.alloc(5 * 48000).toString('base64') })
  )
}))
import { requestSpeech } from '../../ai/speech'
import { prepareVideoAudio } from './audio'
import { VideoStoryboard } from './schema'
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
it('locks actual narration duration before animation and reuses it when only visuals change', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'art-audio-'))
  dirs.push(dir)
  const board = VideoStoryboard.parse({
    title: 'art',
    mode: 'promo',
    scenes: [
      {
        id: 'one',
        kind: 'text',
        sourceNote: 'test',
        title: 'first',
        caption: '',
        narration: 'voice',
        duration: 2
      }
    ]
  })
  const first = await prepareVideoAudio(dir, board)
  expect(first.storyboard.scenes[0].duration).toBeCloseTo(5.3666667)
  expect(first.voiceUsed).toBe(true)
  const second = await prepareVideoAudio(dir, {
    ...first.storyboard,
    scenes: [
      {
        ...first.storyboard.scenes[0],
        kind: 'composition',
        source: 'C:/art.html',
        title: 'revised'
      }
    ]
  })
  expect(second.audio).toEqual(first.audio)
  expect(requestSpeech).toHaveBeenCalledTimes(1)
})

it('keeps authored composition timing when unvoiced metadata is not shown on screen', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'art-timing-'))
  dirs.push(dir)
  const board = VideoStoryboard.parse({
    title: 'art',
    mode: 'promo',
    voice: 'off',
    scenes: [
      {
        id: 'one',
        kind: 'composition',
        source: 'C:/art.html',
        sourceNote: 'test',
        title: 'metadata',
        caption: 'x'.repeat(180),
        duration: 4
      }
    ]
  })
  const result = await prepareVideoAudio(dir, board)
  expect(result.storyboard.scenes[0].duration).toBe(4)
  expect(requestSpeech).not.toHaveBeenCalled()
})
