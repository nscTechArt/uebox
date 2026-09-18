import { onActivated, onDeactivated, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 库类页面 Layout 壳（BlueprintLibraryLayout / MaterialLibraryLayout 的同构逻辑）。
 *
 * 职责：
 * - keep-alive 路由快照：激活时跟随 fullPath，失活时冻结，防止缓存期间全局
 *   $route 变化导致子组件被销毁
 * - 激活期间把路由参数 id 同步给 store 的活跃条目（失活期间不同步，防污染）
 * - 可选：把 `_tab_id`（编辑器专用 tab 实例）同步给需要的 store（蓝图库需要，
 *   材质库暂无对应状态）
 */
export function useLibraryLayout(options: {
  /** 路由 params.id 变化时同步（null 表示回到列表页） */
  syncActiveId: (id: string | null) => void
  /** `_tab_id` 变化时同步（onActivated 与 watch 两个时机都会触发） */
  onEditorTabIdChange?: (tabId: string) => void
}): { isLayoutActive: Ref<boolean>; cachedRouteKey: Ref<string> } {
  const route = useRoute()
  const { syncActiveId, onEditorTabIdChange } = options

  const isLayoutActive = ref(true)
  const cachedRouteKey = ref(route.fullPath)

  function getEditorTabId(): string {
    const tabId = route.query._tab_id
    return typeof tabId === 'string' && tabId.trim() ? tabId : 'default'
  }

  watch(
    () => route.fullPath,
    (newPath) => {
      if (isLayoutActive.value) {
        cachedRouteKey.value = newPath
      }
    }
  )

  onActivated(() => {
    isLayoutActive.value = true
    cachedRouteKey.value = route.fullPath
    onEditorTabIdChange?.(getEditorTabId())
  })

  onDeactivated(() => {
    isLayoutActive.value = false
  })

  if (onEditorTabIdChange) {
    watch(
      () => route.query._tab_id,
      () => {
        if (isLayoutActive.value) {
          onEditorTabIdChange(getEditorTabId())
        }
      },
      { immediate: true }
    )
  }

  watch(
    () => route.params.id,
    (newId) => {
      if (!isLayoutActive.value) return
      if (newId && typeof newId === 'string') {
        syncActiveId(newId)
        return
      }
      syncActiveId(null)
    },
    { immediate: true }
  )

  return { isLayoutActive, cachedRouteKey }
}
