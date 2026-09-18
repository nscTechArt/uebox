import { describe, expect, it } from 'vitest'
import type { Api, Context, Model, Tool } from '@earendil-works/pi-ai'
import { toolSearchPrefixKey } from './toolSearchCache'

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object' as const, properties: {} }
})
const resident = tool('load_skill')
const material = tool('material_get_graph')
const initial: Context = { messages: [], tools: [resident] }
const loaded: Context = {
  tools: [resident, material],
  messages: [
    {
      role: 'toolResult',
      toolCallId: 'load',
      toolName: 'load_skill',
      content: [{ type: 'text', text: 'loaded' }],
      details: {},
      isError: false,
      timestamp: 0,
      addedToolNames: [material.name]
    }
  ]
}
const model = (api: Api, compat = {}): Model<Api> => ({ api, compat }) as Model<Api>

describe('Beta 工具前缀缓存键', () => {
  it('普通前缀加载按实际定义和顺序换键，稳态复用；原生历史加载保持键', () => {
    const fallback = model('openai-completions')
    const first = toolSearchPrefixKey(fallback, initial)
    const next = toolSearchPrefixKey(fallback, loaded)
    expect(first).not.toBe(next)
    expect(toolSearchPrefixKey(fallback, { ...loaded, messages: [] })).toBe(next)
    expect(
      toolSearchPrefixKey(fallback, { ...loaded, tools: [...loaded.tools!].reverse() })
    ).not.toBe(next)
    expect(
      toolSearchPrefixKey(fallback, {
        ...loaded,
        tools: [resident, { ...material, description: 'new schema notes' }]
      })
    ).not.toBe(next)
    for (const native of [
      model('openai-responses', { supportsToolSearch: true }),
      model('openai-codex-responses', { supportsAdditionalTools: true }),
      model('openai-completions', { deferredToolsMode: 'kimi' })
    ]) {
      expect(toolSearchPrefixKey(native, initial)).toBe(toolSearchPrefixKey(native, loaded))
      // 压缩丢掉加载锚点后，pi 将其重新放回前缀，缓存键也须随之变化。
      expect(toolSearchPrefixKey(native, { ...loaded, messages: [] })).not.toBe(
        toolSearchPrefixKey(native, initial)
      )
    }
  })

  it('当前 Anthropic 适配器仍把延迟定义放在 tools 数组，不能宣称前缀不变', () => {
    const anthropic = model('anthropic-messages', { supportsToolReferences: true })
    expect(toolSearchPrefixKey(anthropic, initial)).not.toBe(toolSearchPrefixKey(anthropic, loaded))
  })
})
