/**
 * 把扁平的过程时间线里属于 `task`（子 agent）的那些条目，按 **toolCallId**
 * 收成一条条「泳道」。
 *
 * 为什么要有这一层：`task` 声明为 `concurrency: 'parallel'`，模型一轮里可以同时
 * 派出好几路子 agent。它们的进度是交替到达的，而进度行本身长得一模一样
 * （都是「子任务：调用 xxx」）—— 铺在一根时间线上，用户看到的是一串自相矛盾的
 * 状态行，根本分不出有几路在跑、各自跑到哪。主进程每条事件都带着 toolCallId，
 * 缺的一直是界面这边按它分组。
 *
 * 分组只认 toolCallId。老消息（这个字段还没透传时存下来的）对不上号，
 * 会原样退回扁平渲染 —— 显示得不如现在好，但不会错。
 */

import type { AgentProcessItem } from './AgentProcessLog.types'
import {
  getToolArgs,
  getToolName,
  normalizeToolName,
  parseStructuredValue
} from './agentToolCallData'

/**
 * 起子 agent 的工具。`task` 是普通子任务；`team_send` 是工作室模式里派给队员的活，
 * `team_deliver` 是独立验收员在玩 —— 三者都是「另一个 agent 在底下干活」，泳道一样画。
 */
const SUBTASK_TOOL_NAMES = new Set(['task', 'team_send', 'team_deliver'])

/**
 * 进度行在扁平时间线上带着说话人前缀（`子任务：调用 xxx`）——
 * 没有它，混在主时间线里的那行没人知道是谁在说。
 * 进了泳道卡片就成了重复：卡片本身就是那一路。
 */
const SPEAKER_PREFIX = /^(子任务|团队|验收)\s*[：:]\s*/

/** 标题太长会把卡片撑成一段话。完整 prompt 点开卡片就能看 */
const TITLE_MAX_LENGTH = 90

/**
 * 整行被括起来的那种说明，不是任务本身。
 *
 * 真机上撞到的：模型给三路子任务写的 prompt，第一行都是同一句
 * 「【这是纯只读的评审任务，你的产出是一份文字报告…】」—— 那是给子 agent
 * 的框架交代，三张卡因此长得一模一样，用户看不到各自到底在干什么。
 * 取标题时跳过这种行，往下找第一句说人话的。
 */
const FRAMING_LINE = /^[【[(（「《][\s\S]*[】\])）」》]$/

/** 行首的 Markdown 标记（`## `、`- `、`> `）。标题只要那句话，不要标记 */
const MARKER_PREFIX = /^[#>\-*+\s]+/

/**
 * 短到这个程度的行说不清任何事（「任务」「目标」「---」），继续往下找。
 * 四个字是下限：「盘点模型」这种真任务就到这个长度。
 */
const MIN_TITLE_LENGTH = 4

/** 结论也只取一句，完整结果仍然在模型正文里 */
const SUMMARY_MAX_LENGTH = 120

export type SubtaskStatus = 'running' | 'success' | 'failed'

export interface SubtaskLane {
  /** 这一路的身份。主进程的 toolCallId，全局唯一 */
  callId: string
  /** 第几路，从 1 开始。并排跑的时候用户要能一眼分清哪条是哪条 */
  index: number
  /** 卡片上那一行标题：prompt 里第一句说清这一路要干什么的话 */
  title: string
  /**
   * 派给这一路的完整 prompt。
   *
   * 标题只能放一行，而模型写的任务书往往是一整段（约束、验收标准、不许动什么）。
   * 用户要核对「到底派出去的是什么」时，看的就是这一份 —— 点开卡片才显示。
   */
  prompt: string
  status: SubtaskStatus
  startedAt: number
  /** 跑完的时刻。还在跑就没有 */
  endedAt?: number
  /** 最近一条进度，例如「调用 ue_get_actor」 */
  latest: string
  /** 收到过多少条进度 ≈ 子 agent 走了几步 */
  steps: number
  /** 跑完之后的一句话结论 */
  summary: string
}

export interface SubtaskView {
  /** 按派出顺序排列的所有泳道 */
  lanes: SubtaskLane[]
  /** 时间线下标 → 该位置要渲染的泳道（即派出去的那一刻，卡片就长在这里） */
  laneAt: Map<number, SubtaskLane>
  /** 已经被泳道吸收、不该再单独成行的时间线下标 */
  absorbed: Set<number>
}

/** 工具调用条目存的是 `id`（OpenAI 形状），进度和结果条目存的是 `toolCallId` */
function readCallId(item: AgentProcessItem): string {
  const data = (item.data ?? {}) as Record<string, unknown>
  const raw = item.type === 'tool-call' ? (data.id ?? data.toolCallId) : data.toolCallId
  return typeof raw === 'string' && raw.trim() ? raw : ''
}

function firstLine(text: string, maxLength: number): string {
  const normalized = text.trim().split('\n')[0].trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

/**
 * 卡片上那一行标题：prompt 里第一句真正在说这一路要干什么的话。
 *
 * 一律取首行是不够的 —— 模型习惯把同一段框架交代写在每一路的开头，
 * 那样几张卡的标题会完全一样。跳过整行括起来的说明和只有标记的行；
 * 全都跳完了（整段 prompt 就是一句框架说明）就退回首行，总比空着强。
 */
export function pickTitleLine(prompt: string): string {
  const lines = prompt.split('\n').map((line) => line.replace(MARKER_PREFIX, '').trim())
  const substantive = lines.find(
    (line) => line.length >= MIN_TITLE_LENGTH && !FRAMING_LINE.test(line)
  )
  return firstLine(substantive || lines.find(Boolean) || prompt, TITLE_MAX_LENGTH)
}

/**
 * 派给这一路的话。三个工具的参数形状不一样：
 * `task` 是 `{ prompt }`，`team_send` 是 `{ to, message }`，`team_deliver` 是 `{ report, how_to_play }`。
 */
function readPrompt(toolName: string, args: unknown): string {
  const parsed = parseStructuredValue(args)
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  if (toolName === 'team_send') return text(parsed?.message)
  if (toolName === 'team_deliver') {
    return [text(parsed?.report), text(parsed?.how_to_play)].filter(Boolean).join('\n\n')
  }
  return text(parsed?.prompt)
}

/** 卡片标题。队员那一路标上是谁在干，验收那一路直接说是验收 */
function laneTitle(toolName: string, args: unknown, prompt: string): string {
  if (toolName === 'team_deliver') return '交付验收'
  if (toolName === 'team_send') {
    const to = parseStructuredValue(args)?.to
    const who = typeof to === 'string' && to.trim() ? to.trim() : ''
    const line = pickTitleLine(prompt)
    return who ? firstLine(`${who}：${line}`, TITLE_MAX_LENGTH) : line
  }
  return pickTitleLine(prompt)
}

/**
 * 子 agent 的结论。`task` 的结果形状是 `{ text, messageCount }`
 * （见主进程 `SubAgentResult`），失败时是工具通用的 `{ success: false, error }`。
 */
function readSummary(result: unknown): string {
  const structured = parseStructuredValue(result)
  if (!structured) {
    return typeof result === 'string' ? firstLine(result, SUMMARY_MAX_LENGTH) : ''
  }
  const candidate = structured.error ?? structured.text ?? structured.message
  return typeof candidate === 'string' ? firstLine(candidate, SUMMARY_MAX_LENGTH) : ''
}

function readProgress(item: AgentProcessItem): string {
  const message = String((item.data as Record<string, unknown> | undefined)?.message ?? '')
  return firstLine(message.replace(SPEAKER_PREFIX, ''), SUMMARY_MAX_LENGTH)
}

export function buildSubtaskView(items: readonly AgentProcessItem[]): SubtaskView {
  const lanes: SubtaskLane[] = []
  const laneAt = new Map<number, SubtaskLane>()
  const absorbed = new Set<number>()
  const byCallId = new Map<string, SubtaskLane>()

  items.forEach((item, index) => {
    const callId = readCallId(item)
    if (!callId) return

    if (item.type === 'tool-call') {
      const data = (item.data ?? {}) as Record<string, unknown>
      const toolName = normalizeToolName(getToolName(data))
      if (!SUBTASK_TOOL_NAMES.has(toolName)) return
      // 同一个 toolCallId 只开一条泳道：断线重连时同一条事件可能补发
      if (byCallId.has(callId)) {
        absorbed.add(index)
        return
      }

      const args = getToolArgs(data)
      const prompt = readPrompt(toolName, args)
      const lane: SubtaskLane = {
        callId,
        index: lanes.length + 1,
        title: laneTitle(toolName, args, prompt),
        prompt,
        status: 'running',
        startedAt: item.timestamp,
        latest: '',
        steps: 0,
        summary: ''
      }
      lanes.push(lane)
      byCallId.set(callId, lane)
      laneAt.set(index, lane)
      absorbed.add(index)
      return
    }

    const lane = byCallId.get(callId)
    if (!lane) return

    if (item.type === 'notify-users') {
      const text = readProgress(item)
      if (!text) return
      lane.latest = text
      lane.steps += 1
      absorbed.add(index)
      return
    }

    if (item.type === 'tool-result') {
      const data = (item.data ?? {}) as Record<string, unknown>
      const structured = parseStructuredValue(data.result)
      lane.status = data.isError === true || structured?.success === false ? 'failed' : 'success'
      lane.endedAt = item.timestamp
      lane.summary = readSummary(data.result)
      absorbed.add(index)
    }
  })

  return { lanes, laneAt, absorbed }
}

/** 此刻同时在跑的路数。等于 2 就是用户看到的「两路并行」 */
export function countRunningLanes(lanes: readonly SubtaskLane[]): number {
  return lanes.filter((lane) => lane.status === 'running').length
}
