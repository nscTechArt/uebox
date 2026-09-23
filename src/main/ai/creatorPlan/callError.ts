/**
 * 非对话角色调套餐来源失败时的错误：402 没订阅 / 额度用完、403 套餐不含这个角色、401 Key 失效。
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

import { creatorPlanChatError, type CreatorPlanChatErrorCode } from '../../../shared/creatorPlan'

const MESSAGES: Readonly<Record<CreatorPlanChatErrorCode, string>> = Object.freeze({
  subscription_inactive:
    '创作者 Token Plan 没有生效的订阅（或续费失败已过宽限期）。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」处理；处理好之前重试也一样失败。',
  quota_exhausted:
    '创作者 Token Plan 这一项本周期的额度用完了。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」升级，或等额度重置；现在重试也一样失败。',
  role_not_in_plan:
    '当前的创作者 Token Plan 套餐不含这个角色。' +
    '到 设置 → 模型 的套餐卡片点「管理订阅」换档，或把这个角色换绑到别的来源。',
  unauthorized:
    '创作者 Token Plan 的授权失效了（Key 被吊销或删除）。到 设置 → 模型 的套餐卡片重新连接。'
})

export class CreatorPlanCallError extends Error {
  constructor(
    readonly planError: CreatorPlanChatErrorCode,
    readonly status: number
  ) {
    super(MESSAGES[planError])
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

/**
 * 这次失败是不是套餐那几种。是就回一个可以直接抛的错误，不是回 null（调用方照走原来的报错）。
 * 只对套餐来源的调用用它。401 顺手把「授权失效」记进套餐状态，卡片不用等下一次刷新清单才知道。
 */
export function planCallError(status: number, body: unknown): CreatorPlanCallError | null {
  const code = creatorPlanChatError(status, planErrorCodeOf(body))
  if (!code) return null
  if (code === 'unauthorized') void markUnauthorized()
  return new CreatorPlanCallError(code, status)
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
