/**
 * 队员用的是哪家模型 → 办公室里的小人长什么样（发色 + 一个标志配件，画法在 v2/drawV2.ts）。
 *
 * 只借通用元素（发色、耳朵、尾巴），不画各家 logo。认不出来的模型返回 undefined，
 * 小人照旧按名字挑发型。
 */

import type { TeamModel } from '@core/shared/agentTeam'

export type ModelLook =
  | 'claude'
  | 'gpt'
  | 'gemini'
  | 'grok'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'doubao'

export const MODEL_LOOKS: readonly ModelLook[] = [
  'claude',
  'gpt',
  'gemini',
  'grok',
  'deepseek',
  'qwen',
  'kimi',
  'glm',
  'minimax',
  'doubao'
]

// 按顺序认，先认名字更具体的
const RULES: [RegExp, ModelLook][] = [
  [/claude/, 'claude'],
  [/deepseek/, 'deepseek'],
  [/gemini|gemma/, 'gemini'],
  [/grok|x-?ai/, 'grok'],
  [/qwen|qwq|tongyi|dashscope/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/glm|zhipu|bigmodel/, 'glm'],
  [/minimax|abab/, 'minimax'],
  [/doubao|(^|\/)seed-/, 'doubao'],
  [/gpt|openai|chatgpt|(^|\/)o\d/, 'gpt']
]

/** 只看模型名：服务商常是兼容 OpenAI 的中转，看它会认错 */
export function modelLook(model: Pick<TeamModel, 'modelId'> | undefined): ModelLook | undefined {
  if (!model) return undefined
  const id = model.modelId.toLowerCase()
  return RULES.find(([re]) => re.test(id))?.[1]
}
