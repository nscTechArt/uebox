import { beforeEach, describe, expect, it, vi } from 'vitest'

const taskMocks = vi.hoisted(() => ({
  executeTask: vi.fn()
}))

// 只替掉真正会发模型请求的那一个，`toTaskSources`（来源按档位换算）留真的 ——
// 假一个的话这里就测不到「不进上下文的来源不会被送出去」
vi.mock('../notebook/NotebookTaskService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notebook/NotebookTaskService')>()),
  getNotebookTaskService: () => ({ executeTask: taskMocks.executeTask }),
  TaskCancelledError: class TaskCancelledError extends Error {}
}))

vi.mock('@renderer/i18n', () => ({
  getLocale: () => 'zh-CN'
}))

import { KnowledgeGraphService } from './KnowledgeGraphService'

const SOURCES = [{ id: 's1', title: '光照笔记', content: '关于 Lumen 的记录。' }] as never

describe('KnowledgeGraphService', () => {
  beforeEach(() => {
    taskMocks.executeTask.mockReset()
  })

  it('抽出实体时算成功', async () => {
    taskMocks.executeTask.mockResolvedValue({
      nodes: [
        { id: 'n1', label: 'Lumen', type: 'feature' },
        { id: 'n2', label: '全局光照', type: 'concept' }
      ],
      edges: [{ source: 'n1', target: 'n2', label: 'is_a' }]
    })

    const service = new KnowledgeGraphService()
    const data = await service.generateAsync(SOURCES, [], '渲染笔记')

    expect(data?.nodes).toHaveLength(2)
    expect(data?.edges).toHaveLength(1)
    expect(service.state.value.status).toBe('completed')
  })

  /**
   * 一个实体都没有的图谱不是「生成完成」。
   *
   * 模型返回 `{}` 或 `{"nodes":[]}` 时（小模型忽略 schema 时很常见），配方会兜底
   * 成空数组 —— 空数组是真值，之前那句 `!result?.nodes` 拦不住，于是界面提示
   * 「知识图谱生成完成」，点开却是一张空图。
   */
  it('模型没抽出实体时报失败，而不是报「生成完成」', async () => {
    taskMocks.executeTask.mockResolvedValue({ nodes: [], edges: [] })

    const service = new KnowledgeGraphService()
    const data = await service.generateAsync(SOURCES, [], '渲染笔记')

    expect(data).toBeNull()
    expect(service.state.value.status).toBe('failed')
    expect(service.state.value.error).toContain('没有抽取出任何实体')
  })

  it('实体全都缺 id 或 label 时同样算失败', async () => {
    taskMocks.executeTask.mockResolvedValue({
      nodes: [{ id: '', label: '' }, { label: '只有标签' }],
      edges: []
    })

    const service = new KnowledgeGraphService()
    const data = await service.generateAsync(SOURCES, [], '渲染笔记')

    expect(data).toBeNull()
    expect(service.state.value.status).toBe('failed')
  })

  it('知识库为空时不调模型', async () => {
    const service = new KnowledgeGraphService()

    expect(await service.generateAsync([], [], '渲染笔记')).toBeNull()
    expect(taskMocks.executeTask).not.toHaveBeenCalled()
    expect(service.state.value.status).toBe('failed')
  })
})
