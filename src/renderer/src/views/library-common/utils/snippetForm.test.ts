import { describe, expect, it } from 'vitest'
import { detectSnippetForm, readSnippetPayload, summarizeSnippet } from './snippetForm'

const T3D = 'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="E0"\nEnd Object'

describe('detectSnippetForm', () => {
  it('明确写着 form: snippet 且有正文才算片段', () => {
    expect(detectSnippetForm({ form: 'snippet', t3d: T3D })).toBe('snippet')
  })

  it('缺 form 一律按老条目 —— 2026-08-29 之前的包就是这样', () => {
    // 判成「不认识」的话，所有存量条目升级后一条都打不开
    expect(detectSnippetForm({ graphs: [], functions: [], macros: [] })).toBe('t3d')
  })

  it('有 form 但拿不出正文，仍然按老条目', () => {
    // 判宽的代价是详情页读到一段不存在的正文，用户看到一个空白摘要页，
    // 他的东西看着像丢了
    expect(detectSnippetForm({ form: 'snippet' })).toBe('t3d')
    expect(detectSnippetForm({ form: 'snippet', t3d: '' })).toBe('t3d')
    expect(detectSnippetForm({ form: 'snippet', t3d: 42 })).toBe('t3d')
  })

  it('改道之前那个短命的 form: graph 落进老条目这一支', () => {
    // 结构化形态从没对外开放过，不留兼容分支
    expect(detectSnippetForm({ form: 'graph', graph: { nodes: [] } })).toBe('t3d')
  })

  it('null / 字符串 / undefined 都按老条目', () => {
    expect(detectSnippetForm(null)).toBe('t3d')
    expect(detectSnippetForm(undefined)).toBe('t3d')
    expect(detectSnippetForm('snippet')).toBe('t3d')
  })
})

describe('readSnippetPayload', () => {
  it('缺省的摘要补成零值', () => {
    const payload = readSnippetPayload({ form: 'snippet', t3d: T3D })
    expect(payload?.meta).toEqual({
      nodeCount: 0,
      connectionCount: 0,
      classes: [],
      openPorts: []
    })
  })

  it('带出来源信息和正文', () => {
    const payload = readSnippetPayload({
      form: 'snippet',
      t3d: T3D,
      sourceBlueprintPath: '/Game/BP_Player',
      sourceGraphName: 'EventGraph'
    })
    expect(payload?.t3d).toBe(T3D)
    expect(payload?.sourceBlueprintPath).toBe('/Game/BP_Player')
    expect(payload?.sourceGraphName).toBe('EventGraph')
  })

  it('老形态返回 null', () => {
    expect(readSnippetPayload({ graphs: [] })).toBeNull()
  })
})

describe('summarizeSnippet', () => {
  it('摘要直接读 meta，不去解析正文', () => {
    const payload = readSnippetPayload({
      form: 'snippet',
      t3d: T3D,
      meta: {
        nodeCount: 3,
        connectionCount: 1,
        classes: ['Event', 'Branch'],
        openPorts: [{ nodeId: '2', pinName: 'then', dir: 'out', formerPeer: 'x.y' }]
      }
    })!

    const summary = summarizeSnippet(payload)
    expect(summary.nodeCount).toBe(3)
    expect(summary.connectionCount).toBe(1)
    expect(summary.openPortCount).toBe(1)
    expect(summary.classes).toEqual(['Event', 'Branch'])
  })
})
