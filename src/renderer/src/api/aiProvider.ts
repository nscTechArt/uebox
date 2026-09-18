import { unwrapResult } from '@renderer/common/utils'
import { invalidateModelLimitsCache } from '@renderer/services/notebook/contextBudget'
import type {
  AiProviderResult,
  ModelBinding,
  RoleBindings,
  SettingsView
} from '@core/shared/aiProvider'

function unwrapAiProviderResult<T>(result: AiProviderResult<T>, defaultError: string): T {
  if (result.ok) {
    return unwrapResult({ success: true, data: result.data }, defaultError)
  }
  return unwrapResult({ success: false, data: undefined as T, error: result.error }, defaultError)
}

/**
 * AI Provider IPC 的渲染层入口。
 *
 * setRoles 收的是整张角色表，所以切 Agent 时必须保留其它角色；同时把响应式对象
 * 拍成普通对象，避免 Vue Proxy 在 Electron 的结构化克隆阶段被拒绝。
 */
export const aiProviderAPI = {
  getSettings(): Promise<SettingsView> {
    return window.api.aiProvider.getSettings()
  },

  async setAgentRole(
    currentRoles: RoleBindings,
    binding: ModelBinding,
    defaultError = '切换 Agent 模型失败'
  ): Promise<SettingsView> {
    const roles = JSON.parse(JSON.stringify(currentRoles)) as RoleBindings
    roles.agent = { providerId: binding.providerId, modelId: binding.modelId }
    const result = await window.api.aiProvider.setRoles(roles)
    const view = unwrapAiProviderResult(result, defaultError)
    // 换了模型，按角色缓存的窗口/输出上限立刻作废，别让预算继续按上一个模型算
    invalidateModelLimitsCache()
    return view
  }
}
