import { describe, expect, it } from 'vitest'

import { detectPayloadForm, readSnippetPayload } from './snippetPayload'

const T3D = 'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="E0"\nEnd Object'

describe('detectPayloadForm', () => {
  it('form 为 snippet 且 t3d 为非空字符串时识别为片段', () => {
    expect(detectPayloadForm({ form: 'snippet', t3d: T3D })).toBe('snippet')
  })

  it('缺少 form 时按老条目处理', () => {
    // 兼容 2026-08-29 之前未包含 form 字段的存量包。
    expect(detectPayloadForm({ graphs: [], functions: [], macros: [] })).toBe('t3d')
  })

  it('正文缺失、为空或非字符串时，按老条目处理', () => {
    // 正文必须是非空字符串，不能仅根据 form 判断。
    expect(detectPayloadForm({ form: 'snippet' })).toBe('t3d')
    expect(detectPayloadForm({ form: 'snippet', t3d: '' })).toBe('t3d')
    expect(detectPayloadForm({ form: 'snippet', t3d: 42 })).toBe('t3d')
  })

  it('旧版 form: graph 按老条目处理', () => {
    // 旧版结构化形态未对外开放，不提供兼容读取。
    expect(detectPayloadForm({ form: 'graph', graph: { nodes: [] } })).toBe('t3d')
  })

  it('null、字符串和 undefined 均按老条目处理', () => {
    expect(detectPayloadForm(null)).toBe('t3d')
    expect(detectPayloadForm(undefined)).toBe('t3d')
    expect(detectPayloadForm('nonsense')).toBe('t3d')
  })
})

describe('readSnippetPayload', () => {
  it('缺失的摘要字段使用默认值', () => {
    const payload = readSnippetPayload({ form: 'snippet', t3d: T3D })
    expect(payload?.meta).toEqual({
      nodeCount: 0,
      connectionCount: 0,
      classes: [],
      openPorts: []
    })
  })

  it('保留来源信息和正文', () => {
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

  it('老条目返回 null', () => {
    expect(readSnippetPayload({ graphs: [] })).toBeNull()
  })

  it('classes 中的非字符串元素被剔除，其余按原顺序保留', () => {
    const payload = readSnippetPayload({
      form: 'snippet',
      t3d: T3D,
      meta: { classes: ['Event', 42, { name: 'x' }, 'Branch'] }
    })
    expect(payload?.meta.classes).toEqual(['Event', 'Branch'])
  })

  it('openPorts 只剔除非对象元素，不按字段类型过滤', () => {
    // 字段类型不对的元素可能仍对应真实的悬空端口，剔除会让回执少报
    const malformed = { nodeId: 5, pinName: 'then', dir: 'out', formerPeer: 'x.y' }
    const payload = readSnippetPayload({
      form: 'snippet',
      t3d: T3D,
      meta: { openPorts: [null, 7, malformed] }
    })
    expect(payload?.meta.openPorts).toEqual([malformed])
  })
})
