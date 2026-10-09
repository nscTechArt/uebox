import {
  defaultAgentBinding,
  isAgentBindingAvailable,
  type SettingsView
} from '@core/shared/aiProvider'
import type { SessionModel } from '@renderer/store/modules/chatSessions'

export interface SessionModelDeps {
  chatStore: {
    getModel: (id: string) => SessionModel | undefined
    setModel: (id: string, model: SessionModel) => void
    getAgentSessionId: (id: string) => string
  }
  /** 主进程执行记录里那份 */
  sessionModelOf: (agentSessionId: string) => Promise<SessionModel | null>
  getSettings: () => Promise<SettingsView>
}

export interface SessionModelResult {
  model: SessionModel | null
  /** 绑定的模型已经不在设置里了（来源或模型被删），这一轮主进程会退回全局默认 */
  unavailable: boolean
}

/**
 * 发消息前认定这条对话用哪个模型，没绑过就此绑定。
 *
 * 顺序：对话上记着的 → 主进程执行记录里的（存量对话、分支出来的对话）→
 * 此刻的全局默认。读不到设置时不拦发送，带着已知的那份交给主进程去判。
 */
export async function ensureSessionModel(
  chatSid: string,
  deps: SessionModelDeps
): Promise<SessionModelResult> {
  let model = deps.chatStore.getModel(chatSid) ?? null
  if (!model) {
    const agentSessionId = deps.chatStore.getAgentSessionId(chatSid)
    if (agentSessionId) model = await deps.sessionModelOf(agentSessionId).catch(() => null)
  }

  let settings: SettingsView
  try {
    settings = await deps.getSettings()
  } catch {
    if (model) deps.chatStore.setModel(chatSid, model)
    return { model, unavailable: false }
  }

  model ??= defaultAgentBinding(settings.roles)
  if (!model) return { model: null, unavailable: false }
  deps.chatStore.setModel(chatSid, model)
  return { model, unavailable: !isAgentBindingAvailable(settings, model) }
}
