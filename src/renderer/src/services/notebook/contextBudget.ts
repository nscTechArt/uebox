/**
 * 知识库这次能往模型里送多少材料。
 *
 * ## 为什么要有这一层
 *
 * 上一版这条线上有四个互不相干的字符上限：
 *
 * | 位置 | 上限 |
 * |---|---|
 * | 一次产出的材料总量 | 40,000 字 |
 * | 单条来源 | 50,000 字 |
 * | 信息图第一步读材料 | 12,000 字 |
 * | 知识库对话的检索上下文 | 8,000 字 |
 *
 * 四个数字来自四个不同时间点的拍脑袋，互相不知道对方存在，而且都是照
 * 「中文 1.5 字一个 token」换算的 —— 那是 4k 窗口时代的遗产。今天用户配了
 * 1M 窗口的模型照样被 4 万字卡住，配了 8k 小模型又照样撑爆。
 *
 * 现在只有一个来源：**问主进程这次用的是哪个模型、它的窗口多大**，再按 token
 * 算出材料能占多少。
 */

import {
  clampOutputTokens,
  estimateTokens,
  FALLBACK_MODEL_LIMITS,
  inputTokenBudget,
  type ModelLimits
} from '@core/shared/tokenBudget'
import { FALLBACK_CONTEXT_CHAR_BUDGET } from '@core/shared/notebookContext'

/** 这次实际会用哪个模型。缓存指纹与预算都要它 */
export interface BoundModelLimits extends ModelLimits {
  providerId?: string
  modelId?: string
}

/**
 * 缓存活多久。
 *
 * 用户在设置里换模型是随时可能发生的，而这里没有一个可靠的「配置变了」事件可听。
 * 缓存永不过期的话，换完模型必须重启应用才生效 —— 期间计量条和真正送出去的量
 * 全是上一个模型的账。一分钟一问，代价是一次 IPC，换来的是「改完设置回来就对了」。
 */
const LIMITS_CACHE_TTL_MS = 60_000

interface CachedLimits {
  limits: BoundModelLimits
  at: number
}

let limitsCache: Partial<Record<string, CachedLimits>> = {}
let limitsLoading: Partial<Record<string, Promise<BoundModelLimits>>> = {}

/** 用户改了模型配置之后调它，下次重新问 */
export function invalidateModelLimitsCache(): void {
  limitsCache = {}
  limitsLoading = {}
}

/**
 * 这个角色实际绑的模型有多大窗口。
 *
 * 拿不到就用保守缺省值 —— 这里返回的数只决定「送多少材料」，问不到时少送一点
 * 总好过整个产出直接报错。真缺模型的提示由发起生成那一步给。
 */
export async function getModelLimits(
  role: 'chat' | 'summary' | 'agent'
): Promise<BoundModelLimits> {
  const cached = limitsCache[role]
  if (cached && Date.now() - cached.at < LIMITS_CACHE_TTL_MS) return cached.limits

  const pending = limitsLoading[role]
  if (pending) return pending

  const request = (async () => {
    try {
      const result = await window.api.ai.modelLimits({ role })
      const data = result?.data
      if (!data) return FALLBACK_MODEL_LIMITS

      const limits: BoundModelLimits = {
        contextWindow: data.contextWindow,
        maxOutputTokens: data.maxOutputTokens,
        ...(data.providerId ? { providerId: data.providerId } : {}),
        ...(data.modelId ? { modelId: data.modelId } : {})
      }

      /*
        还没绑模型时**不写缓存**。

        主进程在这种情况下如实回 `configured: false` + 保守缺省值，那是给「现在
        先按这个算」用的，不是一个可以记住的答案。记住它的后果是：全新安装的用户
        先打开知识库、再去设置里绑模型，本次会话内所有预算都停在缺省值上，
        只有重启才恢复。
      */
      if (data.configured) limitsCache[role] = { limits, at: Date.now() }
      return limits
    } catch (error) {
      console.warn('[contextBudget] 取模型上限失败，按保守缺省算:', error)
      // 同理：失败不缓存，下次再问一遍
      return FALLBACK_MODEL_LIMITS
    } finally {
      delete limitsLoading[role]
    }
  })()

  limitsLoading[role] = request
  return request
}

/**
 * 知识库产出里最长的一次输出：网页排版那一步要写 12000 token。
 *
 * 六个产出各有各的输出长度（思维导图 4000、报告 8000、网页 12000…），但预算
 * **按最长的那个统一算**，不按产出分：分开算的话同一批来源在思维导图里能全送、
 * 在网页里少送两条，而界面上的计量条只有一个数——它就必然对某几个产出说谎。
 * 统一按最保守的一档，计量条上写的字数对每个产出都成立。
 */
const NOTEBOOK_PLANNED_OUTPUT_TOKENS = 12000

/**
 * 知识库这次能送多少**字**材料。
 *
 * 界面上的预算计量条、`toTaskSources` 的单条截断、`buildContentDigest` 的装箱，
 * 三处用的都是这一个数。各算各的就会出现「说好送 3 万字，产出却像只读了一半」。
 */
export async function resolveNotebookCharBudget(): Promise<number> {
  const limits = await getModelLimits('chat')
  // 按最坏情况（全中文，一字一 token）折算成字符数：全英文的材料会因此少送一些，
  // 但绝不会因为估错而撑爆窗口
  return inputTokenBudget(limits, NOTEBOOK_PLANNED_OUTPUT_TOKENS)
}

/**
 * 同步版：只在已经取回过上限时给出真实预算，否则给保守缺省值。
 *
 * 界面上的计量条要在每次渲染时算，不能是 async。首帧可能拿到缺省值，
 * 上限读回来之后 `getModelLimits` 已经有缓存，重新渲染就是真实值。
 */
export function notebookCharBudgetSync(): number {
  const cached = limitsCache.chat
  // 过期的缓存和没有缓存是一回事：不看 TTL 的话，用户换完模型这里会一直返回
  // 上一个模型的账 —— 而这正是 TTL 要修的问题
  const fresh = cached && Date.now() - cached.at < LIMITS_CACHE_TTL_MS
  return fresh
    ? inputTokenBudget(cached.limits, NOTEBOOK_PLANNED_OUTPUT_TOKENS)
    : FALLBACK_CONTEXT_CHAR_BUDGET
}

/** 把配方想写的长度钳进模型真正接受的范围 */
export async function resolveOutputTokens(
  wanted: number,
  role: 'chat' | 'summary' = 'chat'
): Promise<number> {
  return clampOutputTokens(wanted, await getModelLimits(role))
}

export { estimateTokens }
