import { describe, expect, it } from 'vitest'
import {
  normalizeContext,
  type Api,
  type Message,
  type Model,
  type Tool,
  type TranscriptContext
} from '@earendil-works/pi-ai'
import { toolSearchPrefixKey } from './toolSearchCache'

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object' as const, properties: {} }
})
const resident = tool('load_skill')
const material = tool('material_get_graph')

const head: Message = { role: 'system', content: 'prompt', toolsAdded: [resident], timestamp: 0 }
const loadResult: Message = {
  role: 'toolResult',
  toolCallId: 'load',
  toolName: 'load_skill',
  content: [{ type: 'text', text: 'loaded' }],
  isError: false,
  timestamp: 1
}
const transcript = (messages: Message[]): TranscriptContext => normalizeContext({ messages })
const initial = transcript([head])
/** pi 1.0 的循环在工具清单变了之后插一条增量 system 消息 */
const loaded = transcript([
  head,
  loadResult,
  { role: 'system', content: '', toolsAdded: [material], timestamp: 2 }
])
/** 同一份工具清单，但已经合并进开头那条（压缩后、或者新一轮重建的样子） */
const collapsed = transcript([{ ...head, toolsAdded: [resident, material] }, loadResult])
const model = (api: Api, compat = {}): Model<Api> => ({ api, compat }) as Model<Api>

describe('Beta 工具前缀缓存键', () => {
  it('默认把工具合到顶层：加载新工具换键，同一份清单不管怎么摆都同键', () => {
    const fallback = model('openai-completions')
    const first = toolSearchPrefixKey(fallback, initial)
    const next = toolSearchPrefixKey(fallback, loaded)
    expect(first).not.toBe(next)
    expect(toolSearchPrefixKey(fallback, collapsed)).toBe(next)
    // 顺序和定义变了都算前缀变了
    expect(
      toolSearchPrefixKey(fallback, transcript([{ ...head, toolsAdded: [material, resident] }]))
    ).not.toBe(next)
    expect(
      toolSearchPrefixKey(
        fallback,
        transcript([{ ...head, toolsAdded: [resident, { ...material, description: 'new notes' }] }])
      )
    ).not.toBe(next)
  })

  it('能把新工具锚在对话中间的接口：加载不换键；合并回顶层后才换', () => {
    for (const native of [
      model('openai-responses', { supportsToolSearch: true }),
      model('openai-codex-responses', { supportsAdditionalTools: true }),
      model('openai-completions', {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolAdditions: true
      })
    ]) {
      expect(toolSearchPrefixKey(native, loaded)).toBe(toolSearchPrefixKey(native, initial))
      expect(toolSearchPrefixKey(native, collapsed)).not.toBe(toolSearchPrefixKey(native, initial))
    }
  })

  it('中途撤过工具，锚定接口也退回全量顶层', () => {
    const native = model('openai-responses', { supportsToolSearch: true })
    const removed = transcript([
      ...loaded.messages,
      { role: 'system', content: '', toolsRemoved: [{ name: material.name }], timestamp: 3 }
    ])
    expect(toolSearchPrefixKey(native, removed)).toBe(
      toolSearchPrefixKey(model('openai-completions'), initial)
    )
  })

  it('Anthropic 的延迟定义仍在 tools 数组里，不能宣称前缀不变', () => {
    const anthropic = model('anthropic-messages', {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true
    })
    expect(toolSearchPrefixKey(anthropic, initial)).not.toBe(toolSearchPrefixKey(anthropic, loaded))
  })
})
