import { createHash } from 'node:crypto'
import {
  resolveTranscript,
  resolveTranscriptTools,
  type Api,
  type Model,
  type TranscriptContext
} from '@earendil-works/pi-ai'

/**
 * 请求顶层 tools 字段的指纹，用来给厂商缓存亲和键分代。此键只管理缓存亲和性，不是权限边界。
 *
 * pi-ai 1.0 起工具清单写在 transcript 的 system 消息里（见 `systemMessages.ts`），发给厂商时
 * 怎么摆由适配器决定。这里照 pi-ai 1.0.0 的做法算出「顶层那份」：
 * - 默认把 system 消息合成一条，顶层是当前全部工具 —— 加载一批新工具就换键。
 * - Responses 开了 additional_tools / tool_search、Chat Completions 开了中途加工具（Kimi 那种），
 *   新工具锚在对话中间，顶层只剩开头那份 —— 加载新工具不换键。中途撤过工具则退回默认。
 * - Anthropic 原生中途换工具也会把新定义放进 tools 数组（defer_loading），保守起见按默认算。
 * 只看 `model.compat` 上显式写的开关；pi 按地址自动探测出来的不认，宁可多换一次键。
 */
export function toolSearchPrefixKey(model: Model<Api>, context: TranscriptContext): string {
  const compat = model.compat as
    | {
        supportsMidConvoSystemMessages?: boolean
        supportsMidConvoToolAdditions?: boolean
        supportsAdditionalTools?: boolean
        supportsToolSearch?: boolean
      }
    | undefined
  const midConvo = compat?.supportsMidConvoSystemMessages === true
  const responses =
    model.api === 'openai-responses' ||
    model.api === 'openai-codex-responses' ||
    model.api === 'azure-openai-responses'
  const anchorsAdditions = responses
    ? compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true
    : model.api === 'openai-completions' &&
      midConvo &&
      compat?.supportsMidConvoToolAdditions === true
  // Responses 系拿原始 transcript 算顶层工具，Chat Completions 拿合并过的那份（照 pi-ai 1.0.0）
  const { messages } = responses ? context : resolveTranscript(context, midConvo)
  const { requestTools } = resolveTranscriptTools(messages, anchorsAdditions)

  const hash = createHash('sha256')
  for (const tool of requestTools) {
    hash.update(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })
    )
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
