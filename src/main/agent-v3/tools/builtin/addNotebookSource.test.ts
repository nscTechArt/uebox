import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 把查到的东西存进知识库。
 *
 * 这个工具替掉了知识库里原来那两个搜索页签，所以它要守住那两条被删掉的东西
 * 各自守着的性质：
 *
 *   - **地址判据和 web_read 是同一份** —— 少了它，这就是一个能把内网页面
 *     存进知识库的探测器；
 *   - **抓不到正文就如实失败**，不许改存一段自己编的摘要（那正是原来「勾选加入」
 *     这个动作用户做不出来的坏事）；
 *   - 存完要通知界面刷新，否则用户要手动切一次页面才看得见。
 */

const createdSource = vi.fn()
const createdNotebook = vi.fn()
const indexed = vi.fn()
const read = vi.fn()

vi.mock('../../../sqliteDataBase', () => ({ getPublicDatabase: () => ({ fake: true }) }))

vi.mock('../../../sqliteDataBase/models/notebook', () => ({
  createNotebook: (...args: unknown[]) => {
    createdNotebook(...args)
    return 'nb-created'
  },
  createNotebookSource: (...args: unknown[]) => {
    createdSource(...args)
    return 'src-1'
  }
}))

vi.mock('../../../sqliteDataBase/services/notebookRagService', () => ({
  indexNotebookRag: (...args: unknown[]) => indexed(...args)
}))

vi.mock('../../../services/webReader', () => ({
  readWebPageLocally: (...args: unknown[]) => read(...args)
}))

const { createAddNotebookSourceTool } = await import('./addNotebookSource')

const sent: Array<{ channel: string; payload: unknown }> = []
const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => {
    sent.push({ channel, payload })
  }
} as unknown as Parameters<typeof createAddNotebookSourceTool>[1]

function tool(
  notebook: { id: string; title?: string } | undefined = { id: 'nb-1', title: '我的库' }
): ReturnType<typeof createAddNotebookSourceTool> {
  return createAddNotebookSourceTool(notebook, sender)
}

function run(args: unknown, notebook?: { id: string; title?: string } | null): Promise<unknown> {
  const targetTool =
    notebook === null ? createAddNotebookSourceTool(undefined, sender) : tool(notebook)
  return targetTool.execute('call-1', args)
}

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  indexed.mockResolvedValue({ indexedChunks: 3 })
  read.mockResolvedValue({
    success: true,
    title: 'Nanite 文档',
    url: 'https://dev.epicgames.com/nanite',
    content: '正文'.repeat(100)
  })
})

describe('工具契约', () => {
  /** 它往用户的知识库里放东西，必须过审批门 —— 用户点头才算数 */
  it('标 mutating，默认档位下每次都会问用户', () => {
    expect(tool().unrealBox.risk).toBe('mutating')
    expect(tool().unrealBox.namespace).toBe('notebook')
  })

  it('描述里说清楚查完不存等于白查', () => {
    expect(tool().description).toContain('查完不存')
  })
})

describe('存网页', () => {
  it('自己抓正文，存成 link 并带上规范化后的地址', async () => {
    await run({ url: 'https://dev.epicgames.com/nanite' })

    expect(read).toHaveBeenCalledWith('https://dev.epicgames.com/nanite')
    expect(createdSource).toHaveBeenCalledWith(
      { fake: true },
      expect.objectContaining({
        notebookId: 'nb-1',
        type: 'link',
        title: 'Nanite 文档',
        sourceUrl: 'https://dev.epicgames.com/nanite'
      })
    )
  })

  it('给了标题就用给的，不用网页自己的', async () => {
    await run({ url: 'https://dev.epicgames.com/nanite', title: '我要的标题' })

    expect(createdSource).toHaveBeenCalledWith(
      { fake: true },
      expect.objectContaining({ title: '我要的标题' })
    )
  })

  /**
   * 这是最要紧的一条。
   *
   * 无头 + 任意地址 = 内网探测器，而且这次探测结果会**留在知识库里**。
   * 判据必须和 `web_read` 是同一份。
   */
  it.each([
    'http://127.0.0.1:8766/api/debug/tool',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///C:/Windows/win.ini'
  ])('拒绝本机、内网和危险协议：%s', async (url) => {
    await expect(run({ url })).rejects.toThrow('NAVIGATION_BLOCKED')
    expect(read).not.toHaveBeenCalled()
    expect(createdSource).not.toHaveBeenCalled()
  })

  /** 抓不到就如实失败。改存一段自己编的摘要，是这个工具最容易犯也最坏的错 */
  it('抓不到正文时不存，并把原因带出去', async () => {
    read.mockResolvedValue({ success: false, error: '该页面可能由前端脚本渲染' })

    await expect(run({ url: 'https://example.com/spa' })).rejects.toThrow('前端脚本渲染')
    expect(createdSource).not.toHaveBeenCalled()
  })
})

describe('存自己整理的内容', () => {
  it('给 title + content 就直接存成 text，不去抓网页', async () => {
    await run({ title: '三篇材料的综述', content: '# 综述\n\n出处见文末。' })

    expect(read).not.toHaveBeenCalled()
    expect(createdSource).toHaveBeenCalledWith(
      { fake: true },
      expect.objectContaining({ type: 'text', title: '三篇材料的综述', sourceUrl: null })
    )
  })

  /**
   * 整理稿要带一行**我们写的**抬头。
   *
   * 两次真机验收里出错的都是这一类：网址真、原文读过，但一次把划掉的旧建议当现行
   * 结论，一次把论坛提问者的分析记到核心开发者名下。抬头不承诺内容对，它保证的是
   * 半年后翻到这条的人**知道自己在读什么**、该回哪儿核对。
   */
  it('模型整理稿带上「这是 AI 整理稿」的抬头', async () => {
    await run({ title: '三篇材料的综述', content: '# 综述\n\n出处见文末。' })

    const stored = createdSource.mock.calls[0][1] as { content: string }
    expect(stored.content).toContain('这是 AI 整理的稿子，不是原始网页')
    expect(stored.content).toContain('谁说的')
    // 原文照样在后面，不是被替换掉
    expect(stored.content).toContain('# 综述')
  })

  /** 用 url 存的是抓回来的真页面，加这行抬头就是在污染原文 */
  it('抓回来的网页不加抬头', async () => {
    await run({ url: 'https://dev.epicgames.com/nanite' })

    const stored = createdSource.mock.calls[0][1] as { content: string }
    expect(stored.content).not.toContain('这是 AI 整理的稿子')
  })

  it('只给 content 不给标题：打回 —— 来源列表上显示的就是标题', async () => {
    await expect(run({ content: '一段内容' })).rejects.toThrow('标题')
    expect(createdSource).not.toHaveBeenCalled()
  })

  it('什么都不给：打回', async () => {
    await expect(run({})).rejects.toThrow('没有内容可存')
  })
})

describe('落库之后', () => {
  it('建索引，并通知界面刷新来源列表', async () => {
    await run({ url: 'https://dev.epicgames.com/nanite' })

    expect(indexed).toHaveBeenCalledWith({ fake: true }, 'nb-1', { sourceIds: ['src-1'] })
    expect(sent).toEqual([
      {
        channel: 'agent:notebook:source-changed',
        payload: { notebookId: 'nb-1', sourceId: 'src-1', title: 'Nanite 文档' }
      }
    ])
  })

  /** 索引失败不该把已经存好的来源变成一次失败 —— 但要说清楚它只能按关键词搜到 */
  it('向量化失败时来源照样留着，并说明降级了', async () => {
    indexed.mockRejectedValue(new Error('没有配向量模型'))

    const result = (await run({ url: 'https://dev.epicgames.com/nanite' })) as {
      content: Array<{ text?: string }>
    }

    expect(createdSource).toHaveBeenCalled()
    expect(result.content[0].text).toContain('关键词')
  })
})

describe('未绑定知识库', () => {
  it('新建真正可见的知识库，再把报告作为来源放进去', async () => {
    const result = (await run({ title: '虚幻盒子功能调研报告', content: '# 报告正文' }, null)) as {
      content: Array<{ text?: string }>
    }

    expect(createdNotebook).toHaveBeenCalledWith({ fake: true }, { title: '虚幻盒子功能调研报告' })
    expect(createdSource).toHaveBeenCalledWith(
      { fake: true },
      expect.objectContaining({
        notebookId: 'nb-created',
        type: 'text',
        title: '虚幻盒子功能调研报告'
      })
    )
    expect(result.content[0].text).toContain('已新建知识库「虚幻盒子功能调研报告」')
  })

  it('可单独指定新知识库标题', async () => {
    await run(
      {
        title: '功能调研报告',
        content: '# 报告正文',
        notebookTitle: 'Unreal Box 调研'
      },
      null
    )

    expect(createdNotebook).toHaveBeenCalledWith({ fake: true }, { title: 'Unreal Box 调研' })
  })

  it('网页抓取失败时不留下空知识库', async () => {
    read.mockResolvedValue({ success: false, error: '正文为空' })

    await expect(run({ url: 'https://example.com/empty' }, null)).rejects.toThrow('正文为空')
    expect(createdNotebook).not.toHaveBeenCalled()
    expect(createdSource).not.toHaveBeenCalled()
  })
})
