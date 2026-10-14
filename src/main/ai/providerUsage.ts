/**
 * 删服务商之前问一句：还有几个正在跑的对话在用它。
 *
 * 跑着的对话开跑时就把模型定下了，中途删掉服务商，它下一次调模型才发现密钥没了。
 * 设置页据此在确认框里提醒一句。
 *
 * 由对话宿主（`ipc/agentV3.ts`）注册进来，这边不反过来 import 它 —— 那会把整个
 * Agent 宿主拉进 AI 配置模块。没注册时按 0 算。
 */

type UsageProbe = (providerId: string) => Promise<number>

let probe: UsageProbe | null = null

export function setProviderUsageProbe(next: UsageProbe): void {
  probe = next
}

export async function countRunsUsingProvider(providerId: string): Promise<number> {
  if (!probe) return 0
  try {
    return await probe(providerId)
  } catch (error) {
    console.warn('[AI Provider] 统计在用的对话失败:', error)
    return 0
  }
}
