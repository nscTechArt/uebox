import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotebookTaskService, TaskCancelledError } from './NotebookTaskService'
import { stubSettingsApi } from './testSettingsStub'
import type { StreamedChatParams } from '@renderer/api/ai'

const aiMocks = vi.hoisted(() => ({
  chatText: vi.fn()
}))

vi.mock('@renderer/api/ai', () => ({
  aiAPI: { chatText: aiMocks.chatText }
}))

vi.mock('@renderer/i18n', () => ({
  getLocale: () => 'zh-CN'
}))

const SOURCES = [{ id: 's1', title: '光照笔记', content: '关于 Lumen 的一些记录。' }]

/**
 * 等到配方真的把请求发出去。
 *
 * 不能用一句 `await Promise.resolve()` 顶替：配方在发请求之前还要读一次
 * 自定义提示词（异步），微任务数量会随实现变，写死几个就是在赌。
 */
async function waitForModelCall(times = 1): Promise<void> {
  for (let i = 0; i < 100 && aiMocks.chatText.mock.calls.length < times; i++) {
    await Promise.resolve()
  }
}

/** 一次成功的模型调用：吐两段文本，返回全文 */
function respondWith(text: string): void {
  aiMocks.chatText.mockImplementation(async (params: StreamedChatParams) => {
    params.onDelta?.(text.slice(0, 3), text.slice(0, 3))
    params.onDelta?.(text.slice(3), text)
    return text
  })
}

describe('NotebookTaskService', () => {
  beforeEach(() => {
    aiMocks.chatText.mockReset()
    // 配方跑之前会读一次自定义提示词；不给桩每个用例都会打一行读取失败的 warn
    stubSettingsApi()
  })

  it('本地跑完一次知识图谱生成，不碰任何服务端', async () => {
    respondWith('{"nodes":[{"id":"n1","label":"Lumen","type":"feature"}],"edges":[]}')

    const result = await new NotebookTaskService().executeTask('knowledgeGraph', SOURCES, [], {
      notebookTitle: '渲染笔记'
    })

    expect(result).toEqual({
      nodes: [{ id: 'n1', label: 'Lumen', type: 'feature' }],
      edges: []
    })

    // 提示词里要带上材料本身，否则模型是在凭空编
    const params = aiMocks.chatText.mock.calls[0][0] as StreamedChatParams
    expect(JSON.stringify(params.messages)).toContain('关于 Lumen 的一些记录')
    expect(params.responseFormat).toEqual({ type: 'json_object' })
  })

  it('模型把 JSON 裹进代码块也能解出来', async () => {
    respondWith('```json\n{"ideas":[{"id":"i1","title":"想法","description":"说明"}]}\n```')

    const result = await new NotebookTaskService().executeTask('brainstorm', SOURCES, [], {})

    expect(result).toEqual({ ideas: [{ id: 'i1', title: '想法', description: '说明' }] })
  })

  it('思维导图与报告拿的是原样 markdown', async () => {
    respondWith('- 根节点\n  - 分支')
    const mindmap = await new NotebookTaskService().executeTask('mindmap', SOURCES, [], {})
    expect(mindmap).toEqual({ markdown: '- 根节点\n  - 分支' })

    respondWith('# 渲染现状\n\n## 摘要\n正文')
    const report = await new NotebookTaskService().executeTask('report', SOURCES, [], {
      notebookTitle: '渲染笔记'
    })
    expect(report).toEqual({ content: '# 渲染现状\n\n## 摘要\n正文', title: '渲染现状' })
  })

  it('进度只增不减，做完补一发 100', async () => {
    respondWith('- 根节点\n  - 分支')
    const progresses: number[] = []

    await new NotebookTaskService().executeTask('mindmap', SOURCES, [], {}, (progress, status) => {
      progresses.push(progress)
      if (status === 'completed') expect(progress).toBe(100)
    })

    expect(progresses.length).toBeGreaterThan(1)
    expect(progresses).toEqual([...progresses].sort((a, b) => a - b))
    expect(progresses.at(-1)).toBe(100)
  })

  it('取消会中止模型调用，并抛 TaskCancelledError', async () => {
    const service = new NotebookTaskService()

    // 模型「正在生成」时用户点了取消：signal 一断就该结束，而不是等它写完
    aiMocks.chatText.mockImplementation(
      (params: StreamedChatParams) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const running = service.executeTask('report', SOURCES, [], { notebookId: 'nb1' })
    await waitForModelCall()
    service.cancel('nb1:report')

    await expect(running).rejects.toBeInstanceOf(TaskCancelledError)
  })

  it('同一个知识库重复点同一种产出，先掐掉上一次', async () => {
    const service = new NotebookTaskService()
    const aborted: boolean[] = []

    aiMocks.chatText.mockImplementation(
      (params: StreamedChatParams) =>
        new Promise((resolve) => {
          params.signal?.addEventListener('abort', () => {
            aborted.push(true)
            resolve('')
          })
        })
    )

    const first = service.executeTask('report', SOURCES, [], { notebookId: 'nb1' })
    await waitForModelCall()

    respondWith('# 第二次\n正文')
    const second = await service.executeTask('report', SOURCES, [], { notebookId: 'nb1' })

    await expect(first).rejects.toBeInstanceOf(TaskCancelledError)
    expect(aborted).toEqual([true])
    expect(second).toEqual({ content: '# 第二次\n正文', title: '第二次' })
  })

  it('模型回的不是 JSON 时给一句能看懂的话，而不是 SyntaxError', async () => {
    respondWith('抱歉，我无法完成这个请求。')

    await expect(
      new NotebookTaskService().executeTask('knowledgeGraph', SOURCES, [], {})
    ).rejects.toThrow('不是合法 JSON')
  })

  it('一条来源和一条消息都没有时不发请求', async () => {
    await expect(new NotebookTaskService().executeTask('mindmap', [], [], {})).rejects.toThrow(
      '至少需要提供一个来源或消息'
    )
    expect(aiMocks.chatText).not.toHaveBeenCalled()
  })
})
