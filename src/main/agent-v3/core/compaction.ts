/**
 * 上下文压缩。
 *
 * **质量优先**：默认全量喂，压缩是兜底不是常态。这与 V2 的取向相反 ——
 * V2 的 `ContextManager` / `MessageCompression` 为了省 token 一上来就裁剪历史，
 * 代价是模型丢失早期结论、反复重做已经做过的探测。
 *
 * 触发点见 `compactionThreshold`：窗口用满 85% 就压，小窗口下退回 pi 原来那条
 * 「窗口 - reserveTokens」。保留额度（reserveTokens）只负责摘要 prompt 和输出本身。
 *
 * 摘要**提前在后台写**：用到 60%（`PRECOMPACT_AT_RATIO`）就开始，到 85% 直接换上。
 * 原来是撞线那一刻当场写，把十几万 token 摘要一遍要好一阵，界面就停在那儿 ——
 * 真机上用户在做视频时插一句话，正好撞上，以为卡死了。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  getCurrentSystemMessage,
  type Message,
  type Model,
  type Models
} from '@earendil-works/pi-ai'

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  type CompactionSettings
} from '../vendor/pi-harness'
import { withoutSystemMessages } from './systemMessages'

/**
 * 压缩设置。
 *
 * `keepRecentTokens` 给得比 pi 默认更大：UE 工作流里最近几轮往往带着刚探测出来的
 * 资产路径和 node_id，摘要抹掉这些细节会让模型重新探一遍 —— 省下的 token
 * 会在重做里加倍还回去。
 */
export const UNREAL_BOX_COMPACTION: CompactionSettings = Object.freeze({
  ...DEFAULT_COMPACTION_SETTINGS,
  enabled: true,
  keepRecentTokens: Math.max(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, 24_000)
})

/**
 * 触发比例。用满多少就开压。
 *
 * 不用 pi 的 `shouldCompact`（它是「窗口 - reserveTokens」，1M 窗口要到 98.4%
 * 才动手）：那条线留给摘要 prompt 的余量是固定的 16K，窗口越大越贴边。真机上
 * 的失效方式是**一步跨过去** —— 70% 时塞两张截图就直接超窗，压缩根本没机会跑，
 * 拿到的是厂商的硬报错。
 *
 * 也**不能**靠把 `reserveTokens` 调大来提前触发：那个值同时决定摘要的
 * maxTokens（pi 取 0.8×），1M 窗口会算出 24 万的摘要上限。两个用途得分开。
 */
export const COMPACT_AT_RATIO = 0.85

/**
 * 用到多少开始在后台写摘要。
 *
 * 离 `COMPACT_AT_RATIO` 留 25 个点：摘要要写几十秒，这期间模型照常调工具，
 * 上下文还在涨。留得太窄，撞线时摘要还没好，又退回当场等。
 *
 * 当初把压缩线定在 70%，防的是「一步跨过去」—— 塞两张截图直接超窗，压缩没
 * 机会跑。线推到 85% 以后这个风险由后台摘要兜：到线时摘要多半已经写好，
 * 换上就是，不用再当场写。
 */
export const PRECOMPACT_AT_RATIO = 0.6

/**
 * 后台那份写好之后，摘要外的原文又涨了多少就再续写一份。
 *
 * 只在 60% 写一次的话，撞线换上时 60% 到 85% 之间长出来的那一大段全是原文：
 * 真机 1M 窗口的会话从 83 万只压到 41 万，900 多条消息原样留着。
 * 续写拿上一份摘要接着往下写，每次只喂新长出来的这一段，写得快，撞线时
 * 那份摘要离当下就差一小段。
 */
export function precompactionStep(contextWindow: number): number {
  return Math.max(UNREAL_BOX_COMPACTION.keepRecentTokens * 2, contextWindow * 0.05)
}

/**
 * 这个窗口下超过多少 token 就压。
 *
 * 取比例线和 pi 原来那条固定余量线里**更早的那个**：小窗口（8K、32K）下
 * 85% 反而比「窗口 - 16K」更晚，那时仍该按余量走，否则摘要 prompt 自己就放不下。
 */
export function compactionThreshold(contextWindow: number): number {
  return Math.min(
    contextWindow * COMPACT_AT_RATIO,
    contextWindow - UNREAL_BOX_COMPACTION.reserveTokens
  )
}

/** 超过多少 token 就在后台开始写摘要。永远不晚于压缩线 */
export function precompactionThreshold(contextWindow: number): number {
  return Math.min(contextWindow * PRECOMPACT_AT_RATIO, compactionThreshold(contextWindow))
}

/**
 * 后台写好、还没换上的摘要。
 *
 * 放在模块级、按会话存，因为 agent 每条用户消息重建一次 —— 存在闭包里的话，
 * 用户一插话，写了一半的摘要就跟着旧 agent 一起丢了，而那正是最该用上它的时候。
 */
interface Precompaction {
  /** 基于哪一代检查点写的。检查点在这期间换过，这份就作废 */
  baseEpoch: number
  /** 写好了是新检查点，没写成是 undefined */
  result: Promise<CheckpointState | undefined>
  /** 已经写完（成败都算）。撞线时还没写完才需要提示用户在等 */
  done: boolean
  /** 写好的那份。续写时拿它当起点 */
  ready?: CheckpointState
}

const precompactions = new Map<string, Precompaction>()

/** 测试用：清掉模块级的后台摘要 */
export function resetPrecompactionsForTest(): void {
  precompactions.clear()
}

/** 压缩时给摘要模型的额外指示。UE 领域里哪些东西丢不得。 */
const SUMMARY_INSTRUCTIONS = `这是虚幻引擎工作流的对话。生成摘要时**必须**逐字保留：
- 已确认存在的资产完整路径（如 /Game/Materials/M_Wood），以及已确认**不存在**的路径
- 材质/蓝图图表里已创建节点的 node_id 与类型
- 被存档的大结果的编号（archived.ref，如 r3）和它装的是什么 —— 凭编号还能用 result_query 取回细节
- 已完成的操作及其结果（创建了什么、连了哪些线、编译是否通过）
- 用户明确表达过的偏好和约束
- 尚未完成的待办

可以丢弃：中间探索过程、被推翻的方案、重复的工具调用。`

/**
 * 检查点接线。
 *
 * 只收一个已经读好的初值和一个保存回调，**不让这个文件碰 fs/electron** ——
 * 压缩逻辑是纯的，测它不该要一个假的 userData 目录。真正的读写在
 * `compactionCheckpoint.ts`，宿主层负责把两头接起来。
 */
export interface CompactionCheckpointPort {
  /** 上一轮存下来的检查点。宿主在造 agent 时读一次传进来 */
  initial?: CheckpointState
  /** 真正重压之后落盘。失败由实现自己吞掉 */
  save: (checkpoint: CheckpointState) => Promise<void>
}

/** 检查点里压缩逻辑真正用得上的那几个字段 */
export interface CheckpointState {
  contextEpoch: number
  summary: string
  cutIndex: number
  sourceHash: string
  createdAt: number
}

export interface CompactionDeps {
  models: Models
  summaryModel: Model<string>
  contextWindow: number
  /** 压缩前后通知界面。压缩会有几秒停顿，不说一声用户会以为卡住了 */
  onCompacting?: (info: { tokensBefore: number }) => void
  onUsage?: (info: { tokens: number; contextWindow: number }) => void
  /**
   * 摘要检查点。不给就退回旧行为（每轮重新摘要）——
   * 子 agent 和调试入口用不上，它们的 sessionId 是一次性的。
   */
  checkpoint?: CompactionCheckpointPort
  /** 算一段消息的指纹。由宿主注入，见 `compactionCheckpoint.hashMessages` */
  hashMessages?: (messages: AgentMessage[]) => string
  /**
   * 后台摘要按什么归属。一般就是会话 id。
   * 不给就不在后台写，撞线时当场写 —— 子 agent 和调试入口都是一次性的，用不上。
   * 还要求给了 `hashMessages`：没有指纹，就没法确认写好的摘要还对得上当前历史。
   */
  precompactKey?: string
}

/**
 * 构造给 `Agent.transformContext` 的钩子。
 *
 * 契约：**不能抛异常**（见 pi 的 transformContext 文档）。压缩失败时返回原始
 * 消息 —— 宁可这一轮撞上下文上限拿到厂商的明确报错，也不能让整个循环崩掉。
 */
/** 压缩不成时说明原因。调用方据此决定给用户看什么 */
export type CompactOutcome =
  | { ok: true; messages: AgentMessage[]; summary: string }
  | { ok: false; reason: 'too-short' | 'summary-failed' }

/**
 * 真正干活的那一步：把早期对话换成一段摘要。
 *
 * 从 `createAutoCompact` 里抽出来，是为了让**手动压缩**能复用同一条路径 ——
 * 两条各写一遍的话，自动压出来的摘要和手动压出来的会慢慢长得不一样，
 * 而这种差异只会在用户抱怨「压完之后它忘了刚才的事」时才被发现。
 *
 * 与自动压缩的唯一区别是**没有阈值判断**：用户明说要压，就压。
 */
export async function compactMessages(
  messages: AgentMessage[],
  deps: Pick<CompactionDeps, 'models' | 'summaryModel'>,
  options: { previousSummary?: string; signal?: AbortSignal } = {}
): Promise<CompactOutcome> {
  const { head, tail } = splitAtRecentBudget(messages, UNREAL_BOX_COMPACTION.keepRecentTokens)
  if (head.length === 0) {
    // 最近几轮就已经撑满保留额度了，没有「早期对话」可换
    return { ok: false, reason: 'too-short' }
  }

  const result = await generateSummary(
    head,
    deps.models,
    deps.summaryModel,
    UNREAL_BOX_COMPACTION.reserveTokens,
    options.signal,
    SUMMARY_INSTRUCTIONS,
    options.previousSummary
  )

  if (!result.ok || !result.value) return { ok: false, reason: 'summary-failed' }

  return { ok: true, messages: [toSummaryMessage(result.value), ...tail], summary: result.value }
}

/**
 * 压缩到底省下了多少。
 *
 * **不能用 `estimateContextTokens` 去量压缩后的值。** 它的语义是「整段上下文」：
 * 取**最后一条 assistant 消息里厂商回报的 usage**，再加上它之后那几条的字符估算。
 * 而压缩砍的是**头部** —— 那条 assistant 原封不动留在尾巴里，带着同一个数字，
 * 于是压缩前后算出来一模一样。界面因此显示「162K → 162K」，用户点完看着数字
 * 纹丝不动只会以为按钮坏了；连「压完是不是真变小了」这个判断也跟着永远为假。
 *
 * 所以净减量改用逐条字符估算来量 —— 那个是真会随头部被砍掉而变小的。
 * 但也不能把字符估算直接当结果显示：它**不含系统提示词和工具定义**，
 * 拿去刷用量指示器会让数字掉到另一个量级，下一轮拿到厂商真实用量又跳回去。
 * 真实基数减去净减量，两边的好处才都占上。
 */
export function measureCompaction(
  before: AgentMessage[],
  after: AgentMessage[]
): { tokensBefore: number; tokensAfter: number; saved: number } {
  const tokensBefore = estimateOutgoingTokens(before).tokens
  const saved = estimateMessagesTokens(before) - estimateMessagesTokens(after)
  return { tokensBefore, tokensAfter: Math.max(0, tokensBefore - saved), saved }
}

/**
 * 「即将发出去的这一份」上下文有多大。
 *
 * 和 `estimateContextTokens` 同样优先信最后一条 assistant 上厂商报的用量，多一道防御：
 * **那个用量只对它当时发出去的那份上下文成立。** 要发的这份要是比那时大得多，
 * 它就是个过期的数。
 *
 * 真机上撞过：队员（子 agent）没有落盘的检查点，重新派活时 agent 重建、闭包里的
 * 检查点清空，要发的是盘上 977 条、约 170 万字符的完整历史 —— 而最后那条 assistant
 * 带的用量，是上一轮**压缩后视图**的 9.4 万。照它算远低于压缩线，于是原样发出，
 * 厂商回「input exceeds the context window」。
 *
 * 防御的判据不是编出来的阈值，是一个下限：**上下文不可能比它装着的文字还小。**
 * 用量那条之前（含它）的消息按纯文字估一遍，超过厂商报的数，就说明那个数描述的
 * 不是这一份，改用文字估算。纯文字指正文、工具调用参数、工具结果文字：
 *
 *   - 图片不算：各家计价差很远，拿 pi 的一律 1200 去比，会在厂商如实报了低价的会话里
 *     误判「用量过期」，然后每一轮都压一次
 *   - 思考不算：好几家不把上一轮的思考再发一遍，算进来同样会误判
 *
 * 中文按「4 字符 1 token」是往低估的，JSON 和英文大致持平 —— 所以这个下限只会偏小，
 * 正常会话里（用量还含着系统提示词和工具定义）它碰不到厂商报的数。
 */
export function estimateOutgoingTokens(base: AgentMessage[]): {
  tokens: number
  lastUsageIndex: number | null
  /** 厂商报的用量对不上要发的这份，改用了文字下限 */
  staleUsage: boolean
} {
  const usage = estimateContextTokens(base)
  if (usage.lastUsageIndex === null) {
    return { tokens: usage.tokens, lastUsageIndex: null, staleUsage: false }
  }
  let floor = 0
  for (let i = 0; i <= usage.lastUsageIndex; i++) floor += estimateTextTokens(base[i])
  if (floor <= usage.usageTokens) {
    return { tokens: usage.tokens, lastUsageIndex: usage.lastUsageIndex, staleUsage: false }
  }
  return {
    tokens: floor + usage.trailingTokens,
    lastUsageIndex: usage.lastUsageIndex,
    staleUsage: true
  }
}

/** 一条消息的纯文字部分按 pi 的口径（4 字符 1 token）估多少。为什么不算图片和思考见上面 */
function estimateTextTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content as Array<{
    type?: string
    text?: unknown
    name?: unknown
    arguments?: unknown
  }>) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
    else if (block?.type === 'toolCall') {
      chars +=
        String(block.name ?? '').length + (JSON.stringify(block.arguments ?? {})?.length ?? 0)
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * 逐条字符估算求和。与 `estimateContextTokens` 的差别见 `measureCompaction`。
 *
 * 用 pi 的口径（图片一律 1200 token），因为它的两个调用方都要求**和
 * `estimateContextTokens` 同一把尺**：`measureCompaction` 拿它做减法，
 * `splitAtRecentBudget` 拿它和 `keepRecentTokens` 比。按字节计价的那把尺
 * 在 `estimateMessagesTokensByBytes`，只给「要不要压缩」那个判断用。
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) total += estimateTokens(message)
  return total
}

/**
 * 这几条消息里的图片，比 pi 的估价多出来的那部分。
 *
 * pi 把图片一律记 4800 字符（1200 token），不看这张图多大
 * （`vendor/pi-harness/compaction.ts` 的 `ESTIMATED_IMAGE_CHARS`，从 pi 0.84.3 搬来）。真机上
 * 出过事故：两张原样发出去的截图把上下文顶到 123 万 token，而按 pi 的算法
 * 它们合计只有 2400 —— 压缩因此迟迟不触发。
 *
 * 各家对图片的真实计价不一样（有的按视觉 patch，有的近似按字节），猜不准，
 * 所以只做一件有把握的事：按它实际占的字节补差额。
 *
 * **只能用在厂商还没报过账的那几条上**（见 `createAutoCompact`）。全量算的话
 * 会把厂商已经如实计过价的图再补一遍：实测一个厂商报 120,800 token 的会话，
 * 全量补完变成 348,066，虚高 2.88 倍，压缩于是每一轮都触发。
 */
function imageByteSurcharge(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; data?: unknown }>) {
      if (block?.type !== 'image' || typeof block.data !== 'string') continue
      total += Math.ceil(Math.max(0, block.data.length - PI_ESTIMATED_IMAGE_CHARS) / 4)
    }
  }
  return total
}

/** pi 给每张图记的固定字符数。补差额时要减掉它，免得重复计 */
const PI_ESTIMATED_IMAGE_CHARS = 4800

/**
 * 检查点还对得上吗。
 *
 * 三条都要过：切点还在范围内、切的不是空的头部、被换掉那段历史的指纹没变。
 * 第三条挡的是用户删消息 / 从某一轮重新生成 / 分支 —— 那时摘要描述的是一段
 * 已经不存在的对话，拿去喂模型比不压更糟。
 */
export function checkpointApplies(
  messages: AgentMessage[],
  checkpoint: CheckpointState | undefined,
  hashMessages: ((messages: AgentMessage[]) => string) | undefined
): boolean {
  if (!checkpoint || !hashMessages) return false
  if (checkpoint.cutIndex <= 0 || checkpoint.cutIndex > messages.length) return false
  return hashMessages(messages.slice(0, checkpoint.cutIndex)) === checkpoint.sourceHash
}

/** 「固定摘要检查点 + 检查点之后的原始消息」—— 模型真正看到的那份上下文 */
export function applyCheckpoint(
  messages: AgentMessage[],
  checkpoint: CheckpointState
): AgentMessage[] {
  return [toSummaryMessage(checkpoint.summary), ...messages.slice(checkpoint.cutIndex)]
}

type CompactTransform = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>

/**
 * 自动压缩，装在 pi 的 `transformContext` 上。
 *
 * pi 1.0 起 transcript 里会有 system 消息（开头那条提示词 + 这一轮里的工具增量，
 * 见 `systemMessages.ts`）。压缩**只看对话本身**：先把 system 消息拿出来，切点、
 * 检查点指纹、用量估算都和盘上那份（本来就不含 system 消息）对得上，行为和
 * 0.84 时一样；真压了，再把它们合成一条放回最前面。不放回的话，压完第一次
 * 模型就没有提示词也没有工具了 —— pi 把 system 消息当普通历史交给我们。
 */
export function createAutoCompact(deps: CompactionDeps): CompactTransform & {
  compactForOverflow: (signal?: AbortSignal) => Promise<AgentMessage[] | undefined>
  compactHistory: (messages: AgentMessage[], signal?: AbortSignal) => Promise<boolean>
} {
  const { transform: compactConversation, compactLatest } = createConversationCompact(deps)
  /** 最近一次交进来的完整历史（含 system 消息）。超长补救要拿它当场压 */
  let latest: AgentMessage[] | undefined
  const withHead = (messages: AgentMessage[], projected: AgentMessage[]): AgentMessage[] => {
    const head = getCurrentSystemMessage(messages as Message[])
    return head ? [head, ...projected] : projected
  }
  const transform = async (
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<AgentMessage[]> => {
    latest = messages
    const conversation = withoutSystemMessages(messages)
    const projected = await compactConversation(conversation, signal)
    // 没压（原样返回）就把原数组交回去，一条都不动
    if (projected === conversation) return messages
    return withHead(messages, projected)
  }
  /**
   * 不看阈值，把最近那份历史当场压掉，返回压完的模型视图（含 system 消息）。
   *
   * 给 `contextOverflow.ts` 用：厂商已经回了超长，说明估算低了，阈值不作数。
   * 压出来的检查点记进闭包，这一轮后面的请求经 `transform` 照样用上。
   * 压不动（没有可换的头部、摘要失败）返回 undefined。
   */
  const compactForOverflow = async (signal?: AbortSignal): Promise<AgentMessage[] | undefined> => {
    if (!latest) return undefined
    const messages = latest
    try {
      const projected = await compactLatest(withoutSystemMessages(messages), signal)
      return projected ? withHead(messages, projected) : undefined
    } catch {
      return undefined
    }
  }
  /**
   * 不看阈值，把一段已有的历史压掉，只留最近 `keepRecentTokens` 那段原文。压了返回 true。
   *
   * 给队员接新活用（`runSubAgent`）：队员记得之前所有活，不压的话第 N 件活的每一步
   * 都要把前 N-1 件活的全过程重发一遍。真机上一个队员干了 6 件活，上下文从 2.4 万
   * 涨到 26.9 万，一共烧掉 900 万 token。最近那段（含上件活的交活报告）还是原文
   */
  const compactHistory = async (
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<boolean> => {
    try {
      return (await compactLatest(withoutSystemMessages(messages), signal)) !== undefined
    } catch {
      return false
    }
  }
  return Object.assign(transform, { compactForOverflow, compactHistory })
}

function createConversationCompact(deps: CompactionDeps): {
  transform: CompactTransform
  compactLatest: (
    messages: AgentMessage[],
    signal?: AbortSignal
  ) => Promise<AgentMessage[] | undefined>
} {
  /**
   * 当前生效的检查点。
   *
   * 起点是宿主从盘上读回来的那份 —— **这是整个改动的要害**：以前它是个活在
   * 闭包里的 `previousSummary`，而 agent 每条用户消息重建一次，等于每轮都从
   * 零开始；再叠上 `transformContext` 每次模型请求都跑一遍（pi 不写回
   * `state.messages`），一轮里调五次工具就重新摘要五次。
   */
  let checkpoint: CheckpointState | undefined = deps.checkpoint?.initial
  /** 只在第一次调用时验一遍指纹：同一轮里历史的头部不会变，验第二遍是白算 hash */
  let validated = false
  const validate = (messages: AgentMessage[]): void => {
    if (validated) return
    validated = true
    if (!checkpointApplies(messages, checkpoint, deps.hashMessages)) checkpoint = undefined
  }

  /** 不看阈值当场压。压不动返回 undefined。见 `createAutoCompact` 的 `compactForOverflow` */
  const compactLatest = async (
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<AgentMessage[] | undefined> => {
    // 队员接活时在第一个请求之前就来压，那时还没经过 `transform` 验过检查点
    validate(messages)
    const base = checkpoint ? applyCheckpoint(messages, checkpoint) : messages
    // 后台那份描述的是压之前的一代，换了检查点就作废
    if (deps.precompactKey) precompactions.delete(deps.precompactKey)
    const projected = await compactNow(
      messages,
      base,
      estimateOutgoingTokens(base).tokens,
      false,
      signal
    )
    return projected === base ? undefined : projected
  }

  const transform = async (
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<AgentMessage[]> => {
    try {
      validate(messages)

      // 有检查点就先投影成模型视图再量 —— 拿全量历史去量，会在明明已经压过的
      // 情况下判定「还要再压」，然后每一次请求都白跑一趟摘要模型。
      const base = checkpoint ? applyCheckpoint(messages, checkpoint) : messages

      // 用量过期（要发的这份比厂商报账那时大）时改用文字下限，见 `estimateOutgoingTokens`
      const usage = estimateOutgoingTokens(base)

      // `estimateContextTokens` 会优先采信最近一条 assistant 上厂商报的真实用量 ——
      // 那一段是最准的，一个字都不该改。**只给它后面那几条补图片的差额**：
      // 那段还没被厂商计过价，pi 又把每张图一律记 1200 token，「刚塞进来两张大图」
      // 恰好落在这个盲区里，而那正是最该触发压缩的时候。
      //
      // 补差额**必须只补这一段**。全量补会把厂商已经如实计过价的图再补一遍，
      // 数字虚高两三倍，于是每一轮都判定「该压了」；而那些图按 pi 的尺只值
      // 1200，`splitAtRecentBudget` 会把它们留在尾巴里 —— 切头部根本降不下来。
      // 结果是每个模型请求都宣布一次压缩、什么都没压，循环往复。
      const unbilled = usage.lastUsageIndex === null ? base : base.slice(usage.lastUsageIndex + 1)
      const tokens = usage.tokens + imageByteSurcharge(unbilled)

      // 界面和触发判断用同一个数。分开的话用户会看到「上下文才用了百分之几」
      // 的同时弹出「正在压缩上下文」。
      deps.onUsage?.({ tokens, contextWindow: deps.contextWindow })

      if (!UNREAL_BOX_COMPACTION.enabled) return base

      const epoch = checkpoint?.contextEpoch ?? 0
      const key = deps.hashMessages ? deps.precompactKey : undefined
      let pending = key ? precompactions.get(key) : undefined
      // 检查点在这期间换过（当场压过一次、历史被改过），那份摘要描述的是旧的一代
      if (key && pending && pending.baseEpoch !== epoch) {
        precompactions.delete(key)
        pending = undefined
      }

      if (tokens <= compactionThreshold(deps.contextWindow)) {
        if (key && tokens > precompactionThreshold(deps.contextWindow)) {
          if (!pending) startPrecompaction(key, messages, base, epoch, checkpoint)
          else if (shouldRoll(messages, pending)) {
            const ready = pending.ready as CheckpointState
            startPrecompaction(key, messages, applyCheckpoint(messages, ready), epoch, ready, ready)
          }
        }
        return base
      }

      // 撞线了。后台那份能用就直接换上，省掉当场写摘要的那段停顿
      let announced = false
      if (key && pending) {
        precompactions.delete(key)
        if (!pending.done) {
          deps.onCompacting?.({ tokensBefore: tokens })
          announced = true
        }
        const ready = await untilAborted(pending.result, signal)
        if (ready === ABORTED) {
          // 用户停了这一轮：后台那份照样写完留给下一轮，这一轮不再干等
          precompactions.set(key, pending)
          return base
        }
        if (ready && checkpointApplies(messages, ready, deps.hashMessages)) {
          checkpoint = ready
          await deps.checkpoint?.save(ready)
          const projected = applyCheckpoint(messages, ready)
          // 换上之后还在后台线以上，说明摘要没跟上，当场把剩下那段也压掉。
          // 只看压缩线的话，换上后落在 60%~85% 也算「压完了」，下一轮马上又撞线
          const after = tokens - (estimateMessagesTokens(base) - estimateMessagesTokens(projected))
          if (after <= precompactionThreshold(deps.contextWindow)) return projected
          return await compactNow(messages, projected, tokens, announced, signal)
        }
      }

      return await compactNow(messages, base, tokens, announced, signal)
    } catch {
      // transformContext 抛异常会中断低层循环且不产生正常事件序列。
      return messages
    }
  }

  /**
   * 在后台写一份摘要，写好了存着，不换上。
   *
   * 不换上是有意的：换上就改了前缀，缓存整段作废，而且 60% 时离窗口还远，
   * 原文多留一会儿，模型就多看得到一会儿细节。等真撞线了再换。
   * 不接这一轮的 abort 信号：用户停掉这一轮，摘要照样有用。
   */
  function startPrecompaction(
    key: string,
    messages: AgentMessage[],
    base: AgentMessage[],
    baseEpoch: number,
    previous: CheckpointState | undefined,
    fallback?: CheckpointState
  ): void {
    const entry: Precompaction = {
      baseEpoch,
      done: false,
      result: summarize(messages, base, previous).then(
        (value) => {
          entry.done = true
          entry.ready = value
          // 续写失败就退回上一份：照样能换上，只是多留点原文。
          // ready 不跟着退，免得每次请求都拿同一份去重试
          return value ?? fallback
        },
        () => {
          entry.done = true
          return fallback
        }
      )
    }
    precompactions.set(key, entry)
  }

  /**
   * 后台那份写好了、摘要外的原文又攒够一段：该续写了。
   * 写好的那份对不上当前历史（被改过）就不续，撞线时自然当场重压。
   */
  function shouldRoll(messages: AgentMessage[], pending: Precompaction): boolean {
    const ready = pending.ready
    if (!ready || !checkpointApplies(messages, ready, deps.hashMessages)) return false
    const uncovered = estimateMessagesTokens(messages.slice(ready.cutIndex))
    return uncovered > precompactionStep(deps.contextWindow)
  }

  /** 把 base 的头部换成摘要，换算成原始历史下标上的检查点。不成返回 undefined */
  async function summarize(
    messages: AgentMessage[],
    base: AgentMessage[],
    previous: CheckpointState | undefined,
    signal?: AbortSignal
  ): Promise<CheckpointState | undefined> {
    // 后台写摘要时 messages 是 pi 的活数组，写的这段时间里循环还在往后追加；
    // 切点必须按调用这一刻的长度算，否则会把没进摘要的那几条一起切掉
    const total = messages.length
    // 代数按**生效中**的检查点算：续写时 previous 是还没换上的那份，
    // 拿它 +1 会跳代，缓存键（见 createAgent 的 promptCacheKey）跟着乱
    const contextEpoch = (checkpoint?.contextEpoch ?? 0) + 1
    const outcome = await compactMessages(base, deps, {
      // 迭代式摘要：下一次压缩把上一次的摘要一起喂进去更新，
      // 而不是对着已经压过的历史再压一次。
      ...(previous ? { previousSummary: previous.summary } : {}),
      ...(signal ? { signal } : {})
    })
    if (!outcome.ok) return undefined
    // 新切点换算回**原始历史**的下标：outcome.messages 是 [摘要, ...尾巴]，
    // 而那条尾巴永远是 messages 的一个后缀，不管 base 有没有被投影过。
    const cutIndex = total - (outcome.messages.length - 1)
    if (cutIndex <= 0) return undefined
    return {
      contextEpoch,
      summary: outcome.summary,
      cutIndex,
      sourceHash: deps.hashMessages?.(messages.slice(0, cutIndex)) ?? '',
      createdAt: Date.now()
    }
  }

  /** 当场压：原来唯一的那条路，现在只在后台那份用不上时才走 */
  async function compactNow(
    messages: AgentMessage[],
    base: AgentMessage[],
    tokens: number,
    announced: boolean,
    signal?: AbortSignal
  ): Promise<AgentMessage[]> {
    // 切不出头部就别宣布压缩：`compactMessages` 这时只会回 `too-short`，
    // 而 `onCompacting` 已经发出去了，界面上是一次没有下文的「正在压缩」。
    if (splitAtRecentBudget(base, UNREAL_BOX_COMPACTION.keepRecentTokens).head.length === 0) {
      return base
    }

    if (!announced) deps.onCompacting?.({ tokensBefore: tokens })

    const next = await summarize(messages, base, checkpoint, signal)
    // 压不动就原样返回 —— 宁可这一轮撞上下文上限拿到厂商的明确报错，
    // 也不能让整个循环崩掉。
    if (!next) return base

    // 先记在内存里，再看要不要落盘 —— 没有落盘通道的场景（子 agent、
    // 调试入口）同样受益：这一轮剩下的请求直接复用，不再反复摘要。
    checkpoint = next
    if (next.sourceHash) await deps.checkpoint?.save(next)
    return applyCheckpoint(messages, next)
  }

  return { transform, compactLatest }
}

/** 摘要以一条用户消息的形式回到上下文最前面 */
function toSummaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `【此前对话的摘要】\n\n${summary}\n\n【摘要结束，以下是最近的对话】`,
    timestamp: 0
  } as unknown as AgentMessage
}

/**
 * 从尾部往前累加，直到攒够 keepRecentTokens，剩下的头部拿去做摘要。
 *
 * pi 的 `findCutPoint` 作用在 session `Entry[]` 上，而 `transformContext`
 * 拿到的是 `AgentMessage[]`，两者不通用，所以这里自己切。
 */
export function splitAtRecentBudget(
  messages: AgentMessage[],
  keepRecentTokens: number
): { head: AgentMessage[]; tail: AgentMessage[] } {
  let budget = keepRecentTokens
  let cut = messages.length

  for (let i = messages.length - 1; i >= 0; i--) {
    // 用逐条的字符启发式而不是 estimateContextTokens —— 后者是「整段上下文」
    // 的语义，会优先采信最近一条 assistant 的 provider usage，逐条调它等于
    // 每次都从头算一遍，得到的不是这条消息自己的体积。
    //
    // 也**不能**换成按字节计价的那把尺：一张正常压过的截图就值 6 万 token，
    // 而 keepRecentTokens 一共才 24000 —— 第一轮就把额度耗光，`cut` 停在末尾，
    // 连用户刚发的那条一起被摘要掉。见 `estimateMessagesTokensByBytes` 的注释。
    budget -= estimateTokens(messages[i])
    if (budget <= 0) break
    cut = i
  }

  // 切点不能落在工具调用和它的结果之间 —— 一条孤儿 toolResult 会让厂商直接拒绝请求。
  while (cut < messages.length && isOrphanToolResult(messages[cut])) cut++

  return { head: messages.slice(0, cut), tail: messages.slice(cut) }
}

function isOrphanToolResult(message: AgentMessage): boolean {
  const role = (message as { role?: string }).role
  return role === 'toolResult'
}

const ABORTED = Symbol('aborted')

/** 等一个不接 abort 的 promise，但这一轮被停掉时立刻放手 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
