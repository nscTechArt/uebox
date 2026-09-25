import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAPI, parseGeneratedTitle, MAX_SESSION_TITLE_CHARS } from './ai'

const chatCompletion = vi.fn()

beforeEach(() => {
  chatCompletion.mockReset()
  Object.assign(window.api, { ai: { chatCompletion } })
})

describe('parseGeneratedTitle', () => {
  it('解析 JSON 代码块', () => {
    expect(parseGeneratedTitle('```json\n{"title":"蓝图编译报错排查"}\n```')).toBe(
      '蓝图编译报错排查'
    )
  })

  it('解析裸 JSON 和前后带解说的 JSON', () => {
    expect(parseGeneratedTitle('{"title":"材质球泛白"}')).toBe('材质球泛白')
    expect(parseGeneratedTitle('好的，标题是：{"title":"材质球泛白"} 希望有帮助')).toBe(
      '材质球泛白'
    )
  })

  it('兼容不支持结构化输出的模型直接吐一行标题', () => {
    expect(parseGeneratedTitle('导入 FBX 丢材质\n（仅供参考）')).toBe('导入 FBX 丢材质')
  })

  it('去掉模型爱加的引号和句末标点', () => {
    expect(parseGeneratedTitle('“打包失败定位”。')).toBe('打包失败定位')
    expect(parseGeneratedTitle('{"title":"\\"Nanite 性能\\""}')).toBe('Nanite 性能')
  })

  it('超长标题按上限截断', () => {
    const long = '这是一个非常非常长的标题模型完全无视了字数限制还在继续写下去'
    expect(parseGeneratedTitle(long)).toHaveLength(MAX_SESSION_TITLE_CHARS)
  })

  it('空内容和非字符串 title 都回空串，由调用方降级', () => {
    expect(parseGeneratedTitle('')).toBe('')
    expect(parseGeneratedTitle('   ')).toBe('')
    expect(parseGeneratedTitle('{"title":null}')).toBe('')
    // maxTokens 截断的半截 JSON，不能把首行的 `{` 当标题
    expect(parseGeneratedTitle('{\n  "title": "竖屏游戏上下')).toBe('')
    expect(parseGeneratedTitle('```json\n{"title": "竖屏')).toBe('')
  })
})

describe('aiAPI.generateSessionTitle', () => {
  it('只喂第一条消息的前 500 字，且走轻量任务模型', async () => {
    chatCompletion.mockResolvedValue({ success: true, data: { content: '{"title":"日志排查"}' } })

    const title = await aiAPI.generateSessionTitle({
      firstMessage: `帮我看这段日志\n${'日'.repeat(2000)}`
    })

    expect(title).toBe('日志排查')
    const args = chatCompletion.mock.calls[0][0]
    expect(args.role).toBe('summary')
    const userMessage = args.messages.at(-1)
    expect(userMessage.content).toHaveLength(500)
    expect(userMessage.content.startsWith('帮我看这段日志 日日日')).toBe(true)
  })

  it('空消息不发起调用', async () => {
    expect(await aiAPI.generateSessionTitle({ firstMessage: '  \n ' })).toBe('')
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('调用失败时抛错，交给调用方降级', async () => {
    chatCompletion.mockResolvedValue({ success: false, error: '未绑定轻量任务模型' })
    await expect(aiAPI.generateSessionTitle({ firstMessage: '你好' })).rejects.toThrow(
      '未绑定轻量任务模型'
    )
  })
})
