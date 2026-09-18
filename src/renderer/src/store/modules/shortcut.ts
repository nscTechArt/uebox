import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Shortcut {
  id: number
  action_key: string
  accelerator: string
  type: 'global' | 'local'
  enabled: boolean
  description: string
  is_locked: boolean
  updated_at: string
}

/**
 * 快捷键注册状态
 */
export interface ShortcutRegistrationStatus {
  shortcut: string
  registered: boolean
  error?: string
}

/**
 * 快捷键冲突信息
 */
export interface ShortcutConflict {
  actionKey: string
  shortcut: string
  error: string
}

export const useShortcutStore = defineStore('shortcut', () => {
  const shortcuts = ref<Shortcut[]>([])
  const isEnabled = ref(true)
  /** 快捷键冲突列表 */
  const conflicts = ref<ShortcutConflict[]>([])

  const fetchSettings = async (): Promise<void> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'db:settings:get',
        'shortcuts_enabled',
        true
      )
      if (result.success) {
        isEnabled.value = result.data
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error)
    }
  }

  const fetchShortcuts = async (): Promise<void> => {
    try {
      await fetchSettings()
      const result = await window.electron.ipcRenderer.invoke('db:shortcut:getAll')
      if (result.success) {
        shortcuts.value = result.data
      }
    } catch (error) {
      console.error('Failed to fetch shortcuts:', error)
    }
  }

  const toggleMasterSwitch = async (value: boolean): Promise<void> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'db:settings:set',
        'shortcuts_enabled',
        value
      )
      if (result.success) {
        isEnabled.value = value
      }
    } catch (error) {
      console.error('Failed to toggle master switch:', error)
    }
  }

  const updateShortcut = async (
    actionKey: string,
    updates: Partial<Shortcut>
  ): Promise<boolean> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'db:shortcut:update',
        actionKey,
        updates
      )
      if (result.success) {
        // Optimistic update
        const index = shortcuts.value.findIndex((s) => s.action_key === actionKey)
        if (index !== -1) {
          shortcuts.value[index] = { ...shortcuts.value[index], ...updates }
        }
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to update shortcut:', error)
      return false
    }
  }

  /**
   * 重置所有快捷键为默认设置
   */
  const resetToDefault = async (): Promise<boolean> => {
    try {
      const result = await window.electron.ipcRenderer.invoke('db:shortcut:resetAll')
      if (result.success) {
        // 重新获取最新的快捷键列表
        await fetchShortcuts()
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to reset shortcuts to default:', error)
      return false
    }
  }

  /**
   * 哪些热键没能注册到操作系统。
   *
   * 数据源是 ShortcutService 真实的注册结果。这里以前读的是 `spotlight:getShortcutStatus`，
   * 而那个状态在 spotlightManager 里被写死成 `registered: true` —— 冲突横幅因此永远不会亮，
   * 用户改了个被占用的热键，界面显示正常、按下去没反应，无从排查。
   */
  const fetchConflicts = async (): Promise<void> => {
    try {
      const result = await window.electron.ipcRenderer.invoke('db:shortcut:getRegistrationStatus')
      if (!result?.success) {
        conflicts.value = []
        return
      }
      const results = (result.data ?? []) as Array<{
        actionKey: string
        accelerator: string
        registered: boolean
        reason?: string
      }>
      conflicts.value = results
        .filter((item) => !item.registered)
        .map((item) => ({
          actionKey: item.actionKey,
          shortcut: item.accelerator,
          // 主进程只回码，措辞归界面 —— OCCUPIED 是唯一有专门文案的那一种
          error: item.reason === 'OCCUPIED' ? '' : item.reason || ''
        }))
    } catch (error) {
      console.warn('Failed to fetch shortcut registration status:', error)
      conflicts.value = []
    }
  }

  return {
    shortcuts,
    isEnabled,
    conflicts,
    fetchShortcuts,
    fetchConflicts,
    updateShortcut,
    toggleMasterSwitch,
    resetToDefault
  }
})
