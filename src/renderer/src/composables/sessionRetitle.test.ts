import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLastRoundExcerpt,
  MAX_EXCERPT_CHARS,
  resetRetitleStateForTest,
  retitleSession,
  type ExcerptMessage
} from './sessionRetitle'

const generateSessionTitleFromExcerpt = vi.hoisted(() => vi.fn())
vi.mock('../api/ai', () => ({ aiAPI: { generateSessionTitleFromExcerpt } }))

const round: ExcerptMessage[] = [
  { role: 'user', content: '第一条：帮我导入 FBX' },
  { role: 'assistant', content: '已导入' },
  { role: 'user', content: '材质球怎么是白的' },
  { role: 'assistant', content: '贴图没连上 BaseColor' }
]

describe('buildLastRoundExcerpt', () => {
  it('取最后一轮问答，不是开头那一轮', () => {
    expect(buildLastRoundExcerpt(round)).toBe(
      'User: 材质球怎么是白的\nAssistant: 贴图没连上 BaseColor'
    )
  })

  it('最后一条是提问（还没回答）时只带提问', () => {
    expect(buildLastRoundExcerpt([...round, { role: 'user', content: '那怎么连' }])).toBe(
      'User: 那怎么连'
    )
  })

  it('多模态消息只取文本部分', () => {
    const messages: ExcerptMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', text: undefined },
          { type: 'text', text: '这张图里的报错' }
        ]
      }
    ]
    expect(buildLastRoundExcerpt(messages)).toBe('User: 这张图里的报错')
  })

  it('超长提问不吃光预算，回答照样留得下', () => {
    const excerpt = buildLastRoundExcerpt([
      { role: 'user', content: '日'.repeat(5000) },
      { role: 'assistant', content: '结论：改一下采样器' }
    ])
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS)
    expect(excerpt).toContain('结论：改一下采样器')
  })

  it('没有任何有效文本时回空串', () => {
    expect(buildLastRoundExcerpt([])).toBe('')
    expect(buildLastRoundExcerpt([{ role: 'user', content: '   ' }])).toBe('')
  })

  it('只有助手消息时退回最后一条有内容的', () => {
    expect(buildLastRoundExcerpt([{ role: 'assistant', content: '打包完成' }])).toBe('打包完成')
  })
})

describe('retitleSession', () => {
  beforeEach(() => {
    generateSessionTitleFromExcerpt.mockReset()
    resetRetitleStateForTest()
  })

  it('拿到标题就落下去', async () => {
    generateSessionTitleFromExcerpt.mockResolvedValue('材质球泛白')
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('ok')
    expect(applyTitle).toHaveBeenCalledWith('材质球泛白')
    expect(generateSessionTitleFromExcerpt).toHaveBeenCalledWith({
      excerpt: 'User: 材质球怎么是白的\nAssistant: 贴图没连上 BaseColor'
    })
  })

  it('没有对话内容时连模型都不打', async () => {
    const applyTitle = vi.fn()
    expect(await retitleSession('s1', [], applyTitle)).toBe('empty')
    expect(generateSessionTitleFromExcerpt).not.toHaveBeenCalled()
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('模型没配 / 调用失败不抛错，原名留着', async () => {
    generateSessionTitleFromExcerpt.mockRejectedValue(new Error('未绑定轻量任务模型'))
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('failed')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('模型回废话（空串）也不改名', async () => {
    generateSessionTitleFromExcerpt.mockResolvedValue('')
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('failed')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  // 后台起名要几秒；这期间用户手动改了名，晚到的模型名字不能把它盖掉
  it('起名期间标题被改过就不落', async () => {
    let resolveTitle: (value: string) => void = () => {}
    generateSessionTitleFromExcerpt.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )
    const applyTitle = vi.fn()
    let current = '旧名字'

    const pending = retitleSession('s1', round, applyTitle, () => current)
    current = '用户刚改的名字'
    resolveTitle('模型起的名字')

    expect(await pending).toBe('skipped')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('同一条会话在途时不重复发起', async () => {
    let resolveTitle: (value: string) => void = () => {}
    generateSessionTitleFromExcerpt.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )

    const first = retitleSession('s1', round, vi.fn())
    expect(await retitleSession('s1', round, vi.fn())).toBe('skipped')

    resolveTitle('材质球泛白')
    await first
    expect(generateSessionTitleFromExcerpt).toHaveBeenCalledTimes(1)
  })
})
