import { createHash } from 'node:crypto'
import type { Context, Model, Api } from '@earendil-works/pi-ai'

/**
 * 与 pi-ai 0.84.3 的实际序列化一致：Responses 的原生加载、Kimi 把新增定义放在历史中；
 * 其他适配器仍改变 tools 前缀。Anthropic 即使用 tool_reference，也会发送 defer_loading
 * 的工具定义，不能把它误报为「前缀零变化」。此键只管理缓存亲和性，不是权限边界。
 */
export function toolSearchPrefixKey(model: Model<Api>, context: Context): string {
  const compat = model.compat as
    | {
        supportsAdditionalTools?: boolean
        supportsToolSearch?: boolean
        deferredToolsMode?: string
      }
    | undefined
  const transcriptLoading =
    ((model.api === 'openai-responses' || model.api === 'openai-codex-responses') &&
      (compat?.supportsAdditionalTools || compat?.supportsToolSearch)) ||
    (model.api === 'openai-completions' && compat?.deferredToolsMode === 'kimi')
  const deferred = new Set<string>()
  if (transcriptLoading) {
    const used = new Set<string>()
    for (const message of context.messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) if (block.type === 'toolCall') used.add(block.name)
      } else if (message.role === 'toolResult') {
        for (const name of message.addedToolNames ?? []) {
          if (compat?.deferredToolsMode === 'kimi' || !used.has(name)) deferred.add(name)
        }
      }
    }
  }
  const hash = createHash('sha256')
  for (const tool of context.tools ?? []) {
    if (deferred.has(tool.name)) continue
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
