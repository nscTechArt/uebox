/** @vitest-environment node */
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../ffmpegPath', () => ({ findFFmpeg: vi.fn(async () => null) }))
vi.mock('../../ai/store', () => ({ readSettings: vi.fn() }))
vi.mock('../../ai/speech', () => ({ requestSpeech: vi.fn() }))
import { runVideoProcess, videoPreflight } from './render'
import { readSettings } from '../../ai/store'

describe('task video execution', () => {
  it('fails preflight before accessing paid model settings', async () => {
    await expect(videoPreflight()).rejects.toThrow('FFmpeg')
    expect(readSettings).not.toHaveBeenCalled()
  })
  it('collects real subprocess output and reports nonzero exit', async () => {
    expect(
      await runVideoProcess(process.execPath, ['-e', 'process.stdout.write("complete")'], tmpdir())
    ).toBe('complete')
    await expect(
      runVideoProcess(
        process.execPath,
        ['-e', 'process.stderr.write("bad input");process.exit(2)'],
        tmpdir()
      )
    ).rejects.toThrow('bad input')
  })
  it('stops an active process when the user cancels', async () => {
    const controller = new AbortController()
    const running = runVideoProcess(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      tmpdir(),
      controller.signal
    )
    controller.abort()
    await expect(running).rejects.toThrow()
  })
})
