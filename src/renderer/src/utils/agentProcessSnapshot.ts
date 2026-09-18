import { toRaw } from 'vue'
import type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'

/**
 * 给消息历史一份与实时流完全脱钩的过程快照。
 *
 * 只复制数组外壳不够：Vue 会复用里面的响应式对象，实时流随后追加一个 token，
 * 历史消息也会被同一个对象带着变化，进而绕过界面和持久化的节流。
 * 过程条目本来就要落 JSON，这里按最终存储语义做一次深拷贝最稳妥。
 */
export function snapshotAgentProcess(items: AgentProcessItem[]): AgentProcessItem[] {
  return JSON.parse(JSON.stringify(toRaw(items))) as AgentProcessItem[]
}
