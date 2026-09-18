import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import {
  prepareNotebookChatV2,
  type NotebookChatV2PrepareParams,
  type NotebookChatV2PrepareResult
} from '../services/notebookChatV2Service'
import { normalizeNotebookRagError } from '../services/notebookRagErrors'
import { resolveModelLimitsById } from '../../ai/modelLimits'
import { resolveBinding } from '../../ai/piCompletion'
import { inputTokenBudget } from '../../../shared/tokenBudget'

/** 这轮回答留给模型写多长。检索上下文只是参考资料，回答本身不长 */
const CHAT_ANSWER_TOKENS = 2000

/**
 * 给对话历史留出的余量（token）。
 *
 * 这是**定额**而不是百分比。上一版按「输入预算的五成」留，两个问题：
 *
 * 1. **理由本来就不成立。** 当时写的是「上下文消息 unshift 到完整消息数组前面，
 *    历史照样全带着」—— 但 `useAgentMode` 只发最新那条用户消息，历史是 kernel
 *    按 sessionId 自己接上的，而且 `agent-v3/core/compaction.ts` 每轮都按**实测
 *    用量**决定要不要压缩。也就是说撑爆窗口这件事已经有人按真实数字管着了。
 * 2. **百分比会让惩罚随窗口一起放大，还反过来压死小窗口。** 8k 窗口的模型本来
 *    只有 5192 字可用，按五成留就只剩 2596 字 —— 检索回来 5 段只装得下 2 段，
 *    而界面上那 5 条引用照旧全列着，用户以为模型看过了其实没有。
 *
 * 定额的意思是：窗口越大，留出来的比例越小（1M 窗口几乎无感），小窗口也只按
 * 这个固定数扣，不会被按比例砍半。
 */
const HISTORY_RESERVE_TOKENS = 2000

/**
 * 检索上下文能占多少字，按当前绑的对话模型的窗口算。
 *
 * 上一版这里是写死的 8000 —— 4k 窗口时代的遗产。配了 1M 窗口模型的用户，
 * 来源面板上写着几十万字可用，一提问却只有 8000 字进上下文。
 *
 * ## token 预算为什么可以直接当字符上限用
 *
 * 服务层那个参数是拿 `content.length` 比的，单位是**字符**。中文一个字约一个
 * token，所以「token 预算当字符上限」正好是最保守的那一侧：中文时刚好用满，
 * 英文时少送一些（英文 3.5 字符才 1 token）。反过来按字符换算成 token 再放大，
 * 中文就会超窗。宁可少送，不能超。
 *
 * 拿不到绑定（还没配模型）就返回 undefined，让服务层用它自己的保守缺省值 ——
 * 这一步不该因为模型没配好而报错，真正的提示在发起对话时给。
 */
const resolveChatContextMaxChars = async (): Promise<number | undefined> => {
  try {
    const binding = await resolveBinding({ role: 'chat' })
    const limits = resolveModelLimitsById(binding.provider, binding.modelId)
    // 回答 + 历史余量一起从窗口里扣掉，剩下的才是检索材料能占的
    const inputBudget = inputTokenBudget(limits, CHAT_ANSWER_TOKENS + HISTORY_RESERVE_TOKENS)
    return Math.max(1000, inputBudget)
  } catch {
    return undefined
  }
}

export const registerNotebookChatV2IPC = (): void => {
  ipcMain.handle(
    'notebook:chat-v2:prepare',
    async (_, params: NotebookChatV2PrepareParams): Promise<NotebookChatV2PrepareResult> => {
      try {
        console.log('[NotebookChatV2 IPC] Prepare request received', {
          notebookId: params.notebookId,
          queryLength: params.query?.length ?? 0,
          limit: params.limit ?? null,
          sourceIds: params.sourceIds ?? null
        })

        const db = getPublicDatabase()
        const result = await prepareNotebookChatV2(db, {
          ...params,
          // 调用方没指定就按**当前绑的对话模型的窗口**算，而不是那个写死的 8000。
          // 这一步跑在主进程里，绑定就在手边，没必要让渲染层绕一圈再传回来。
          contextMaxChars: params.contextMaxChars ?? (await resolveChatContextMaxChars())
        })

        console.log('[NotebookChatV2 IPC] Prepare request completed', {
          notebookId: params.notebookId,
          mode: result.mode,
          resultCount: result.citations.length,
          diagnostics: result.diagnostics,
          warnings: result.warnings
        })

        return result
      } catch (error) {
        const normalizedError = normalizeNotebookRagError(error, 'search')
        console.error('[NotebookChatV2 IPC] Prepare failed:', normalizedError)
        throw normalizedError
      }
    }
  )

  console.log('[NotebookChatV2 IPC] Registered')
}
