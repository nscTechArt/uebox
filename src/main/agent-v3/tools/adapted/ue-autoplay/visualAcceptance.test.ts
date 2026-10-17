// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import type { JudgeResult } from '../../../../ai/judge'
import { acceptAutoplayVisually, summarizeVisualAcceptance } from './visualAcceptance'

let dir: string
let source: string
let runId = 0
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'autoplay-visual-'))
  source = join(dir, 'source.png')
  await sharp({ create: { width: 400, height: 400, channels: 3, background: 'red' } })
    .png()
    .toFile(source)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function answer(choice = 'met', confidence = 0.99): JudgeResult {
  return {
    model: 'jev-1.14.0',
    answers: {
      visible: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { [choice]: confidence }
      }
    }
  }
}
function options(): Parameters<typeof acceptAutoplayVisually>[0] & {
  ask: ReturnType<typeof vi.fn>
} {
  return {
    checks: [
      { id: 'key', description: 'HUD 显示钥匙' },
      { id: 'win', description: '通关面板显示' }
    ],
    report: {
      ok: true,
      frame_mode: 'window',
      frames: [
        { at: 1, path: source },
        { at: 3, path: source }
      ]
    },
    outputDir: join(dir, `run-${runId++}`),
    model: 'jev-1.14.0',
    ask: vi.fn().mockResolvedValue(answer())
  }
}

describe('visual autoplay acceptance', () => {
  it('persists ordered evidence, a readable report, timeline and real animated replay', async () => {
    const opts = options()
    const result = await acceptAutoplayVisually(opts)
    expect(result.status).toBe('passed')
    expect(result.checks.map((check) => check.at)).toEqual([1, 3])
    expect(opts.ask.mock.calls.map((call) => call[0].visible_condition)).toEqual([
      'HUD 显示钥匙',
      '通关面板显示'
    ])
    const request = opts.ask.mock.calls[0]
    expect(request[2].assets[request[0].image].format).toBe('jpeg')
    expect(
      await sharp(Buffer.from(request[2].assets[request[0].image].data_base64, 'base64')).metadata()
    ).toMatchObject({ width: 1280, height: 720 })
    expect(result.image_paths).toHaveLength(1)
    expect(await sharp(result.replay_path!).metadata()).toMatchObject({ pages: 2, loop: 0 })
    expect(JSON.parse(await readFile(result.report_path, 'utf8')).checks).toEqual(result.checks)
    expect(summarizeVisualAcceptance(result)).toMatch(/^视觉验收通过：2\/2/)
  })

  it('does not turn a later success or duplicate timestamp into proof of earlier steps', async () => {
    const opts = options()
    opts.report.frames = [
      { at: 2, path: source },
      { at: 1, path: source },
      { at: 2, path: source }
    ]
    opts.ask.mockResolvedValueOnce(answer('not_met')).mockResolvedValue(answer())
    const result = await acceptAutoplayVisually(opts)
    expect(result.status).toBe('not_passed')
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'not_observed'])
    expect(opts.ask).toHaveBeenCalledTimes(2)
    expect(summarizeVisualAcceptance(result)).toMatch(/^视觉验收未通过：1\/2/)
  })

  it.each(['unreadable', 'low_confidence', 'low_probability', 'null', 'throws'])(
    'keeps %s inconclusive and retains evidence',
    async (mode) => {
      const opts = options()
      if (mode === 'throws') opts.ask.mockRejectedValue(new Error('HTTP 429'))
      else if (mode === 'null') opts.ask.mockResolvedValue(null)
      else if (mode === 'low_probability')
        opts.ask.mockResolvedValue({
          model: 'jev',
          answers: {
            visible: {
              type: 'choice',
              choice: 'met',
              confidence: 0.99,
              probabilities: { met: 0.6 }
            }
          }
        })
      else
        opts.ask.mockResolvedValue(
          answer(
            mode === 'unreadable' ? 'unreadable' : 'met',
            mode === 'low_confidence' ? 0.6 : 0.99
          )
        )
      const result = await acceptAutoplayVisually(opts)
      expect(result.status).not.toBe('passed')
      expect(result.checks.every((check) => check.status === 'not_observed')).toBe(true)
      expect(result.frames.every((frame) => frame.path)).toBe(true)
      if (mode === 'throws') expect(result.frames[0].error).toBe('HTTP 429')
    }
  )

  it('never judges old scene-only captures as HUD evidence; accepts an explicit final window frame', async () => {
    const opts = options()
    opts.report.frame_mode = 'scene'
    const result = await acceptAutoplayVisually({ ...opts, finalFrame: { at: 4, path: source } })
    expect(opts.ask).toHaveBeenCalledTimes(1)
    expect(result.checks[0].at).toBe(4)
    expect(result.status).toBe('not_passed')
    expect(result.warnings.join()).toContain('更新插件')
  })

  it('missing/corrupt frames cannot pass and a subsequent retry can', async () => {
    const opts = options()
    const failed = await acceptAutoplayVisually({
      ...opts,
      report: {
        ok: true,
        frame_mode: 'window',
        frames: [
          { at: 0, error: 'minimized' },
          { at: 1, path: join(dir, 'missing.png') }
        ]
      }
    })
    expect(failed.status).toBe('inconclusive')
    expect(opts.ask).not.toHaveBeenCalled()
    expect(failed.frames.every((frame) => frame.error)).toBe(true)
    expect((await acceptAutoplayVisually(options())).status).toBe('passed')
  })

  it('runtime failure or a missing required log blocks otherwise passing visual checks', async () => {
    const opts = options()
    const result = await acceptAutoplayVisually({
      ...opts,
      report: { ...opts.report, ok: false, error: 'session failed', errors: ['Accessed None'] },
      requiredLog: 'DoorOpened'
    })
    expect(result.checks.every((check) => check.status === 'passed')).toBe(true)
    expect(result.status).toBe('not_passed')
    expect(result.blockers).toHaveLength(3)
    expect(summarizeVisualAcceptance(result)).toMatch(/^视觉验收未通过/)
  })

  it('cancellation never submits more images or reports acceptance', async () => {
    const opts = options()
    const abort = new AbortController()
    abort.abort()
    const result = await acceptAutoplayVisually({ ...opts, signal: abort.signal })
    expect(opts.ask).not.toHaveBeenCalled()
    expect(result.status).toBe('not_passed')
    expect(result.blockers).toContain('用户已取消；未完成验收')
  })
})
