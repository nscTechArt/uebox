/**
 * 来源进上下文的三档档位。
 *
 * ## 为什么要分三档
 *
 * 以前只有「选中 / 不选中」一个开关，而「给全文还是给摘要」是收集器自己偷偷决定的
 * （有摘要就用摘要）。两个后果：
 *
 * - 用户没法为了省 token 把某一条降成摘要 —— 要么全给，要么不给。
 * - 一次产出的材料有总量上限，超了就默默丢掉后面的来源。
 *   用户看到的是产出莫名其妙缺一块，而不是「你选多了」。
 *
 * 三档把这件事交回给用户，并且让界面能在生成之前就把「这次会送多少字」算出来。
 */
export type NotebookContextLevel = 'full' | 'summary' | 'excluded'

/** 界面上按这个顺序排：给得最多的在最上面 */
export const NOTEBOOK_CONTEXT_LEVELS: readonly NotebookContextLevel[] = [
  'full',
  'summary',
  'excluded'
]

/** 新来源默认全文进上下文 —— 用户加它进来就是想让 AI 看的 */
export const DEFAULT_NOTEBOOK_CONTEXT_LEVEL: NotebookContextLevel = 'full'

/**
 * 问不到模型窗口时按这个算。
 *
 * **这不是「上限」，只是缺省值。** 真正的预算由渲染层的 `contextBudget.ts` 按
 * 用户当前绑的模型算出来，一路传进这里的每个函数。留这个常量是给两种情况用的：
 * 主进程调用（拿不到渲染层的缓存）、以及模型上限还没读回来的第一帧。
 *
 * 取值按最保守的一档：8k 窗口的小模型也塞得下。
 */
export const FALLBACK_CONTEXT_CHAR_BUDGET = 20000

/** 摘要短于这个长度就当没有 —— 模型偶尔只回一句「好的」 */
export const MIN_USABLE_SUMMARY_CHARS = 100

/** 摘要还没生成时，「只给摘要」档退回正文开头的长度 */
export const SUMMARY_FALLBACK_HEAD_CHARS = 2000

/** 算上下文预算需要的来源字段。比 SourceItem 窄，主进程和渲染层都能用 */
export interface NotebookContextSource {
  contextLevel?: NotebookContextLevel | null
  content?: string | null
  summaryContent?: string | null
  summaryStatus?: string | null
  loading?: boolean
  error?: string | null
}

/**
 * 把任意值收敛成一个合法档位。
 *
 * 数据库里可能是 null（老行），也可能是别的字符串（手改过库）。认不出来一律当全文，
 * 因为「多给」的后果是费钱，「少给」的后果是产出缺内容而且用户看不出来。
 */
export function normalizeNotebookContextLevel(value: unknown): NotebookContextLevel {
  return value === 'summary' || value === 'excluded' || value === 'full'
    ? value
    : DEFAULT_NOTEBOOK_CONTEXT_LEVEL
}

/** 这条来源有没有一份能用的摘要 */
export function hasUsableSummary(source: NotebookContextSource): boolean {
  return (
    source.summaryStatus === 'completed' &&
    typeof source.summaryContent === 'string' &&
    source.summaryContent.trim().length >= MIN_USABLE_SUMMARY_CHARS
  )
}

/** 内容就绪才算数：还在加载、加载失败、空内容的来源都送不出去 */
export function isContextContentReady(source: NotebookContextSource): boolean {
  return Boolean(!source.loading && !source.error && source.content?.trim())
}

/** 一条来源按当前档位实际会送进模型的正文 */
export interface ResolvedContextContent {
  text: string
  /** 用的是摘要而不是全文 */
  usedSummary: boolean
  /** 选了摘要但摘要还没生成，退回了正文开头 */
  summaryMissing: boolean
  /** 正文超过单条上限被截断 */
  truncated: boolean
}

/**
 * 算出这条来源这次到底送什么进去。
 *
 * 不进上下文、或者内容还没就绪，返回 null —— 调用方据此跳过它。
 *
 * 「只给摘要」但摘要还没生成时**不回落到全文**：那样用户点了省钱的档位，
 * 花的钱却一分没少，而且界面上的预算数字会是假的。这里退回正文开头，
 * 并把 `summaryMissing` 标出来让界面说清楚。
 */
export function resolveContextContent(
  source: NotebookContextSource
): ResolvedContextContent | null {
  if (!isContextContentReady(source)) return null

  const level = normalizeNotebookContextLevel(source.contextLevel)
  if (level === 'excluded') return null

  const content = source.content ?? ''

  if (level === 'summary') {
    if (hasUsableSummary(source)) {
      return {
        text: (source.summaryContent ?? '').trim(),
        usedSummary: true,
        summaryMissing: false,
        truncated: false
      }
    }
    return {
      text: content.slice(0, SUMMARY_FALLBACK_HEAD_CHARS),
      usedSummary: false,
      summaryMissing: true,
      truncated: content.length > SUMMARY_FALLBACK_HEAD_CHARS
    }
  }

  /*
    全文档**不在这里截**，原样交出去，由装箱那一步决定要不要它。

    上一版在这里截到正好 `charBudget`，然后装箱判 `0 + charBudget > charBudget`
    为 false —— 于是这条被截掉一大半的来源不但进去了，还把预算吃满、把其余来源
    全挤成「送不进去」。用户看到的是「4 条送不进去」，完全不知道剩下那条被砍了
    三分之二。整条丢掉至少能在界面上原样点名。
  */
  return { text: content, usedSummary: false, summaryMissing: false, truncated: false }
}

/** 这条来源这次占多少字。不进上下文就是 0 */
export function contextCharsForSource(source: NotebookContextSource): number {
  return resolveContextContent(source)?.text.length ?? 0
}

/** 装箱用的最小形状：一个名字加一段正文 */
export interface PackableSource {
  /** 没有标题的来源由界面决定叫什么，这里不塞任何界面文案 */
  title?: string
  content: string
}

/** 一次装箱的结果 */
export interface ContextPacking<T extends PackableSource> {
  /** 真的会送进模型的 */
  included: T[]
  /** 超出上限、这次送不进去的 */
  dropped: T[]
  /** included 的总字数 */
  usedChars: number
}

/**
 * 按上限把来源装进一次上下文。
 *
 * **装不下的整条丢掉**，不做「塞半条进去」：半条内容会让模型把残句当成作者写完了，
 * 而且界面上没法诚实地表达「这条送了 63%」。整条丢掉至少能原样告诉用户是哪几条没送。
 *
 * 顺序即优先级 —— 排在前面的先占位置。
 */
export function packSourcesWithinBudget<T extends PackableSource>(
  items: readonly T[],
  maxChars: number = FALLBACK_CONTEXT_CHAR_BUDGET
): ContextPacking<T> {
  const included: T[] = []
  const dropped: T[] = []
  let usedChars = 0

  for (const item of items) {
    const cost = item.content.length
    if (usedChars + cost > maxChars) {
      dropped.push(item)
      continue
    }
    included.push(item)
    usedChars += cost
  }

  return { included, dropped, usedChars }
}

/** 一整个知识库这次的上下文预算 */
export interface NotebookContextBudget {
  /** 会送进模型的来源数 */
  includedCount: number
  /** 会送进模型的总字数 */
  totalChars: number
  /** 上限 */
  maxChars: number
  /** 有来源因为超上限被丢掉 */
  overBudget: boolean
  /** 被丢掉的来源标题（可能是空串，界面自己决定占位文案），界面要原样说出来 */
  droppedTitles: (string | undefined)[]
  /** 选了摘要但摘要还没生成的来源数 */
  summaryMissingCount: number
}

/**
 * 把整份来源列表的预算算出来，给界面上的计量条用。
 *
 * 走的是和真正生成时**同一条**装箱逻辑，所以计量条上写的字数就是实际会送出去的字数。
 */
export function summarizeContextBudget(
  sources: readonly (NotebookContextSource & { title?: string })[],
  charBudget: number = FALLBACK_CONTEXT_CHAR_BUDGET
): NotebookContextBudget {
  const resolvedItems: PackableSource[] = []
  let summaryMissingCount = 0

  for (const source of sources) {
    const resolved = resolveContextContent(source)
    if (!resolved) continue
    resolvedItems.push({ title: source.title, content: resolved.text })
    if (resolved.summaryMissing) summaryMissingCount += 1
  }

  const packing = packSourcesWithinBudget(resolvedItems, charBudget)

  return {
    includedCount: packing.included.length,
    totalChars: packing.usedChars,
    maxChars: charBudget,
    overBudget: packing.dropped.length > 0,
    droppedTitles: packing.dropped.map((item) => item.title),
    summaryMissingCount
  }
}
