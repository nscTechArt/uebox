/**
 * 工具流式进度在过程时间线上怎么记。
 *
 * 大多数工具推的进度是**快照**：shell 每次把累积输出的尾巴（几十 KB）整份再推一遍，
 * 界面也只画最新那条（`agentSteps.ts` 里 `owner.progress` 是覆盖写）。照样一条条
 * 追加的话，一条跑八分钟的 `findstr` 能在一条消息里堆出一千八百份、九十多 MB，
 * 对话历史文件随之涨过 Chromium 单条 IPC 消息的上限（256 MB），盒子启动读历史
 * 时主进程直接崩掉，连窗口都不出。
 *
 * 子 agent 那几个工具例外：它们的进度是**事件**（「子任务：调用 xxx」），泳道要
 * 一条条画出来，不能合并。
 */

/**
 * 起子 agent 的工具。`task` 是普通子任务；`team_send` 是工作室模式里派给队员的活，
 * `team_deliver` 是独立验收员在玩 —— 三者都是「另一个 agent 在底下干活」，泳道一样画。
 */
export const SUBTASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task',
  'team_send',
  'team_deliver'
])

interface ProcessItemLike {
  type: string
  data?: unknown
}

/** 这条是不是「只留最新一份」的工具进度；是的话返回它属于哪次工具调用 */
function snapshotProgressCallId(item: ProcessItemLike): string | undefined {
  if (item.type !== 'notify-users') return undefined
  const data = (item.data ?? {}) as Record<string, unknown>
  if (data.notifyType !== 'progress') return undefined
  if (typeof data.toolCallId !== 'string' || !data.toolCallId) return undefined
  if (typeof data.toolName === 'string' && SUBTASK_TOOL_NAMES.has(data.toolName)) return undefined
  return data.toolCallId
}

/**
 * 新来的 `item` 该顶掉时间线上的哪一条。返回 -1 表示照常追加。
 *
 * 顶掉的是同一次工具调用的上一份进度，位置不动 —— 它本来就紧跟在那次调用后面。
 */
export function findReplaceableProgress(
  items: readonly ProcessItemLike[],
  item: ProcessItemLike
): number {
  const callId = snapshotProgressCallId(item)
  if (!callId) return -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (snapshotProgressCallId(items[i]) === callId) return i
  }
  return -1
}

/** 已经堆起来的时间线收拢成每次工具调用只留最新一份进度。没有可收的返回原数组 */
export function compactProgress<T extends ProcessItemLike>(items: readonly T[]): readonly T[] {
  const latest = new Map<string, number>()
  items.forEach((item, i) => {
    const callId = snapshotProgressCallId(item)
    if (callId) latest.set(callId, i)
  })
  let dropped = false
  const kept: T[] = []
  const placed = new Set<string>()
  items.forEach((item) => {
    const callId = snapshotProgressCallId(item)
    if (!callId) {
      kept.push(item)
      return
    }
    // 留在第一份的位置上，内容换成最后一份
    if (placed.has(callId)) {
      dropped = true
      return
    }
    placed.add(callId)
    kept.push(items[latest.get(callId)!])
  })
  return dropped ? kept : items
}
