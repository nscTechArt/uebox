/**
 * 子任务的写操作台账：调了哪个写工具、对着什么、做完没有。
 *
 * ## 为什么不只是计数
 *
 * 原来只有 `{ 工具名: 次数 }`，而且**只在子任务正常结束时**才回给父 agent。
 * 2026-09-24 的用户反馈里，一个子任务被停下，父 agent 只拿到那句
 * 「不代表它没执行，先回读现场」—— 该回读什么没人知道。它最后搜了 55 项资产、
 * 读了两个蓝图概览、AnimGraph 和 CDO，才确认独立骨架、网格、三个蒙太奇
 * 和 Slot 早就落地了，差一点按「什么都没做」重建一遍。
 *
 * 所以台账要：
 *
 *   - 记**对象**，不只是工具名 —— 「material_apply ×8」没法回读，「→ BossA」可以
 *   - 把**在途**的单独列出来 —— 发出去了没等到回执的那条最可能已经生效又最容易被当成没发生
 *   - 在**被停下的那一刻**也能交出去，不依赖子任务正常收尾
 *
 * 对象是按参数名猜的（和界面的「本轮改动」同一套思路，见渲染层 `changeSummary.ts`
 * 的 `TARGET_KEYS`）。猜不出就只写工具名 —— 宁可少说，不编一个对象出来。
 */

/** 参数里代表「改的是谁」的键，按优先级 */
const TARGET_KEYS = [
  'blueprint_path',
  'material_path',
  'sequence_path',
  'asset_path',
  'target_path',
  'level_path',
  'level',
  'save_as',
  'output_path',
  'path',
  'actor_name',
  'name',
  'asset_id'
] as const

/** 一条对象描述的长度上限，防止把一段脚本或一大串路径塞进台账 */
const MAX_TARGET_CHARS = 120

/** 一个工具下面最多点几个对象名，其余只报数 */
const MAX_TARGETS_PER_TOOL = 5

function clip(text: string): string {
  return text.length > MAX_TARGET_CHARS ? `${text.slice(0, MAX_TARGET_CHARS - 1)}…` : text
}

function strings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (Array.isArray(value)) return value.flatMap((item) => strings(item))
  return []
}

/**
 * 从一次写工具调用的参数里认出它改的对象。
 *
 * 认的顺序：点名的单个对象（路径/名字）→ `targets.names / paths`（UE 的批量寻址）→
 * 顶层的 `paths / names` 数组 → 批量项里的 `output_path`（重定向、导出）。
 */
export function writeTarget(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>

  for (const key of TARGET_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return clip(value.trim())
  }

  const lists: string[] = []
  const targets = record.targets
  if (targets && typeof targets === 'object') {
    const t = targets as Record<string, unknown>
    lists.push(...strings(t.names), ...strings(t.paths))
  }
  if (lists.length === 0) lists.push(...strings(record.paths), ...strings(record.names))
  if (lists.length === 0 && Array.isArray(record.animations)) {
    for (const item of record.animations) {
      if (item && typeof item === 'object') {
        lists.push(...strings((item as Record<string, unknown>).output_path))
      }
    }
  }
  if (lists.length === 0) return undefined

  const head = lists.slice(0, 3).join('、')
  return clip(lists.length > 3 ? `${head} 等 ${lists.length} 个` : head)
}

export interface WriteEntry {
  tool: string
  target?: string
  /** in_flight = 发出去了还没等到结果 */
  state: 'in_flight' | 'done'
}

export class WriteLedger {
  /** 按调用顺序；Map 保留插入顺序 */
  private readonly entries = new Map<string, WriteEntry>()

  /** 写工具开始执行。这时还不知道它会不会真的跑（可能在等审批） */
  start(callId: string, tool: string, args: unknown): void {
    const target = writeTarget(args)
    this.entries.set(callId, { tool, ...(target ? { target } : {}), state: 'in_flight' })
  }

  /**
   * 写工具结束。报错的不进账 —— 和原来的计数同一条纪律：
   * 一次没成的改动被报成成了，正是这份台账要消灭的东西。
   */
  end(callId: string, ok: boolean): void {
    const entry = this.entries.get(callId)
    if (!entry) return
    if (ok) entry.state = 'done'
    else this.entries.delete(callId)
  }

  list(): WriteEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }

  /** 已完成的写操作按工具计数，保持原来 `writeToolCalls` 的形状 */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const entry of this.entries.values()) {
      if (entry.state === 'done') counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
    }
    return counts
  }
}

/** `material_apply ×8（BossA、BossB 等 3 个对象）` */
function summarize(entries: WriteEntry[]): string {
  const byTool = new Map<string, { count: number; targets: string[] }>()
  for (const entry of entries) {
    const slot = byTool.get(entry.tool) ?? { count: 0, targets: [] }
    slot.count++
    if (entry.target && !slot.targets.includes(entry.target)) slot.targets.push(entry.target)
    byTool.set(entry.tool, slot)
  }
  return [...byTool.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([tool, { count, targets }]) => {
      if (targets.length === 0) return `${tool} ×${count}`
      const shown = targets.slice(0, MAX_TARGETS_PER_TOOL).join('、')
      const more = targets.length > MAX_TARGETS_PER_TOOL ? ` 等 ${targets.length} 个对象` : ''
      return `${tool} ×${count}（${shown}${more}）`
    })
    .join('；')
}

/** 正常结束时那一行里的清单部分；没有写操作时返回空串 */
export function summarizeDoneWrites(entries: WriteEntry[]): string {
  return summarize(entries.filter((entry) => entry.state === 'done'))
}

/**
 * 子任务被停下时，交给父 agent 的那段话。
 *
 * 追加在 `ToolAbortedError` 那句「先回读现场」后面 —— 那句话本身是对的，
 * 这段补上的是「回读什么」。
 */
export function formatInterruptedWrites(entries: WriteEntry[], readOnly: boolean): string {
  if (readOnly) {
    return '\n\n【子任务停下前的写操作】无 —— 这一路以只读模式运行，写工具不在它的清单里。'
  }
  const done = entries.filter((entry) => entry.state === 'done')
  const inFlight = entries.filter((entry) => entry.state === 'in_flight')
  if (done.length === 0 && inFlight.length === 0) {
    return '\n\n【子任务停下前的写操作】无，它到停下为止只调用过只读工具。'
  }
  const lines = ['\n\n【子任务停下前的写操作】按对象回读这几项即可，不必把整个工程重查一遍：']
  if (done.length > 0) lines.push(`- 已完成（已经生效）：${summarize(done)}`)
  if (inFlight.length > 0) {
    lines.push(`- 在途（发出去了没等到结果，可能已生效，也可能还在等审批）：${summarize(inFlight)}`)
  }
  lines.push('确认之前不要按「没发生」重做，已有的资产不要重复创建。')
  return lines.join('\n')
}
