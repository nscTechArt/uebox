/**
 * 非对话角色调套餐来源失败时的错误：402 没订阅 / 额度用完、429 今天的额度用完（每日上限）、
 * 403 套餐不含这个角色、401 Key 失效。
 *
 * 对话那一路在 `agent-v3:error` 上带 `planError`，渲染层换成可点的提示（P0 做的）。
 * 其余角色的错误各走各的出口 —— 工具结果、AI 创作面板、朗读的 toast、听写的提示 ——
 * 没有一个统一的按钮位，所以这里给**说清下一步的文案**，同时把错误码挂在 `planError` 上，
 * 有按钮位的出口（朗读）按码换成套餐卡片那套文案。
 *
 * 文案里都带「设置 → 模型」：AI 创作面板的 getFriendlyErrorMessage 见到这个短语就原样透出，
 * 不会被压成一句「生成失败，请稍后重试」（见 imageGeneration.ts 的 IMAGE_CONFIG_ERROR_MARKER）。
 *
 * 这几种错都是「不改就一定再失败」，文案里明说别重试 —— 读它的往往是 Agent，
 * 它见到失败的第一反应是再调一次。
 */

import {
  creatorPlanChatError,
  formatPlanResetTime,
  nextUtcMidnight,
  type CreatorPlanChatErrorCode,
  type CreatorPlanLimitedBy
} from '../../../shared/creatorPlan'

/** 响应头只要能按名字取就行：fetch 的 Headers，或测试里的替身 */
export interface PlanHeaders {
  get(name: string): string | null
}

/** 这次失败的补充：每日上限什么时候恢复、本期上限为什么被压低、压低到什么时候 */
export interface PlanErrorDetail {
  /** `daily_limit_reached`：每日上限的重置时刻（ISO） */
  dailyResetAt?: string
  /** `quota_exhausted` 且本期上限被压低时的原因 */
  limitedBy?: CreatorPlanLimitedBy
  /** `quota_exhausted`：最早能再用的时刻（冷却结束或周期重置） */
  quotaResetAt?: string
}

const STATIC_MESSAGES: Readonly<
  Record<Exclude<CreatorPlanChatErrorCode, 'daily_limit_reached'>, string>
> = Object.freeze({
  subscription_inactive:
    'UEBox Token Plan 没有生效的订阅（或续费失败已过宽限期）。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」处理；处理好之前重试也一样失败。',
  quota_exhausted:
    'UEBox Token Plan 本月的额度用完了。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」升级，或等额度重置；现在重试也一样失败。',
  role_not_in_plan:
    '当前的 UEBox Token Plan 套餐不含这个角色。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」换档，或把这个角色换绑到别的来源。',
  unauthorized:
    'UEBox Token Plan 的授权失效了（Key 被吊销或删除）。到 设置 → 模型 的套餐卡片重新连接。'
})

const resetTime = (iso: string): string =>
  formatPlanResetTime(iso, 'zh-CN', {
    today: (time) => `今天 ${time}`,
    tomorrow: (time) => `明天 ${time}`
  })

/** 本期上限被压低时，额度用完的原因说在前面：用户要做的事不一样 */
function limitedReason(detail: PlanErrorDetail): string {
  const until = detail.quotaResetAt ? `，${resetTime(detail.quotaResetAt)} 解除` : ''
  switch (detail.limitedBy) {
    case 'plan_change':
      return '本期是中途升档，新增的额度按剩余天数折算，下个周期给全额。'
    case 'past_due':
      return '续费扣款失败，本期只给 20% 的额度，到套餐卡片点「管理订阅」更新付款方式后立即恢复。'
    case 'new_account':
      return `新账户首次付款后 72 小时内限额${until}。`
    default:
      return ''
  }
}

function messageOf(code: CreatorPlanChatErrorCode, detail: PlanErrorDetail): string {
  if (code === 'daily_limit_reached') {
    return (
      `UEBox Token Plan 今天的额度用完了，${resetTime(detail.dailyResetAt ?? nextUtcMidnight())} 恢复。` +
      '现在重试也一样失败（单次规格超过每天的上限时，明天也一样：换小一点的规格）；' +
      '等不及可以到 设置 → 模型 的套餐卡片点「管理订阅」升级。'
    )
  }
  if (code === 'quota_exhausted' && detail.limitedBy) {
    return `UEBox Token Plan 本月的额度用完了。${limitedReason(detail)}现在重试也一样失败。设置 → 模型 的套餐卡片上有详情。`
  }
  return STATIC_MESSAGES[code]
}

export class CreatorPlanCallError extends Error {
  constructor(
    readonly planError: CreatorPlanChatErrorCode,
    readonly status: number,
    readonly detail: PlanErrorDetail = {}
  ) {
    super(messageOf(planError, detail))
    this.name = 'CreatorPlanCallError'
  }
}

/** 从协议的错误体里取 `error.code`。取不到回 undefined（见 00-conventions「错误」） */
export function planErrorCodeOf(body: unknown): string | undefined {
  let payload = body
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code
  return typeof code === 'string' ? code : undefined
}

const LIMITED_BY: readonly CreatorPlanLimitedBy[] = ['plan_change', 'past_due', 'new_account']

/** 从响应头取补充信息（00-conventions「通用请求头」）。没给的就不填 */
function detailOf(code: CreatorPlanChatErrorCode, headers?: PlanHeaders | null): PlanErrorDetail {
  const header = (name: string): string | undefined => headers?.get(name)?.trim() || undefined
  if (code === 'daily_limit_reached') {
    const reset = header('x-uebox-daily-reset')
    return { dailyResetAt: reset && !Number.isNaN(Date.parse(reset)) ? reset : nextUtcMidnight() }
  }
  if (code === 'quota_exhausted') {
    const limitedBy = LIMITED_BY.find((reason) => reason === header('x-uebox-quota-limited-by'))
    const reset = header('x-uebox-quota-reset')
    return {
      ...(limitedBy ? { limitedBy } : {}),
      ...(reset && !Number.isNaN(Date.parse(reset)) ? { quotaResetAt: reset } : {})
    }
  }
  return {}
}

/**
 * 这次失败是不是套餐那几种。是就回一个可以直接抛的错误，不是回 null（调用方照走原来的报错）。
 * 只对套餐来源的调用用它。401 顺手把「授权失效」记进套餐状态，卡片不用等下一次刷新清单才知道。
 *
 * 给了响应头就从里面取每日上限的重置时间、额度被压低的原因；没给也照样认得出错误码。
 */
export function planCallError(
  status: number,
  body: unknown,
  headers?: PlanHeaders | null
): CreatorPlanCallError | null {
  const code = creatorPlanChatError(status, planErrorCodeOf(body))
  if (!code) return null
  if (code === 'unauthorized') void markUnauthorized()
  return new CreatorPlanCallError(code, status, detailOf(code, headers))
}

/**
 * 是不是每日上限的 429。**不读走响应体**（用的是副本），调用方之后照常读。
 *
 * 用在「429 就再发一次」的地方：限流等几秒就好，每日上限要等到明天 —— 再发只是白挨一次拒。
 */
export async function isDailyLimitResponse(response: Response): Promise<boolean> {
  if (response.status !== 429) return false
  if (response.headers.get('x-uebox-daily-reset')) return true
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  return planErrorCodeOf(text) === 'daily_limit_reached'
}

/** 懒加载：planState 连着 electron，静态引会让每个引到适配器的测试都去碰它 */
async function markUnauthorized(): Promise<void> {
  try {
    const { readPlanState, updatePlanState } = await import('./planState')
    if (!(await readPlanState()).unauthorized) await updatePlanState({ unauthorized: true })
  } catch {
    // 记不上只是卡片晚一点知道，不影响这次报错
  }
}
