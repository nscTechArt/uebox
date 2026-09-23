/**
 * 对话里的创作者 Token Plan 错误提示。
 *
 * 调套餐来源时服务端回 402 没订阅 / 额度用完、403 套餐不含这个角色、401 Key 失效，
 * 主进程在 `agent-v3:error` 上带一个 `planError`（只有套餐来源会带，见 eventBridge.ts）。
 * 这里把它变成一条带按钮的提示：前三种「管理订阅」打开清单里的 manage_url，
 * 401「去重新连接」跳到「设置 → 模型」。都是不改就一定再失败的错，不挂「接着跑」。
 *
 * 按钮的动作在气泡上直接处理（AIBubble 的 emitAction），不冒到页面：
 * 放在页面那层的话，气泡换个宿主就得再接一遍。
 */

import type { CreatorPlanChatErrorCode } from '@core/shared/creatorPlan'
import { creatorPlanAPI } from '@renderer/api/creatorPlan'

export const CREATOR_PLAN_MANAGE_ACTION = 'creator-plan-manage'
export const CREATOR_PLAN_RECONNECT_ACTION = 'creator-plan-reconnect'

const CODES: readonly CreatorPlanChatErrorCode[] = [
  'subscription_inactive',
  'quota_exhausted',
  'role_not_in_plan',
  'unauthorized'
]

export function isCreatorPlanChatErrorCode(value: unknown): value is CreatorPlanChatErrorCode {
  return CODES.includes(value as CreatorPlanChatErrorCode)
}

export interface CreatorPlanErrorInfo {
  toast: string
  display: string
  type: 'warning'
  fatal: true
  actionButtons: Array<{ label: string; action: string }>
}

export function creatorPlanErrorInfo(
  code: CreatorPlanChatErrorCode,
  t: (key: string) => string
): CreatorPlanErrorInfo {
  const title = t(`aiProvider.creatorPlan.chat.${code}.title`)
  const desc = t(`aiProvider.creatorPlan.chat.${code}.desc`)
  const button =
    code === 'unauthorized'
      ? { label: t('aiProvider.creatorPlan.chat.reconnect'), action: CREATOR_PLAN_RECONNECT_ACTION }
      : { label: t('aiProvider.creatorPlan.chat.manage'), action: CREATOR_PLAN_MANAGE_ACTION }
  return {
    toast: title,
    display: `**${title}**\n\n${desc}`,
    type: 'warning',
    fatal: true,
    actionButtons: [button]
  }
}

export function isCreatorPlanAction(action: string): boolean {
  return action === CREATOR_PLAN_MANAGE_ACTION || action === CREATOR_PLAN_RECONNECT_ACTION
}

/**
 * 处理气泡上的套餐按钮。不是套餐按钮回 false，调用方接着走自己的分派。
 * `openModelSettings` 由气泡注入（它手里有 router）。
 */
export async function runCreatorPlanAction(
  action: string,
  openModelSettings: () => void | Promise<unknown>
): Promise<boolean> {
  if (action === CREATOR_PLAN_MANAGE_ACTION) {
    await creatorPlanAPI.openManage()
    return true
  }
  if (action === CREATOR_PLAN_RECONNECT_ACTION) {
    await openModelSettings()
    return true
  }
  return false
}
