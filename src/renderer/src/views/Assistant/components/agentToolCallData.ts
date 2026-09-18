/**
 * 过程时间线里「工具调用 / 工具结果」那两类条目的读法。
 *
 * 单独成文件是因为**不止一处要读它们**：过程日志组件要渲染，子任务泳道
 * （`agentSubtasks.ts`）要按 toolCallId 把并行的几路对上号。各读各的话，
 * 两边对「工具名存在哪个字段」的理解迟早会漂。
 */

export function normalizeToolName(name: string): string {
  const trimmed = name.trim()
  const bracketMatch = trimmed.match(/^\[(.+)\]$/)
  return bracketMatch ? bracketMatch[1].trim() : trimmed
}

/**
 * 从工具调用数据中提取工具名称
 * 支持两种格式：
 * 1. { function: { name, arguments } } - OpenAI 格式
 * 2. { name, args } - Vercel AI SDK 格式
 */
export function getToolName(data: Record<string, unknown>): string {
  // OpenAI 格式
  if (data.function && typeof data.function === 'object') {
    return ((data.function as Record<string, unknown>).name as string) || ''
  }
  // Vercel AI SDK 格式
  if (data.name && typeof data.name === 'string') {
    return data.name
  }
  return ''
}

/**
 * 从工具调用数据中提取工具参数
 * 支持两种格式：
 * 1. { function: { name, arguments } } - OpenAI 格式
 * 2. { name, args } - Vercel AI SDK 格式
 */
export function getToolArgs(data: Record<string, unknown>): unknown {
  // OpenAI 格式
  if (data.function && typeof data.function === 'object') {
    return (data.function as Record<string, unknown>).arguments
  }
  // Vercel AI SDK 格式
  if ('args' in data) {
    return data.args
  }
  return {}
}

export function parseStructuredValue(input: unknown): Record<string, unknown> | null {
  if (input === null || input === undefined) {
    return null
  }

  if (typeof input === 'string') {
    if (!input.trim()) return null
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  if (typeof input === 'object') {
    return input as Record<string, unknown>
  }

  return null
}
