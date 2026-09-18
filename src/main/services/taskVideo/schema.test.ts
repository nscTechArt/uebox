/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { VideoStoryboard, canvasSize, assText, sceneSubtitles } from './schema'

const scene = {
  id: 'one',
  source: 'C:/result.png',
  sourceNote: 'task screenshot',
  kind: 'image',
  title: '结果',
  caption: '关键参数',
  duration: 4
}
describe('task video storyboard', () => {
  it('exports 2K canvases in every orientation', () => {
    expect(canvasSize('16:9')).toEqual([2560, 1440])
    expect(canvasSize('9:16')).toEqual([1440, 2560])
    expect(canvasSize('1:1')).toEqual([1440, 1440])
  })
  it('reloads a saved scene extended beyond 45 seconds while retaining the total limit', () => {
    const board = VideoStoryboard.parse({
      title: '步骤',
      mode: 'tutorial',
      voice: 'off',
      scenes: [{ ...scene, kind: 'text', body: '字'.repeat(300), caption: '', duration: 6 }]
    })
    const extended = Math.max(board.scenes[0].duration, Array.from(board.scenes[0].body).length / 6)
    expect(extended).toBe(50)
    const saved = JSON.parse(
      JSON.stringify({ ...board, scenes: [{ ...board.scenes[0], duration: extended }] })
    )
    expect(VideoStoryboard.parse(saved).scenes[0].duration).toBe(50)
    expect(
      VideoStoryboard.safeParse({ ...saved, scenes: [{ ...saved.scenes[0], duration: 601 }] })
        .success
    ).toBe(false)
    expect(
      VideoStoryboard.safeParse({
        ...saved,
        scenes: Array.from({ length: 13 }, (_, i) => ({ ...saved.scenes[0], id: String(i) }))
      }).success
    ).toBe(false)
  })
  it('supports text-only tasks without requiring paid image generation', () => {
    const board = VideoStoryboard.parse({
      title: '步骤',
      mode: 'tutorial',
      scenes: [{ ...scene, kind: 'text', source: undefined, body: '打开材质\n检查参数' }]
    })
    expect(sceneSubtitles(board.scenes[0], board.ratio, 4)).toContain('打开材质\\N检查参数')
    expect(
      VideoStoryboard.safeParse({
        title: '步骤',
        mode: 'tutorial',
        scenes: [{ ...scene, source: '' }]
      }).success
    ).toBe(false)
  })
  it('retains captions without voice and provides conservative defaults', () => {
    const board = VideoStoryboard.parse({
      title: '教程',
      mode: 'tutorial',
      voice: 'off',
      scenes: [scene]
    })
    expect(board.scenes[0].zoom).toBe(1)
    expect(sceneSubtitles(board.scenes[0], board.ratio, 4)).toContain('关键参数')
    expect(sceneSubtitles(board.scenes[0], board.ratio, 4)).toContain('0:00:04.00')
  })
  it('rejects empty, duplicate and excessive scenes', () => {
    const board = { title: 'test', mode: 'promo', scenes: [] }
    expect(VideoStoryboard.safeParse(board).success).toBe(false)
    expect(VideoStoryboard.safeParse({ ...board, scenes: [scene, scene] }).success).toBe(false)
    expect(
      VideoStoryboard.safeParse({
        ...board,
        scenes: Array.from({ length: 20 }, (_, i) => ({ ...scene, id: String(i), duration: 45 }))
      }).success
    ).toBe(false)
  })
  it('prevents subtitle override injection and scene path traversal', () => {
    expect(assText('{\\pos(0,0)}\n字幕')).toBe('｛＼pos(0,0)｝\\N字幕')
    expect(
      VideoStoryboard.safeParse({
        title: 'test',
        mode: 'promo',
        scenes: [{ ...scene, id: '../escape' }]
      }).success
    ).toBe(false)
  })
})
