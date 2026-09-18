/**
 * `input.map` 返回的类型，以及把它读成一句结论的纯函数。
 *
 * ## 为什么单独一个文件
 *
 * `inputMap.ts` 静态 import 了 `services`，那条链最终会拖进
 * `better-sqlite3` 的原生模块 —— 测试里一碰就是整个 vitest 进程段错误
 * （AGENTS §7 记过这个坑）。摘要逻辑是纯函数，放这里就能直接测。
 */

import type { WorldScopedResponse } from '../../worldScope'

export interface BehaviourJson {
  type: string
  params?: Record<string, number | boolean>
}

export interface ActionJson {
  name: string
  path: string
  value_type: string
  keys: Array<{ key: string; triggers?: BehaviourJson[]; modifiers?: BehaviourJson[] }>
  triggers?: BehaviourJson[]
  modifiers?: BehaviourJson[]
}

export interface InputMapResponse extends WorldScopedResponse {
  ok: boolean
  source: 'runtime' | 'asset'
  source_note: string
  input_system: 'enhanced' | 'legacy' | 'both' | 'none'
  contexts: Array<{ path: string; name: string; priority?: number }>
  actions: ActionJson[]
  action_count: number
  legacy_actions?: Array<{ name: string; keys: string[] }>
  legacy_axes?: Array<{ name: string; keys: Array<{ key: string; scale: number }> }>
  contexts_read_from?: string
  contexts_truncated?: boolean
  contexts_limit?: number
  runtime_error?: string
}

/**
 * 把报告读成一句结论。
 *
 * 和 `ue_playtest` 的 summarize 同一个理由：模型不一定逐条看数组，
 * 而「这张表是此刻真实生效的还是工程里定义的」直接决定结论对不对。
 */
export function summarizeInputMap(response: InputMapResponse): string {
  const parts: string[] = []

  if (response.source === 'runtime') {
    parts.push('游戏正在运行，以下是**此刻真实生效**的输入映射')
    parts.push(`挂着 ${response.contexts.length} 个输入上下文`)
  } else {
    parts.push('游戏没在运行，以下是**工程里定义**的映射')
  }

  const systemLabel = {
    enhanced: 'Enhanced Input',
    legacy: '旧输入系统（Action/Axis Mapping）',
    both: 'Enhanced Input + 旧输入系统并存',
    none: '没找到任何输入配置'
  }[response.input_system]
  parts.push(`输入系统：${systemLabel}`)

  if (response.input_system === 'legacy') {
    // 这类工程（5.0–5.3 起步的居多）没有「动作层」，注入只能走按键。
    // 不点破的话模型会一直找 IA 资产，找不到就说这个工程没配输入
    parts.push('**这个工程没有 Enhanced Input 动作**，只能按键位操作')
  }

  if (response.action_count > 0) {
    parts.push(`${response.action_count} 个动作`)
  }

  if (response.runtime_error) {
    parts.push(`⚠️ ${response.runtime_error}`)
  }

  if (response.contexts_truncated) {
    // 截断不说出来，模型会以为剩下那些绑定不存在
    parts.push(
      `⚠️ 工程里的输入上下文超过 ${response.contexts_limit} 个，只列了前 ${response.contexts_limit} 个`
    )
  }

  return parts.join('；')
}

/**
 * 注入前的层次校验：`action` 和 `key` 必须**恰好给一个**。
 *
 * 两个都给或都不给时不猜。猜错的后果不是「跑不动」，是**结论错得看不出来**：
 * 调用方想验键位，我们替它选了动作层，它拿到一个成功的返回，
 * 于是以为键位正常 —— 而真相可能是那个键根本没绑（设计文档 §4）。
 *
 * @returns 错误文案；两者恰好给一个时返回 null
 */
export function checkInjectLayer(action?: string, key?: string): string | null {
  const hasAction = typeof action === 'string' && action.length > 0
  const hasKey = typeof key === 'string' && key.length > 0
  if (hasAction && hasKey) {
    return 'action 和 key 只能给一个：给 action 是验逻辑（绕开键位），给 key 是验键位（走真人路径）。'
  }
  if (!hasAction && !hasKey) {
    return '要么给 action（验逻辑），要么给 key（验键位）。用 ue_input_map 查有哪些。'
  }
  return null
}
