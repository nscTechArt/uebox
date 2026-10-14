/**
 * 把一段过程（几轮推理 + 一串工具调用）读成「一行一步」。
 *
 * 过程日志原来是一条事件一行：调用一行、结果一行、进度又一行，结果那行还把
 * 工具返回给模型的原文整句贴出来（「上面的分布是全量精确统计…可以直接照着
 * 回答用户」）。那是写给模型的话，用户读不懂也不需要。
 *
 * 这里按**一次工具调用一行**收拢：调用和它的结果、它的流式进度合成一步，
 * 行上只留「做了什么、对什么做、结果一句话」；参数和返回原文放进这一步的
 * 展开区，排查时才看。
 *
 * 纯函数、不碰 i18n：工具名翻成人话、拼摘要那一句由组件做，这里只出数据。
 */
import { readFileChange, type FileChange } from '../../../../../shared/fileChange'
import { oneLine, pickStepTarget, STEP_TARGET_MAX_LENGTH } from '../../../../../shared/stepTarget'
import type { AgentProcessItem } from './AgentProcessLog.types'
import { buildSubtaskView, type SubtaskLane } from './agentSubtasks'
import {
  getToolArgs,
  getToolName,
  normalizeToolName,
  parseStructuredValue
} from './agentToolCallData'
import {
  findResultImageUrls,
  findResultPeekImageUrls,
  findResultVideoUrls,
  isDeliverableImageTool
} from './agentToolMedia'

/** 一段过程由什么拼成：推理和工具调用按发生顺序交替 */
export type StepPart =
  | { kind: 'thinking'; key: string; text: string; at?: number }
  | { kind: 'process'; key: string; items: AgentProcessItem[] }

export type ToolStepStatus = 'running' | 'done' | 'failed'

export interface ToolStepRow {
  kind: 'tool'
  key: string
  toolName: string
  /** 对什么做的：搜的词、读的路径、建的资产。说不出来就是空串 */
  target: string
  status: ToolStepStatus
  /** 结果里明确给出的数量（`count` / `total`）。没有就不编 */
  count?: number
  /** 失败原因的第一句 */
  error?: string
  /** 跑着的时候它最近报的一句进度 */
  progress: string
  /** 展开区里的参数原文 */
  argsText: string
  /** 展开区里的返回原文 */
  resultText: string
  /** 产出的、要直接给人看的图（见 `isDeliverableImageTool`） */
  images: string[]
  /** agent 自己看的图：截图、预览、读到的图片。收在展开区 */
  viewedImages: string[]
  videos: string[]
  fileChange?: FileChange
  fileChangeUnavailable: boolean
  startedAt: number
  endedAt?: number
}

export interface ThinkingStepRow {
  kind: 'thinking'
  key: string
  text: string
}

export interface NoteStepRow {
  kind: 'note'
  key: string
  text: string
  tone: 'info' | 'success' | 'warning'
}

export interface SubtaskStepRow {
  kind: 'subtask'
  key: string
  lane: SubtaskLane
}

export type StepRow = ToolStepRow | ThinkingStepRow | NoteStepRow | SubtaskStepRow

export interface StepGroupView {
  rows: StepRow[]
  /** 每种工具调了几次，按第一次出现的顺序 */
  toolCounts: Array<{ toolName: string; count: number }>
  toolCount: number
  failedCount: number
  viewedImageCount: number
  fileChangeCount: number
  /** 这段过程里所有该直接给人看的图，按产出顺序 */
  deliverableImages: string[]
  videos: string[]
  startedAt?: number
  endedAt?: number
}

/**
 * 不上行的工具。
 *
 * `done` 是内核收尾的信号，`ask_user` 自己就是时间线上的一张卡片 ——
 * 再各占一行就是同一件事说两遍。失败的 `done` 例外，见 `buildStepGroup`。
 * `update_plan` / `wrap_up` 同理：清单和收尾提问各有自己的位置（`agentTurnReport.ts`）。
 */
const HIDDEN_TOOLS = new Set(['done', 'ask_user', 'update_plan', 'wrap_up'])

const ERROR_MAX_LENGTH = 80
const ARGS_MAX_LENGTH = 4000
const RESULT_MAX_LENGTH = 6000

/** 结果里明确说了「几个」的字段 */
const COUNT_KEYS = ['count', 'total', 'totalCount', 'total_count'] as const

function clip(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text
}

export function readStepTarget(args: unknown): string {
  const parsed = parseStructuredValue(args)
  if (!parsed) return typeof args === 'string' ? oneLine(args, STEP_TARGET_MAX_LENGTH) : ''
  return pickStepTarget(parsed)
}

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  const parsed = parseStructuredValue(args)
  if (parsed) return Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : ''
  return String(args)
}

function formatResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') {
    const parsed = parseStructuredValue(result)
    if (!parsed) return result
    result = parsed
  }
  const structured = result as Record<string, unknown>
  for (const key of ['error', 'message', 'text'] as const) {
    const value = structured[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  try {
    return JSON.stringify(structured, null, 2)
  } catch {
    return String(result)
  }
}

function readCount(structured: Record<string, unknown> | null): number | undefined {
  if (!structured) return undefined
  for (const key of COUNT_KEYS) {
    const value = structured[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function readError(result: unknown, structured: Record<string, unknown> | null): string {
  const raw =
    typeof structured?.error === 'string'
      ? structured.error
      : typeof structured?.message === 'string'
        ? structured.message
        : typeof result === 'string'
          ? result
          : ''
  return oneLine(raw, ERROR_MAX_LENGTH)
}

/** 工具调用条目存的是 `id`（OpenAI 形状），进度和结果条目存的是 `toolCallId` */
function readCallId(item: AgentProcessItem): string {
  const data = (item.data ?? {}) as Record<string, unknown>
  const raw = item.type === 'tool-call' ? (data.id ?? data.toolCallId) : data.toolCallId
  return typeof raw === 'string' && raw.trim() ? raw : ''
}

function readResultToolName(item: AgentProcessItem): string {
  const data = (item.data ?? {}) as Record<string, unknown>
  return typeof data.toolName === 'string' && data.toolName
    ? data.toolName
    : getToolName(data as Record<string, unknown>)
}

function newToolRow(key: string, toolName: string, args: unknown, at: number): ToolStepRow {
  return {
    kind: 'tool',
    key,
    toolName: normalizeToolName(toolName),
    target: readStepTarget(args),
    status: 'running',
    progress: '',
    argsText: clip(formatArgs(args), ARGS_MAX_LENGTH),
    resultText: '',
    images: [],
    viewedImages: [],
    videos: [],
    fileChangeUnavailable: false,
    startedAt: at
  }
}

function applyResult(row: ToolStepRow, item: AgentProcessItem): void {
  const data = (item.data ?? {}) as Record<string, unknown>
  const result = data.result
  const structured = parseStructuredValue(result)
  const failed = data.isError === true || structured?.success === false

  row.status = failed ? 'failed' : 'done'
  row.endedAt = item.timestamp
  row.progress = ''
  row.resultText = clip(formatResult(result), RESULT_MAX_LENGTH)
  if (failed) row.error = readError(result, structured)
  else row.count = readCount(structured)

  const images = findResultImageUrls(result)
  if (isDeliverableImageTool(row.toolName)) row.images = images
  else row.viewedImages = images
  row.viewedImages = [...row.viewedImages, ...findResultPeekImageUrls(result)]
  // analyze_video 回带的是它看的那段视频（入参原样回来），不是产出
  row.videos = row.toolName === 'analyze_video' ? [] : findResultVideoUrls(result)
  row.fileChange = readFileChange(structured?.fileChange)
  row.fileChangeUnavailable = !!structured?.fileChangeUnavailable
}

function readNoteTone(notifyType: unknown): NoteStepRow['tone'] {
  if (notifyType === 'success') return 'success'
  if (notifyType === 'warning') return 'warning'
  return 'info'
}

function collectProcessRows(
  part: { key: string; items: AgentProcessItem[] },
  rows: StepRow[]
): void {
  const { laneAt, absorbed } = buildSubtaskView(part.items)
  const byCallId = new Map<string, ToolStepRow>()
  /** 老消息没有 toolCallId，按工具名先进先出对上号 */
  const openByName = new Map<string, ToolStepRow[]>()
  let lastNote = ''

  const takeOpen = (toolName: string): ToolStepRow | undefined => {
    const queue = openByName.get(toolName)
    return queue?.shift()
  }

  part.items.forEach((item, index) => {
    const lane = laneAt.get(index)
    if (lane) {
      rows.push({ kind: 'subtask', key: `${part.key}:subtask:${lane.callId}`, lane })
      lastNote = ''
      return
    }
    if (absorbed.has(index)) return

    if (item.type === 'tool-call') {
      const data = (item.data ?? {}) as Record<string, unknown>
      const toolName = normalizeToolName(getToolName(data))
      if (HIDDEN_TOOLS.has(toolName)) return
      const row = newToolRow(
        `${part.key}:tool:${index}`,
        toolName,
        getToolArgs(data),
        item.timestamp
      )
      rows.push(row)
      const callId = readCallId(item)
      if (callId) byCallId.set(callId, row)
      const queue = openByName.get(row.toolName) ?? []
      queue.push(row)
      openByName.set(row.toolName, queue)
      lastNote = ''
      return
    }

    if (item.type === 'tool-result') {
      const toolName = normalizeToolName(readResultToolName(item))
      const callId = readCallId(item)
      let row = callId ? byCallId.get(callId) : undefined
      if (row) {
        const queue = openByName.get(row.toolName)
        if (queue)
          openByName.set(
            row.toolName,
            queue.filter((open) => open !== row)
          )
      } else {
        row = takeOpen(toolName)
      }

      if (!row) {
        const data = (item.data ?? {}) as Record<string, unknown>
        const structured = parseStructuredValue(data.result)
        const failed = data.isError === true || structured?.success === false
        // 收尾成功、反问卡片：本来就不上行。收尾失败要让人看见
        if (HIDDEN_TOOLS.has(toolName) && !(toolName === 'done' && failed)) return
        row = newToolRow(`${part.key}:tool:${index}`, toolName, undefined, item.timestamp)
        rows.push(row)
      }
      applyResult(row, item)
      lastNote = ''
      return
    }

    if (item.type === 'notify-users') {
      const data = (item.data ?? {}) as Record<string, unknown>
      if (data.notifyType === 'thinking') return
      const message = typeof data.message === 'string' ? data.message.trim() : ''
      if (!message) return

      // 工具自己报的流式进度挂到那一步上，不另起一行
      const callId = readCallId(item)
      const owner = callId ? byCallId.get(callId) : undefined
      if (owner && owner.status === 'running') {
        owner.progress = oneLine(message, STEP_TARGET_MAX_LENGTH * 2)
        return
      }

      if (message === lastNote) return
      lastNote = message
      rows.push({
        kind: 'note',
        key: `${part.key}:note:${index}`,
        text: message,
        tone: readNoteTone(data.notifyType)
      })
    }
  })
}

export function buildStepGroup(parts: readonly StepPart[]): StepGroupView {
  const rows: StepRow[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined

  const touch = (at: number | undefined): void => {
    if (typeof at !== 'number') return
    if (startedAt === undefined || at < startedAt) startedAt = at
    if (endedAt === undefined || at > endedAt) endedAt = at
  }

  for (const part of parts) {
    if (part.kind === 'thinking') {
      if (/\S/.test(part.text)) rows.push({ kind: 'thinking', key: part.key, text: part.text })
      touch(part.at)
      continue
    }
    collectProcessRows(part, rows)
    for (const item of part.items) touch(item.timestamp)
  }

  const toolCounts: StepGroupView['toolCounts'] = []
  const countIndex = new Map<string, number>()
  let toolCount = 0
  let failedCount = 0
  let viewedImageCount = 0
  const changedFiles = new Set<string>()
  const deliverableImages: string[] = []
  const videos: string[] = []

  for (const row of rows) {
    // 子任务失败也是这一组出的错：只数工具的话，整组都是子任务时摘要行看不出有失败
    if (row.kind === 'subtask' && row.lane.status === 'failed') failedCount += 1
    if (row.kind !== 'tool') continue
    toolCount += 1
    if (row.status === 'failed') failedCount += 1
    viewedImageCount += row.viewedImages.length
    if (row.fileChange) changedFiles.add(row.fileChange.path)
    for (const image of row.images)
      if (!deliverableImages.includes(image)) deliverableImages.push(image)
    for (const video of row.videos) if (!videos.includes(video)) videos.push(video)

    const at = countIndex.get(row.toolName)
    if (at === undefined) {
      countIndex.set(row.toolName, toolCounts.length)
      toolCounts.push({ toolName: row.toolName, count: 1 })
    } else {
      toolCounts[at].count += 1
    }
  }

  return {
    rows,
    toolCounts,
    toolCount,
    failedCount,
    viewedImageCount,
    fileChangeCount: changedFiles.size,
    deliverableImages,
    videos,
    startedAt,
    endedAt
  }
}
