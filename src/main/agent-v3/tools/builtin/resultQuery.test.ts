/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createResultQueryTool } from './resultQuery'
import { toolSearchGroup } from './toolSearch'

const archived = {
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'search_assets',
  details: {
    archive: {
      ref: 'r2',
      lists: ['assets'],
      text: JSON.stringify({ assets: [{ name: 'SM_Rock', type: 'StaticMesh' }] })
    }
  }
}

function run(messages: unknown[], args: Record<string, unknown>): Promise<unknown> {
  const tool = createResultQueryTool({ getMessages: () => messages, isMutating: () => false })
  return tool.execute('call', args as never)
}

describe('result_query', () => {
  it('凭编号查到行，开头带快照说明', async () => {
    const result = (await run([archived], { ref: 'r2', where: { type: 'staticmesh' } })) as {
      content: Array<{ text: string }>
    }
    const body = JSON.parse(result.content[0].text) as { snapshot: string; rows: unknown[] }
    expect(body.rows).toEqual([{ name: 'SM_Rock', type: 'StaticMesh' }])
    expect(body.snapshot).toContain('search_assets')
  })

  it('编号不存在时列出这个对话里有哪些', async () => {
    await expect(run([archived], { ref: 'r9' })).rejects.toThrow(/r2/)
    await expect(run([], { ref: 'r1' })).rejects.toThrow(/还没有被存档的结果/)
  })

  it('编号在、数据不在时说数据不在，不说成没有这个编号', async () => {
    const lost = {
      role: 'toolResult',
      toolName: 'material_get_graph',
      details: { archive: { ref: 'r7', lists: ['nodes'], source: 'details' } }
    }
    await expect(run([lost], { ref: 'r7' })).rejects.toThrow(/r7 的数据已经不在/)
  })

  it('自成一组，不跟着 core 组一起加载', () => {
    expect(toolSearchGroup({ name: 'result_query', unrealBox: { namespace: 'core' } })).toBe(
      'core.result'
    )
  })
})
