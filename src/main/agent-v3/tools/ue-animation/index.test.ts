// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../defineUeTool', () => ({ callUe: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
// 压缩要拉 sharp 并真的解码 PNG，这里只关心「有没有压、压不动怎么办」。
// describeResize 是纯函数，用真的 —— 换成桩就测不出「有没有把尺寸告诉模型」
vi.mock('../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contextImage')>()),
  compressForContext: vi.fn()
}))
import { callUe } from '../defineUeTool'
import { readFile } from 'node:fs/promises'
import { compressForContext } from '../contextImage'
import { animationTools } from './index'

const tools = animationTools()
const tool = (name: string): (typeof tools)[number] => tools.find((entry) => entry.name === name)!
beforeEach(() => vi.resetAllMocks())
const animations = [1, 2, 3].map((n) => ({ animation: `/Game/A${n}`, output_path: `/Game/B${n}` }))

describe('animation tool contracts', () => {
  it('keeps reads safe and writes approval-controlled', () => {
    expect(tools.map((entry) => [entry.name, entry.unrealBox.risk])).toEqual([
      ['anim_measure', 'safe'],
      ['anim_preview', 'safe'],
      ['anim_write_pose', 'mutating'],
      ['anim_retarget', 'mutating']
    ])
  })
  it('reports unmeasurable metrics in model-visible text', async () => {
    vi.mocked(callUe).mockResolvedValue({
      metrics: { gaze_pitch_deg: { status: 'unmeasurable', reason: 'missing head' } }
    })
    const result = await tool('anim_measure').execute('t', { path: '/Game/A' })
    expect(JSON.stringify(result.content)).toContain('missing head')
  })
  // 插件渲的是 1280×720 PNG，原样进上下文是几 MB —— 换来一次 413，
  // 而且 pi 每轮重发整条 transcript，之后每一轮都会再炸一次
  it('returns a compressed preview image, never the raw render', async () => {
    vi.mocked(callUe).mockResolvedValue({ path: '/tmp/preview.png' })
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pixels'))
    vi.mocked(compressForContext).mockResolvedValue({
      data: 'c21hbGw=',
      mimeType: 'image/jpeg',
      width: 768,
      height: 432,
      sourceWidth: 1280,
      sourceHeight: 720
    })
    const result = await tool('anim_preview').execute('t', {
      mesh: '/Game/M',
      animation: '/Game/A',
      time: 0
    })
    expect(compressForContext).toHaveBeenCalledWith(Buffer.from('pixels'))
    expect(result.content).toContainEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'c21hbGw='
    })
    // 缩过就得说清楚缩成了什么样：模型不知道自己看的是缩过的版本时，
    // 会把「看不清」当成「图上没有」
    expect(JSON.stringify(result.content)).toContain('1280×720')
    expect(JSON.stringify(result.content)).toContain('768×432')
  })

  // 没图的时候说实话：模型照着一张它没看到的图断言姿势，比不给图更糟
  it('says the pose image is missing instead of shipping the raw render', async () => {
    vi.mocked(callUe).mockResolvedValue({ path: '/tmp/preview.png' })
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pixels'))
    vi.mocked(compressForContext).mockResolvedValue(null)
    const result = await tool('anim_preview').execute('t', {
      mesh: '/Game/M',
      animation: '/Game/A',
      time: 0
    })
    expect(result.content.some((part) => part.type === 'image')).toBe(false)
    expect(JSON.stringify(result.content)).toContain('anim_measure')
  })
  it('rejects an inverted pose interval before sending a write', async () => {
    await expect(
      tool('anim_write_pose').execute('t', {
        path: '/Game/A',
        source: '/Game/B',
        source_time: 0,
        start_frame: 5,
        end_frame: 2
      })
    ).rejects.toThrow('end_frame')
    expect(callUe).not.toHaveBeenCalled()
  })
  it('reuses the generated retargeter for subsequent items', async () => {
    vi.mocked(callUe).mockResolvedValue({ retargeter: '/Game/RTG' })
    await tool('anim_retarget').execute('t', {
      source_mesh: '/Game/S',
      target_mesh: '/Game/T',
      animations
    })
    expect(callUe).toHaveBeenCalledTimes(3)
    expect(vi.mocked(callUe).mock.calls[1][1]).toMatchObject({
      retargeter: '/Game/RTG',
      animation: '/Game/A2'
    })
  })
  it('never sends another item after stop during the first one', async () => {
    const controller = new AbortController()
    vi.mocked(callUe).mockImplementationOnce(async () => {
      controller.abort()
      return { path: '/Game/B1' }
    })
    await tool('anim_retarget')
      .execute(
        't',
        { source_mesh: '/Game/S', target_mesh: '/Game/T', animations },
        controller.signal
      )
      .catch(() => undefined)
    await Promise.resolve()
    expect(callUe).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callUe).mock.calls[0][2]).not.toHaveProperty('signal')
  })
  it('does not continue after a failed item or duplicate output', async () => {
    vi.mocked(callUe).mockRejectedValueOnce(new Error('unmapped chains'))
    await expect(
      tool('anim_retarget').execute('t', {
        source_mesh: '/Game/S',
        target_mesh: '/Game/T',
        animations
      })
    ).rejects.toThrow('unmapped chains')
    expect(callUe).toHaveBeenCalledTimes(1)
    vi.mocked(callUe).mockClear()
    await expect(
      tool('anim_retarget').execute('t', {
        source_mesh: '/Game/S',
        target_mesh: '/Game/T',
        animations: [animations[0], animations[0]]
      })
    ).rejects.toThrow('重复')
    expect(callUe).not.toHaveBeenCalled()
  })
})
