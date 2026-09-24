import { unwrapResult } from '@renderer/common/utils'
import { invalidateModelLimitsCache } from '@renderer/services/notebook/contextBudget'
import type { AiProviderResult, ModelBinding, SettingsView } from '@core/shared/aiProvider'

function unwrapAiProviderResult<T>(result: AiProviderResult<T>, defaultError: string): T {
  if (result.ok) {
    return unwrapResult({ success: true, data: result.data }, defaultError)
  }
  return unwrapResult({ success: false, data: undefined as T, error: result.error }, defaultError)
}

/**
 * AI Provider IPC 的渲染层入口。
 *
 * setRoles 只收改了的那几个角色，主进程在最新的配置上合并 —— 切 Agent 只发 agent，
 * 别的角色不用（也不该）带上：手里那张表可能已经旧了，带上就把后台刚写的盖掉。
 * 发出去的是新建的普通对象，不会夹带 Vue Proxy（Electron 的结构化克隆会拒绝它）。
 */
export const aiProviderAPI = {
  getSettings(): Promise<SettingsView> {
    return window.api.aiProvider.getSettings()
  },

  async setAgentRole(
    binding: ModelBinding,
    defaultError = '切换 Agent 模型失败'
  ): Promise<SettingsView> {
    const result = await window.api.aiProvider.setRoles({
      agent: { providerId: binding.providerId, modelId: binding.modelId }
    })
    const view = unwrapAiProviderResult(result, defaultError)
    // 换了模型，按角色缓存的窗口/输出上限立刻作废，别让预算继续按上一个模型算
    invalidateModelLimitsCache()
    return view
  }
}
