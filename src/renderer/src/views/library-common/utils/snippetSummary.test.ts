import { describe, expect, it } from 'vitest'

import { summarizeSnippet } from './snippetSummary'
import { readSnippetPayload } from '@core/shared/snippetPayload'

const T3D = 'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="E0"\nEnd Object'

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
