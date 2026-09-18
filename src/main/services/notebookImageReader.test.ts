/**
 * @vitest-environment node
 *
 * 读图的**边界**。这个功能按张收费，每一条边界都是在替用户守钱包，
 * 所以这里测的几乎全是「什么时候不读」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  resolveBinding: vi.fn()
}))

vi.mock('../ai/piCompletion', () => ({
  complete: aiMocks.complete,
  resolveBinding: aiMocks.resolveBinding
}))

import {
  DEFAULT_IMAGE_READ_POLICY,
  extractImageRefs,
  readImagesInMarkdown
} from './notebookImageReader'

const ON = { ...DEFAULT_IMAGE_READ_POLICY, enabled: true }

/** 假装某个 URL 下载回来是一张多大的图 */
function stubImage(bytes: number, contentType = 'image/jpeg'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: { get: () => contentType },
      arrayBuffer: async () => new ArrayBuffer(bytes)
    }))
  )
}

/** 模型这次回什么 */
function stubVision(text: string): void {
  aiMocks.complete.mockResolvedValue({ content: [{ type: 'text', text }] })
}

beforeEach(() => {
  aiMocks.complete.mockReset()
  aiMocks.resolveBinding.mockReset()
  aiMocks.resolveBinding.mockResolvedValue({ provider: { id: 'p' }, modelId: 'm' })
  vi.unstubAllGlobals()
})

describe('extractImageRefs', () => {
  it('同一张图只算一次 —— 页眉页脚的引流图会重复出现', () => {
    const md = '![](https://x/a.jpg)\n正文\n![别的 alt](https://x/a.jpg)\n![](https://x/b.jpg)'
    expect(extractImageRefs(md).map((r) => r.url)).toEqual(['https://x/a.jpg', 'https://x/b.jpg'])
  })

  it('只认 http(s)，不碰 data: 和本地路径', () => {
    const md = '![](data:image/png;base64,xxx)\n![](/local/a.png)\n![](https://x/c.jpg)'
    expect(extractImageRefs(md).map((r) => r.url)).toEqual(['https://x/c.jpg'])
  })
})

describe('总开关', () => {
  it('默认是关的 —— 花钱的事不能替用户决定', () => {
    expect(DEFAULT_IMAGE_READ_POLICY.enabled).toBe(false)
  })

  it('没开就一张不读，正文原样返回', async () => {
    stubImage(1024 * 1024)
    stubVision('图里的字')

    const md = '![](https://x/a.jpg)'
    const result = await readImagesInMarkdown(md, DEFAULT_IMAGE_READ_POLICY)

    expect(result.markdown).toBe(md)
    expect(result.stats.read).toBe(0)
    expect(aiMocks.complete).not.toHaveBeenCalled()
  })
})

describe('读之前的门槛', () => {
  it('太小的图不读 —— 那是图标、分割线、表情', async () => {
    stubImage(2 * 1024)
    stubVision('不该被调用')

    const result = await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    expect(result.stats.read).toBe(0)
    expect(aiMocks.complete).not.toHaveBeenCalled()
  })

  it('太大的图不读 —— 厂商有上限，也防一张巨图吃掉额度', async () => {
    stubImage(20 * 1024 * 1024)

    const result = await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    expect(result.stats.read).toBe(0)
    expect(aiMocks.complete).not.toHaveBeenCalled()
  })

  it('返回的不是图片就不读 —— 有些站点对热链回一个 HTML 错误页', async () => {
    stubImage(1024 * 1024, 'text/html')

    const result = await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    expect(result.stats.read).toBe(0)
    expect(aiMocks.complete).not.toHaveBeenCalled()
  })

  it('每篇有张数上限，超出的不读但要如实报出来', async () => {
    stubImage(1024 * 1024)
    stubVision('图里的字够长了随便写点')

    const md = Array.from({ length: 10 }, (_, i) => `![](https://x/${i}.jpg)`).join('\n')
    const result = await readImagesInMarkdown(md, { ...ON, maxImages: 3 })

    expect(result.stats.total).toBe(10)
    expect(result.stats.read).toBe(3)
    expect(result.stats.overLimit).toBe(7)
    expect(aiMocks.complete).toHaveBeenCalledTimes(3)
  })
})

describe('模型回什么才算读到了', () => {
  it('模型说这是装饰图就丢掉，不写进正文', async () => {
    stubImage(1024 * 1024)
    stubVision('SKIP')

    const md = '![](https://x/qr.jpg)'
    const result = await readImagesInMarkdown(md, ON)

    expect(result.markdown).toBe(md)
    expect(result.stats.read).toBe(0)
    expect(result.stats.decorative).toBe(1)
  })

  it('只认出两三个字也当没读到', async () => {
    stubImage(1024 * 1024)
    stubVision('确定')

    const result = await readImagesInMarkdown('![](https://x/a.jpg)', ON)
    expect(result.stats.read).toBe(0)
  })

  it('读到了就插在图片后面，并且不覆盖原文', async () => {
    stubImage(1024 * 1024)
    stubVision('报名截止时间：2026年9月30日')

    const result = await readImagesInMarkdown('前文\n![](https://x/a.jpg)\n后文', ON)

    // 原来那行图还在
    expect(result.markdown).toContain('![](https://x/a.jpg)')
    // 识别结果跟在它后面，且标着是 AI 认的
    expect(result.markdown).toContain('AI 识别')
    expect(result.markdown).toContain('> 报名截止时间：2026年9月30日')
    // 上下文一个字没动
    expect(result.markdown).toContain('前文')
    expect(result.markdown).toContain('后文')
    expect(result.stats.read).toBe(1)
  })
})

describe('出错时', () => {
  it('一张图失败不影响其他图', async () => {
    stubImage(1024 * 1024)
    aiMocks.complete
      .mockRejectedValueOnce(new Error('这张超时了'))
      .mockResolvedValue({ content: [{ type: 'text', text: '第二张图里读出来的一整段文字' }] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await readImagesInMarkdown('![](https://x/a.jpg)\n![](https://x/b.jpg)', ON)

    expect(result.stats.skipped).toBe(1)
    expect(result.stats.read).toBe(1)
    expect(result.markdown).toContain('第二张图里读出来的一整段文字')
    warn.mockRestore()
  })

  it('没有图就什么都不做，也不去解析模型绑定', async () => {
    const result = await readImagesInMarkdown('一段纯文字', ON)

    expect(result.stats.total).toBe(0)
    expect(aiMocks.resolveBinding).not.toHaveBeenCalled()
  })
})

describe('把识别结果插回正文', () => {
  /*
    模型抄回来的字里可能带 `$'`、`$&`、`$$`。这些在 String.replace 的**替换字符串**
    里是有特殊含义的：`$'` 展开成「匹配处之后的全文」，等于把后面整篇文章复制一份
    塞进注释块，再写回用户的原始正文。所以替换必须用函数形式。
  */
  it("OCR 文字里的 $' 要原样插进去，不能展开成后面的全文", async () => {
    stubImage(1024 * 1024)
    stubVision("单位：$'000（千元），本季合计 $1,200")

    const md = '![](https://x/a.jpg)\n\n后面还有一整段正文，绝不能被复制一份。'
    const result = await readImagesInMarkdown(md, ON)

    expect(result.markdown).toContain("单位：$'000（千元），本季合计 $1,200")
    // 后面那段正文只能出现一次
    expect(result.markdown.split('后面还有一整段正文').length - 1).toBe(1)
  })

  it('OCR 文字里的 $& 和 $$ 也要原样保留', async () => {
    stubImage(1024 * 1024)
    stubVision('公式 $$E=mc^2$$ 与符号 $& 都要照抄')

    const result = await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    expect(result.markdown).toContain('公式 $$E=mc^2$$ 与符号 $& 都要照抄')
  })
})

describe('不绑任何一家模型', () => {
  it('按角色取绑定，不写死 provider / model', async () => {
    stubImage(1024 * 1024)
    stubVision('图里读出来的一段文字')

    await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    // 只说「我要一个看得懂图的」，具体是谁由用户的配置决定
    expect(aiMocks.resolveBinding).toHaveBeenCalledWith({ role: 'vision', hasImages: true })
    // 真正发请求时用的是解析出来的那一个，不是硬编码的
    expect(aiMocks.complete).toHaveBeenCalledWith({ id: 'p' }, 'm', expect.anything())
  })
})

describe('超时', () => {
  /*
    识别也要能被掐掉：厂商接了请求又不返回时，只掐下载等于没掐 ——
    整篇读图会卡在这一张上，来源永远索引不了。
  */
  it('识别请求要带 signal，否则厂商卡住就没人能叫停', async () => {
    stubImage(1024 * 1024)
    stubVision('图里读出来的一段文字')

    await readImagesInMarkdown('![](https://x/a.jpg)', ON)

    expect(aiMocks.complete).toHaveBeenCalledWith(
      { id: 'p' },
      'm',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  /*
    下载和识别必须各自计时。共用一个预算的话，下载一张 8MB 的图花掉十几秒之后
    剩给模型的时间就不确定了，一台正常但偏慢的服务器会被判成卡死 ——
    而那时候图已经下完、这一张的钱已经要花了，中途放弃是最亏的失败。
  */
  it('识别的预算和下载分开，而且给得更宽', () => {
    expect(DEFAULT_IMAGE_READ_POLICY.recognizeTimeoutMs).toBeGreaterThan(
      DEFAULT_IMAGE_READ_POLICY.timeoutMs
    )
  })

  it('下载用完整个预算也不影响识别的预算', async () => {
    stubImage(1024 * 1024)
    stubVision('图里读出来的一段文字')

    // 下载预算给到 1ms、识别给足；下载在假的 fetch 里立刻返回，识别不该被连累
    const result = await readImagesInMarkdown('![](https://x/a.jpg)', {
      ...ON,
      timeoutMs: 1,
      recognizeTimeoutMs: 90_000
    })

    expect(result.stats.read).toBe(1)
    const options = aiMocks.complete.mock.calls[0][2] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(false)
  })
})
