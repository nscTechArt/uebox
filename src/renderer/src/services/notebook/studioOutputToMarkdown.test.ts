import { describe, expect, it } from 'vitest'
import type { StudioOutput } from '@renderer/store/modules/studioOutputStore'
import { canSaveOutputAsSource, studioOutputToMarkdown } from './studioOutputToMarkdown'

function output(overrides: Partial<StudioOutput>): StudioOutput {
  return {
    id: 'o1',
    type: 'report',
    title: '测试产出',
    sourceCount: 2,
    createdAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  }
}

describe('studioOutputToMarkdown', () => {
  it('报告直接用它的 markdown 正文', () => {
    const result = studioOutputToMarkdown(
      output({ type: 'report', reportContent: '# 标题\n\n正文' })
    )
    expect(result).toEqual({ title: '测试产出', markdown: '# 标题\n\n正文' })
  })

  it('思维导图转成缩进列表', () => {
    const result = studioOutputToMarkdown(
      output({
        type: 'mindmap',
        mindmapData: {
          data: { text: 'Lumen', id: 'root' },
          children: [{ data: { text: 'Final Gather', id: 'n1' } }]
        }
      })
    )

    expect(result?.markdown).toBe('- Lumen\n  - Final Gather')
  })

  it('知识图谱的关系要写成名字，不能留一堆 n1 n2', () => {
    const result = studioOutputToMarkdown(
      output({
        type: 'knowledgeGraph',
        knowledgeGraphData: {
          nodes: [
            { id: 'n1', label: 'Nanite', category: 'feature' },
            { id: 'n2', label: '虚拟几何体', category: 'concept', description: '三角面流式加载' }
          ],
          edges: [{ id: 'e1', source: 'n1', target: 'n2', relation: 'is_a' }]
        }
      })
    )

    expect(result?.markdown).toContain('Nanite —[is_a]→ 虚拟几何体')
    expect(result?.markdown).toContain('三角面流式加载')
    expect(result?.markdown).not.toContain('n1 —')
  })

  it('面试题带上答案和解析', () => {
    const result = studioOutputToMarkdown(
      output({
        type: 'interview',
        interviewConfig: {
          topic: '虚幻引擎',
          knowledgePoints: [
            { id: '1', title: 'Lumen', content: '全动态全局光照', type: 'Concept' }
          ],
          questions: [
            {
              id: 'q1',
              question: 'Lumen 解决什么问题？',
              sourceId: 's1',
              sourceTitle: '光照笔记',
              questionType: 'choice',
              options: [
                { id: 'A', text: '光照烘焙耗时' },
                { id: 'B', text: '材质编译' }
              ],
              correctAnswer: 'A',
              explanation: '它是动态 GI'
            }
          ],
          status: 'ready'
        }
      })
    )

    expect(result?.markdown).toContain('Lumen 解决什么问题？')
    expect(result?.markdown).toContain('**答案**：A')
    expect(result?.markdown).toContain('它是动态 GI')
  })

  it('头脑风暴列出每个想法和依据', () => {
    const result = studioOutputToMarkdown(
      output({
        type: 'brainstorm',
        brainstormData: {
          id: 'b1',
          topicSummary: '关于关卡流送',
          notebookId: 'nb1',
          createdAt: '2026-09-07T00:00:00.000Z',
          ideas: [
            {
              id: 'i1',
              title: '按房间切分',
              description: '把大场景拆成房间级子关卡',
              category: 'innovation',
              reasoning: '材料里提到加载卡顿'
            }
          ]
        }
      })
    )

    expect(result?.markdown).toContain('### 按房间切分')
    expect(result?.markdown).toContain('材料里提到加载卡顿')
  })

  it('网页只留可读文字，不把标签和样式存进来源', () => {
    const result = studioOutputToMarkdown(
      output({
        type: 'webpage',
        webpageHtml:
          '<html><head><style>.a{color:red}</style></head><body><h1>标题</h1><p>正文</p></body></html>'
      })
    )

    expect(result?.markdown).toContain('标题')
    expect(result?.markdown).toContain('正文')
    expect(result?.markdown).not.toContain('color:red')
    expect(result?.markdown).not.toContain('<p>')
  })

  it('还没生成完的产出存不了', () => {
    expect(studioOutputToMarkdown(output({ type: 'report', reportContent: '' }))).toBeNull()
    expect(studioOutputToMarkdown(output({ type: 'mindmap' }))).toBeNull()
    expect(studioOutputToMarkdown(output({ type: 'brainstorm' }))).toBeNull()
  })

  it('信息图是一张图，没有可检索的正文', () => {
    const infographic = output({
      type: 'infographic',
      infographicImageUrl: 'data:image/png;base64,x'
    })
    expect(studioOutputToMarkdown(infographic)).toBeNull()
    expect(canSaveOutputAsSource(infographic)).toBe(false)
  })

  it('canSaveOutputAsSource 与转换结果一致', () => {
    expect(canSaveOutputAsSource(output({ type: 'report', reportContent: '正文' }))).toBe(true)
    expect(canSaveOutputAsSource(output({ type: 'report', reportContent: '  ' }))).toBe(false)
  })
})
