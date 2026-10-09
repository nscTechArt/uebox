import { defaultAgentBinding, isAgentBindingAvailable } from '../../../shared/aiProvider'
import { readSettings } from '../../ai/store'
import type { AiProviderSettings } from '../../ai/types'

export interface SessionModel {
  providerId: string
  modelId: string
}

export interface SessionModelPlan {
  /** 落进执行记录的那份。绑定的模型暂时用不了也照记，来源补回来就又能用 */
  record?: SessionModel
  /** 这一轮真正钉住的模型。用不了时不给，内核退回全局默认 */
  pin?: SessionModel
}

/**
 * 这一轮用哪个模型。
 *
 * 优先级：渲染层带下来的（用户在这条对话里选的）→ 执行记录里的（续跑、
 * 后台任务没有渲染层）→ 全局默认（这条对话第一轮，就此绑定）。
 */
export function planSessionModel(
  settings: Pick<AiProviderSettings, 'roles' | 'providers'>,
  requested: SessionModel | undefined,
  saved: SessionModel | undefined
): SessionModelPlan {
  const wanted = requested ?? saved ?? defaultAgentBinding(settings.roles)
  if (!wanted) return {}
  const record = { providerId: wanted.providerId, modelId: wanted.modelId }
  return isAgentBindingAvailable(settings, record) ? { record, pin: record } : { record }
}

export async function resolveSessionModel(
  sessionId: string,
  requested: SessionModel | undefined,
  saved: SessionModel | undefined
): Promise<SessionModelPlan> {
  let settings: AiProviderSettings
  try {
    settings = await readSettings()
  } catch (error) {
    // 读不到设置就不钉，也不记：内核自己再读一次，读不到会报出能看懂的错
    console.warn(`[AgentV3] 会话 ${sessionId} 读模型设置失败，这一轮不绑定模型:`, error)
    return {}
  }
  const plan = planSessionModel(settings, requested, saved)
  if (plan.record && !plan.pin) {
    console.warn(
      `[AgentV3] 会话 ${sessionId} 绑定的模型 ${plan.record.providerId}/${plan.record.modelId} ` +
        '已不可用，这一轮退回全局默认'
    )
  }
  return plan
}

/** 只问「这个模型现在能不能钉」，不记日志。给界面上那些按对话模型现问的下拉用 */
export async function pinnableSessionModel(
  model: SessionModel | undefined
): Promise<SessionModel | undefined> {
  return model ? planSessionModel(await readSettings(), model, undefined).pin : undefined
}
