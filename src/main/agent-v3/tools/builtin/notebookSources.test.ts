/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchNotebookRag = vi.hoisted(() => vi.fn())

vi.mock('../../../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../../../sqliteDataBase/services/notebookRagService', () => ({ searchNotebookRag }))

const { createSearchNotebookSourcesTool } = await import('./notebookSources')

/** 一段命中，字段按 NotebookChunkSearchResult 的形状给 */
function hit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunkId: 'c1',
    notebookId: 'nb1',
    sourceId: 's1',
    content: '虚幻的 Nanite 适合高模静态网格',
    chunkIndex: 0,
    createdAt: '',
    updatedAt: '',
    distance: 0.1234,
    sourceTitle: '渲染笔记.pdf',
    ...overrides
  }
}

const tool = createSearchNotebookSourcesTool({ id: 'nb1', title: '渲染资料' })

async function run(input: Record<string, unknown>): Promise<{ text: string; details?: unknown }> {
  const result = await tool.execute('call-1', input)
  return {
    text: (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n'),
    details: result.details
  }
}

beforeEach(() => {
  searchNotebookRag.mockReset()
})

describe('知识库检索工具', () => {
  it('查的是会话绑的那个知识库，模型不用（也不能）自己指定', async () => {
    searchNotebookRag.mockResolvedValue([hit()])

    await run({ query: 'Nanite 怎么用' })

    expect(searchNotebookRag).toHaveBeenCalledWith({}, 'nb1', 'Nanite 怎么用', { limit: 8 })
  })

  it('片段带上来源标题，模型才说得出结论出自哪一份', async () => {
    searchNotebookRag.mockResolvedValue([hit(), hit({ sourceTitle: '性能清单.md' })])

    const { text, details } = await run({ query: 'x' })

    expect(text).toContain('渲染笔记.pdf')
    expect(text).toContain('性能清单.md')
    expect(details).toHaveLength(2)
  })

  it('没有标题时退到文件名 / 链接，而不是显示成空白', async () => {
    searchNotebookRag.mockResolvedValue([
      hit({ sourceTitle: null, fileName: 'a.txt' }),
      hit({ sourceTitle: null, fileName: null, sourceUrl: 'https://x.dev/doc' })
    ])

    const { text } = await run({ query: 'x' })

    expect(text).toContain('a.txt')
    expect(text).toContain('https://x.dev/doc')
  })

  /**
   * 一个 PDF 片段几千字，原样塞进去几条就能吃掉上下文的大头 ——
   * 而模型判断「这段有没有用」根本不需要读完。
   */
  it('超长片段截断', async () => {
    searchNotebookRag.mockResolvedValue([hit({ content: '很'.repeat(3000) })])

    const { text } = await run({ query: 'x' })

    expect(text).toContain('片段已截断')
    expect(text.length).toBeLessThan(1500)
  })

  /** 张数卡上限：模型填个 100 不该让一次检索把上下文占满 */
  it('limit 卡在 1..8', async () => {
    searchNotebookRag.mockResolvedValue([hit()])

    await run({ query: 'x', limit: 100 })
    expect(searchNotebookRag).toHaveBeenLastCalledWith({}, 'nb1', 'x', { limit: 8 })

    await run({ query: 'x', limit: 0 })
    expect(searchNotebookRag).toHaveBeenLastCalledWith({}, 'nb1', 'x', { limit: 1 })
  })

  /**
   * 空结果不是错误。但要说清楚下一步能干什么 —— 只回一句「没找到」的话，
   * 模型多半原样再查一遍，或者干脆开始编。
   */
  it('一条都没检索到时说清楚该怎么办，并明确禁止编造', async () => {
    searchNotebookRag.mockResolvedValue([])

    const { text } = await run({ query: '量子隧穿' })

    expect(text).toContain('没有检索到')
    expect(text).toContain('量子隧穿')
    expect(text).toMatch(/换个说法/)
    expect(text).toMatch(/别自己编/)
  })

  /** 工具名进模型的工具清单，改名等于换了个工具 —— 老会话里的调用会对不上 */
  it('工具名与命名空间是对外契约', () => {
    expect(tool.name).toBe('search_notebook_sources')
    expect(tool.unrealBox.namespace).toBe('notebook')
    // 只读：Ask 模式和最严的审批档位下都该留着
    expect(tool.unrealBox.risk).toBe('safe')
  })

  it('知识库标题写进描述，模型知道自己在查哪一个', () => {
    expect(tool.description).toContain('渲染资料')
  })
})
