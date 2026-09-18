/**
 * 按需生成来源摘要。
 *
 * 「只给摘要」这一档只有在真有一份摘要时才省钱，而绝大多数来源（文件、笔记、文本）
 * 导入时根本不会生成摘要 —— 生成一次要花钱，为所有来源预先生成，等于替用户
 * 决定了一笔他没同意的开销。所以摘要是**用户切到摘要档时才生成**的。
 */

import { hasUsableSummary, type NotebookContextSource } from '@core/shared/notebookContext'
import { condenseSource } from './SourceSummarizer'

/** 一次「确保有摘要」的结果 */
export type EnsureSummaryOutcome =
  /** 本来就有，什么都没做 */
  | 'already'
  /** 这次生成好了 */
  | 'generated'
  /** 没生成出来（模型没配好 / 内容太短 / 压不动），按正文开头送 */
  | 'failed'

/** 摘要生成过程中要写回去的字段 */
export interface SummaryPatch {
  summaryContent?: string | null
  summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | null
}

/** 这个函数认得的来源形状 */
export interface SummaryTarget extends NotebookContextSource {
  id: string
  content: string
}

/**
 * 确保这条来源有一份能用的摘要。
 *
 * @param source 目标来源
 * @param update 把摘要写回去（store 的 updateSource 包一层）
 * @param condense 生成摘要的实现，测试时替换
 */
export async function ensureSourceSummary(
  source: SummaryTarget,
  update: (updates: SummaryPatch) => Promise<void>,
  condense: typeof condenseSource = condenseSource
): Promise<EnsureSummaryOutcome> {
  if (hasUsableSummary(source)) return 'already'

  // 先把状态写成「生成中」，界面上那一条要立刻转起来 —— 一次摘要要几十秒，
  // 中间什么都不显示的话用户会以为点了没反应，然后再点一次
  await update({ summaryStatus: 'processing' })

  const summary = await condense(source.content)

  if (!summary) {
    await update({ summaryContent: null, summaryStatus: 'failed' })
    return 'failed'
  }

  await update({ summaryContent: summary, summaryStatus: 'completed' })
  return 'generated'
}
