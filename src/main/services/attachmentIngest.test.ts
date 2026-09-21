/**
 * 守的是那次真机事故：用户把一个 mp4 拖给 agent，`read_local_file` 不拦二进制，
 * 模型拿到 50KB 乱码，接着去用浏览器工具开 `file:` 协议，被拒之后反复重试，
 * 最后撞上服务端限流，整个会话死掉。
 *
 * 这里钉住的是那件事的修法：**每一类附件都要在本地先解释成模型吃得下的东西**，
 * 而且任何一条路走不通时，回去的必须是一句人能看懂的话，不是乱码、也不是空手。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const analyzeVideoSource = vi.fn()
const analyzeLocalAudioFile = vi.fn()
const extractVideoContactSheets = vi.fn()
const loadDocument = vi.fn()

vi.mock('./videoAnalysis/videoSourceAnalysis', () => ({
  analyzeVideoSource: (...args: unknown[]) => analyzeVideoSource(...args)
}))
vi.mock('./videoAnalysis/audioFileAnalysis', () => ({
  analyzeLocalAudioFile: (...args: unknown[]) => analyzeLocalAudioFile(...args)
}))
vi.mock('./videoAnalysis/videoFrameFallback', () => ({
  extractVideoContactSheets: (...args: unknown[]) => extractVideoContactSheets(...args),
  cleanupContactSheets: vi.fn(),
  describeContactSheets: () => '【视频 clip.mp4】没有配置能看视频的模型，改为抽帧给你看。'
}))
vi.mock('../sqliteDataBase/ipc/documentLoader', () => ({
  loadDocument: (...args: unknown[]) => loadDocument(...args)
}))

const { classifyAttachment, ingestAttachment } = await import('./attachmentIngest')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('附件分派', () => {
  it.each([
    ['photo.PNG', 'image'],
    ['clip.mp4', 'video'],
    ['clip.MOV', 'video'],
    ['voice.m4a', 'audio'],
    ['案子.pdf', 'document'],
    // 认不出的交给 documentLoader 自己判断，它连纯文本和代码文件都认 ——
    // 在这里再抄一份扩展名清单只会两边漂移
    ['readme.txt', 'document']
  ])('%s → %s', (name, kind) => {
    expect(classifyAttachment(name)).toBe(kind)
  })
})

describe('视频', () => {
  it('配了视频模型就用模型看，描述里写明是谁看的', async () => {
    analyzeVideoSource.mockResolvedValue({
      success: true,
      markdown: '一段竖屏广告',
      model: '阿里云百炼:qwen-max'
    })

    const result = await ingestAttachment({ filePath: 'D:/素材/clip.mp4' })

    expect(result.success).toBe(true)
    expect(result.text).toContain('阿里云百炼:qwen-max')
    expect(result.text).toContain('一段竖屏广告')
    expect(result.framesFallback).toBeUndefined()
    expect(extractVideoContactSheets).not.toHaveBeenCalled()
  })

  it('压过的要如实说 —— 画质判断不能基于压缩件', async () => {
    analyzeVideoSource.mockResolvedValue({
      success: true,
      markdown: '内容摘要',
      model: 'x:y',
      compressed: true
    })

    const result = await ingestAttachment({ filePath: 'D:/素材/big.mp4' })

    expect(result.compressed).toBe(true)
    expect(result.text).toContain('画质比原片低')
  })

  it('没有视频模型时退回抽帧，而不是甩一句「去设置里配」', async () => {
    analyzeVideoSource.mockResolvedValue({ success: false, error: '没有能看视频的模型。' })
    extractVideoContactSheets.mockResolvedValue({
      success: true,
      sheetPaths: ['C:/tmp/a/sheet_1.png'],
      fps: 2,
      durationSec: 28
    })

    const result = await ingestAttachment({ filePath: 'D:/素材/clip.mp4' })

    expect(result.success).toBe(true)
    expect(result.framesFallback).toBe(true)
    expect(result.imagePaths).toEqual(['C:/tmp/a/sheet_1.png'])
  })

  it('两条路都断了，两边的原因都要说 —— 只报 FFmpeg 会让人配错地方', async () => {
    analyzeVideoSource.mockResolvedValue({ success: false, error: '没有能看视频的模型。' })
    extractVideoContactSheets.mockResolvedValue({ success: false, error: '没装 FFmpeg。' })

    const result = await ingestAttachment({ filePath: 'D:/素材/clip.mp4' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('没有能看视频的模型')
    expect(result.error).toContain('没装 FFmpeg')
  })
})

describe('音频', () => {
  it('走的是同一批多模态模型，不需要用户再单勾一次', async () => {
    analyzeLocalAudioFile.mockResolvedValue({
      success: true,
      markdown: '两个人在对台词',
      model: 'x:qwen-omni'
    })

    const result = await ingestAttachment({ filePath: 'D:/录音/voice.m4a' })

    expect(result.success).toBe(true)
    expect(result.kind).toBe('audio')
    expect(result.text).toContain('两个人在对台词')
  })

  it('听不了就如实报错，不退回乱码', async () => {
    analyzeLocalAudioFile.mockResolvedValue({ success: false, error: '这个模型不收音频' })

    const result = await ingestAttachment({ filePath: 'D:/录音/voice.m4a' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('这个模型不收音频')
  })
})

describe('文档', () => {
  it('复用知识库那一套解析器 —— 同一个 PDF 两边读出来必须一致', async () => {
    loadDocument.mockResolvedValue({ success: true, content: '# 策划案\n\n正文' })

    const result = await ingestAttachment({ filePath: 'D:/需求/案子.pdf' })

    expect(loadDocument).toHaveBeenCalledWith('D:/需求/案子.pdf')
    expect(result.success).toBe(true)
    // 文件名那一行在这里就加好，发送时不再包一层
    expect(result.text).toContain('### 文件：案子.pdf')
    expect(result.text).toContain('# 策划案')
  })

  it('扫描件这类解不开的，把解析器的原话透出去', async () => {
    loadDocument.mockResolvedValue({ success: false, error: '这是扫描件，需要 OCR' })

    const result = await ingestAttachment({ filePath: 'D:/需求/扫描.pdf' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('OCR')
  })
})

it('没给路径时不去碰任何解析器', async () => {
  const result = await ingestAttachment({ filePath: '   ' })

  expect(result.success).toBe(false)
  expect(loadDocument).not.toHaveBeenCalled()
  expect(analyzeVideoSource).not.toHaveBeenCalled()
})
