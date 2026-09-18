import { unwrapResult } from '@renderer/common/utils'

export type AppIconTheme = 'light' | 'dark'

/** 「设置 → 工具」那一页要读回的两份名单，加上当前是不是工具搜索模式 */
export interface AgentToolPreferences {
  toolSearchEnabled: boolean
  /** 全量模式下关掉的工具名 */
  disabledTools: string[]
  /** 工具搜索模式下偏离内置常驻清单的那些 */
  residentTools: Record<string, boolean>
}

export const appSettingsAPI = {
  async getToolSearchEnabled(): Promise<boolean> {
    return (await window.api.appSettings.get()).agentToolSearchEnabled === true
  },
  async setToolSearchEnabled(enabled: boolean): Promise<void> {
    const result = await window.api.appSettings.set({ agentToolSearchEnabled: enabled })
    unwrapResult({ ...result, data: undefined })
  },
  /** 一次读全：这一页三样东西要同时到位才知道每个开关该画成什么样 */
  async getToolPreferences(): Promise<AgentToolPreferences> {
    const settings = await window.api.appSettings.get()
    return {
      toolSearchEnabled: settings.agentToolSearchEnabled === true,
      disabledTools: settings.agentDisabledTools ?? [],
      residentTools: settings.agentResidentTools ?? {}
    }
  },
  async setDisabledTools(names: string[]): Promise<void> {
    const result = await window.api.appSettings.set({ agentDisabledTools: names })
    unwrapResult({ ...result, data: undefined })
  },
  async setResidentTools(overrides: Record<string, boolean>): Promise<void> {
    const result = await window.api.appSettings.set({ agentResidentTools: overrides })
    unwrapResult({ ...result, data: undefined })
  },
  async setThemeIcon(theme: AppIconTheme): Promise<boolean> {
    const result = await window.api.appSettings.setThemeIcon(theme)
    return unwrapResult(result, '切换任务栏图标失败')
  }
}
