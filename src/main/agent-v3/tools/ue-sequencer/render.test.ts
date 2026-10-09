/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn(),
  callUeRaw: vi.fn()
}))
vi.mock('../../../services/ffmpegPath', () => ({ findFFmpeg: vi.fn() }))
vi.mock('./composeVideo', () => ({ composeVideo: vi.fn() }))

import { findFFmpeg } from '../../../services/ffmpegPath'
import { callUe, callUeRaw } from '../defineUeTool'
import { composeVideo } from './composeVideo'
import {
  createSequenceRenderTool,
  formatProgress,
  formatResult,
  type RenderStartOutput,
  type RenderStatusOutput
} from './render'

const mockUe = vi.mocked(callUe)
const mockRaw = vi.mocked(callUeRaw)
const mockFfmpeg = vi.mocked(findFFmpeg)
const mockCompose = vi.mocked(composeVideo)
const tool = createSequenceRenderTool()

const JOB: RenderStartOutput = {
  job_id: 'job-1',
  sequence_path: '/Game/Cine/SQ_Intro',
  map_path: '/Game/Maps/Showroom',
  output_dir: 'D:/Proj/Saved/MovieRenders/SQ_Intro/20261006_120000',
  format: 'png',
  resolution: [1920, 1080],
  renderer: 'lumen',
  quality: 'standard',
  frame_range: [0, 120]
}

const status = (over: Partial<RenderStatusOutput> = {}): RenderStatusOutput => ({
  job_id: 'job-1',
  state: 'rendering',
  progress: 0.25,
  output_frame: 30,
  total_frames: 120,
  elapsed_seconds: 60,
  output_dir: JOB.output_dir,
  ...over
})

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('')

beforeEach(() => {
  vi.useFakeTimers()
  mockUe.mockReset()
  mockRaw.mockReset()
  mockFfmpeg.mockReset()
  mockCompose.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 跑一次工具，把轮询用的假时钟一路拨到底 */
async function run(
  args: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; onUpdate?: (p: unknown) => void } = {}
): Promise<unknown> {
  const p = tool.execute(
    'c1',
    { sequence_path: '/Game/Cine/SQ_Intro', ...args },
    opts.signal,
    opts.onUpdate as never
  )
  // 吞掉中途的 rejection，交给调用方 await 时再看
  p.catch(() => undefined)
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(2_000)
  return p
}

describe('元数据', () => {
  it('每一次渲染都要用户当场批准，「本对话内都允许」放不过', () => {
    expect(tool.unrealBox.requiresExplicitApproval).toBe(true)
    expect(tool.unrealBox.namespace).toBe('ue.sequencer')
  })

  it('描述里写清这是引擎渲染、调之前先体检', () => {
    expect(tool.description).toContain('不是 AI 生图')
    expect(tool.description).toContain('sequence_audit')
  })
})

describe('发给引擎的载荷', () => {
  it('没填的字段一个都不发，交给插件按自己的默认值处理（给了预设时以预设为准）', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    await run({ resolution: [3840, 2160] })
    const [method, payload] = mockUe.mock.calls[0]!
    expect(method).toBe('sequence.render')
    expect(payload).toEqual({
      sequence_path: '/Game/Cine/SQ_Intro',
      resolution: [3840, 2160]
    })
  })

  it('轮询带着开始时拿到的 job_id', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    await run()
    expect(mockUe.mock.calls[1]).toEqual([
      'sequence.render_status',
      { job_id: 'job-1' },
      { timeoutMs: 15_000 }
    ])
  })
})

describe('回执跟着引擎走', () => {
  it('渲完报引擎扫盘数出的文件数和输出目录', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(
        status({ state: 'finished', progress: 1, files_written: 120, elapsed_seconds: 200 })
      )
    const text = textOf(await run())
    expect(text).toContain('渲染完成')
    expect(text).toContain('共 120 帧')
    expect(text).toContain(JOB.output_dir)
  })

  it('文件数和帧范围对不上时照实说，不说「共 N 帧」', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 97 }))
    const text = textOf(await run())
    expect(text).toContain('有 97 个文件')
    expect(text).toContain('应为 120 帧')
    expect(text).not.toContain('共 97 帧')
  })

  it('引擎回的分辨率和入参不同时，回执写引擎的', async () => {
    mockUe
      .mockResolvedValueOnce({ ...JOB, resolution: [1280, 720] })
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    const text = textOf(await run({ resolution: [3840, 2160] }))
    expect(text).toContain('1280×720')
    expect(text).not.toContain('3840')
  })

  it('渲染失败按错误交给模型，带上引擎给的原因', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'failed', error: '序列没有相机切轨' }))
    await expect(run()).rejects.toThrow(/渲染失败[\s\S]*序列没有相机切轨/)
  })

  it('MRQ 没启用时报错里直接带上启用插件的下一步', async () => {
    mockUe.mockRejectedValueOnce(
      new Error(
        'sequence.render 失败：项目没有启用 Movie Render Queue 插件（MovieRenderPipeline）。启用后要重启编辑器（错误码 412）'
      )
    )
    await expect(run()).rejects.toThrow(/enable_plugins[\s\S]*MovieRenderPipeline/)
  })

  it('一直查不到进度就判编辑器没了，而不是永远转圈', async () => {
    mockUe.mockResolvedValueOnce(JOB)
    mockUe.mockRejectedValue(new Error('timeout'))
    await expect(run()).rejects.toThrow(/编辑器可能卡死或崩溃/)
  })

  it('偶尔一次查不到不算失败', async () => {
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    expect(textOf(await run())).toContain('渲染完成')
  })
})

describe('进度', () => {
  it('渲染中经 report 推给界面', async () => {
    const updates: string[] = []
    mockUe
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    await run({}, { onUpdate: (p) => updates.push(textOf(p)) })
    expect(updates.some((u) => u.includes('已开始渲染'))).toBe(true)
    expect(updates.some((u) => u.includes('渲染中 25%（第 30/120 帧）'))).toBe(true)
  })

  it('还没出帧时不报 0%，说在准备', () => {
    expect(formatProgress(status({ total_frames: 0, output_frame: 0, progress: 0 }))).toContain(
      '准备中'
    )
  })

  it('有剩余时间估计就带上', () => {
    expect(formatProgress(status({ eta_seconds: 200 }))).toContain('预计还要 3 分 20 秒')
  })
})

describe('停止 = 取消', () => {
  it('用户按停止时向引擎发取消', async () => {
    mockRaw.mockResolvedValue({ canceled: true })
    mockUe.mockResolvedValueOnce(JOB).mockResolvedValue(status())
    const ac = new AbortController()
    const p = tool.execute('c1', { sequence_path: '/Game/Cine/SQ_Intro' }, ac.signal)
    p.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(2_000)
    ac.abort()
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(p).rejects.toThrow(/已向编辑器请求取消/)
    expect(mockRaw).toHaveBeenCalledWith(
      'sequence.render_cancel',
      { job_id: 'job-1' },
      { timeoutMs: 15_000 }
    )
  })
})

describe('formatResult', () => {
  it('取消时说已写出的文件在哪，不说失败', () => {
    const text = formatResult(JOB, status({ state: 'canceled', files_written: 12 }))
    expect(text).toContain('已取消')
    expect(text).toContain('12 个')
    expect(text).not.toContain('失败')
  })

  it('渲完但中途报过错时把错误带上', () => {
    const text = formatResult(
      JOB,
      status({ state: 'finished', files_written: 120, error: '某个材质编译失败' })
    )
    expect(text).toContain('渲染完成')
    expect(text).toContain('某个材质编译失败')
  })

  it('用了用户预设时写预设，不写画质档', () => {
    const text = formatResult(
      { ...JOB, preset_path: '/Game/Render/MyPreset' },
      status({ state: 'finished', files_written: 120 })
    )
    expect(text).toContain('预设 /Game/Render/MyPreset')
    expect(text).not.toContain('standard 档')
  })
})

describe('mp4 = 先出 PNG，再用 FFmpeg 合成', () => {
  const DESCRIBE = { sequence: { display_rate: '24/1' } }
  const VIDEO = { path: `${JOB.output_dir}/SQ_Intro.mp4`, frames: 120 }

  it('没装 FFmpeg 时开渲之前就拦下，一帧都不渲', async () => {
    mockFfmpeg.mockResolvedValueOnce(null)
    await expect(run({ format: 'mp4' })).rejects.toThrow(
      /winget install Gyan\.FFmpeg[\s\S]*还没开始渲染/
    )
    expect(mockUe).not.toHaveBeenCalled()
  })

  it('发给引擎的是 png；渲完拿序列帧率去合成', async () => {
    mockFfmpeg.mockResolvedValueOnce('C:/ffmpeg/bin/ffmpeg.exe')
    mockUe
      .mockResolvedValueOnce(DESCRIBE)
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    mockCompose.mockResolvedValueOnce(VIDEO)
    const text = textOf(await run({ format: 'mp4' }))
    expect(mockUe.mock.calls[0]![0]).toBe('sequence.describe')
    expect(mockUe.mock.calls[1]![0]).toBe('sequence.render')
    expect(mockUe.mock.calls[1]![1]).toMatchObject({ format: 'png' })
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        ffmpeg: 'C:/ffmpeg/bin/ffmpeg.exe',
        frameDir: JOB.output_dir,
        fps: '24/1'
      })
    )
    expect(text.split('\n')[0]).toContain('已合成 MP4')
    expect(text).toContain('共 120 帧')
  })

  it('合成失败时第一句就说失败，帧照样交代清楚，不按错误抛', async () => {
    mockFfmpeg.mockResolvedValueOnce('ffmpeg')
    mockUe
      .mockResolvedValueOnce(DESCRIBE)
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 120 }))
    mockCompose.mockRejectedValueOnce(new Error('Unknown encoder libx264'))
    const text = textOf(await run({ format: 'mp4' }))
    expect(text.split('\n')[0]).toContain('合成 MP4 失败')
    expect(text).toContain('libx264')
    expect(text).toContain('不用重渲')
  })

  it('渲染被取消就不合成', async () => {
    mockFfmpeg.mockResolvedValueOnce('ffmpeg')
    mockUe
      .mockResolvedValueOnce(DESCRIBE)
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce(status({ state: 'canceled', files_written: 10 }))
    await run({ format: 'mp4' })
    expect(mockCompose).not.toHaveBeenCalled()
  })

  it('读不到帧率就不开渲', async () => {
    mockFfmpeg.mockResolvedValueOnce('ffmpeg')
    mockUe.mockResolvedValueOnce({ sequence: {} })
    await expect(run({ format: 'mp4' })).rejects.toThrow(/读不到[\s\S]*帧率/)
    expect(mockUe).toHaveBeenCalledTimes(1)
  })

  it('用户点名要 MRQ 自带的 MP4 编码：原样交给插件，不查 FFmpeg、不合成', async () => {
    mockUe
      .mockResolvedValueOnce({ ...JOB, format: 'mp4' })
      .mockResolvedValueOnce(status({ state: 'finished', files_written: 1 }))
    const text = textOf(await run({ format: 'mp4_mrq' }))
    expect(text).not.toContain('对不上')
    expect(mockUe.mock.calls[0]![1]).toMatchObject({ format: 'mp4' })
    expect(mockFfmpeg).not.toHaveBeenCalled()
    expect(mockCompose).not.toHaveBeenCalled()
  })
})
