import type { BrowserGroupState, BrowserNavigationState } from '../../../../../shared/agentBrowser'
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { agentBrowserAPI } from '@renderer/api/agentBrowser'

/** 异步恢复结果和广播都只允许更新所属会话。 */
export function useSessionBrowser(
  sessionId: Readonly<Ref<string>>,
  visible: Readonly<Ref<boolean>>,
  onError: (error: unknown) => void,
  displayMode: 'embedded' | 'window' = 'embedded'
): {
  open: Ref<boolean>
  url: Ref<string>
  navigation: Ref<BrowserNavigationState>
  group: Ref<BrowserGroupState>
} {
  const emptyNavigation = (): BrowserNavigationState => ({
    canGoBack: false,
    canGoForward: false,
    loading: false
  })
  const group = ref<BrowserGroupState>({ tabs: [], activeTabId: null })
  const navigation = ref(emptyNavigation())
  const url = ref('')
  const open = ref(false)
  let revision = 0
  let stateRevision = 0
  let handler: ((...args: unknown[]) => void) | null = null
  // 只有「进入这个会话」才允许恢复页面。折叠再展开面板不算进入 ——
  // 那样每展开一次就可能把远端页面重新拉起来，用户没做过这个动作。
  const restored = new Set<string>()

  watch(
    [sessionId, visible],
    async ([id, active], [previousId]) => {
      const request = ++revision
      const observedState = stateRevision
      if (id !== previousId) {
        group.value = { tabs: [], activeTabId: null }
        open.value = false
        url.value = ''
        navigation.value = emptyNavigation()
      }
      if (!id || !active) return
      const restore = !restored.has(id)
      restored.add(id)
      try {
        const state = await agentBrowserAPI.getState(id, restore)
        if (request === revision && observedState === stateRevision) {
          open.value = state.open && state.mode === displayMode
          group.value = { tabs: state.tabs ?? [], activeTabId: state.activeTabId ?? null }
          url.value = state.url
          navigation.value = state.navigation
        }
      } catch (error) {
        if (request === revision) onError(error)
      }
    },
    { immediate: true }
  )

  onMounted(() => {
    handler = window.api.on('agent-browser:state', (...args: unknown[]) => {
      const state = args[0] as
        | {
            tabs?: BrowserGroupState['tabs']
            activeTabId?: string | null
            sessionId?: string
            open?: boolean
            mode?: string
            url?: string
            navigation?: BrowserNavigationState
          }
        | undefined
      if (!state || state.sessionId !== sessionId.value) return
      // 关闭/切换模式的广播优先于先前发出的异步状态查询。
      stateRevision++
      open.value = Boolean(state.open) && state.mode === displayMode
      group.value = { tabs: state.tabs ?? [], activeTabId: state.activeTabId ?? null }
      url.value = state.url ?? ''
      navigation.value = state.navigation ?? emptyNavigation()
    })
  })

  onBeforeUnmount(() => {
    revision++
    if (handler) window.api.off('agent-browser:state', handler)
  })

  return { open, url, navigation, group }
}
