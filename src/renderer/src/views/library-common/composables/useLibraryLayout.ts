import {
  computed,
  onActivated,
  onDeactivated,
  provide,
  ref,
  shallowReactive,
  shallowRef,
  watch
} from 'vue'
import type { ComputedRef, ShallowRef } from 'vue'
import { routeLocationKey, START_LOCATION, useRouter } from 'vue-router'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { getTabCacheKey, getTabIdFromQuery } from '@renderer/common/tabRoute'
import { useTabsStore } from '@renderer/store/modules/tabs'

/**
 * 嵌套库 Layout 壳（BlueprintLibraryLayout / MaterialLibraryLayout / NotebookLayout）。
 *
 * Layout 被 MainLayout 的 keep-alive 按 tab 缓存，一个实例对应一个 tab。但全局路由不会
 * 因为它被缓存而停止变化：切到别的 tab 后，内层 `<router-view>` 和子页中的 `useRoute()`
 * 仍会跟随全局路由 —— 切到别的模块时子页被卸载，切到同一 Layout 的另一个 tab 时，
 * 缓存中还会出现那个 tab 的子页。
 *
 * 因此这里为每个实例维护一份**冻结的路由**：只有当前路由仍属于这个 tab（cache key 与
 * 创建时相同）时才更新。内层 `<router-view :route="viewRoute">` 按它渲染，子树中的
 * `useRoute()` 也会拿到它。归属判断不能依赖 onDeactivated 设置的标记：路由变化的 watch
 * 先于 deactivated 触发，那时标记还没有更新。
 *
 * provide 使用的 `routeLocationKey` 在 vue-router 中标记为 `@internal`，写法参照了
 * vue-router 自身 `app.provide` 的实现；升级 vue-router 时，由 useLibraryLayout.test.ts 发现不兼容。
 * 只有 `useRoute()` 和 RouterLink 会读取这份 provide，拿到本 tab 的路由；模板中的 `$route`、
 * `router.currentRoute` 读取的仍是全局路由。子树中需要本 tab 的路由时，一律使用 `useRoute()`。
 *
 * 同时把本 tab 的 `_tab_id` 和路由参数 id 同步给 store：冻结路由每变化一次（包括从
 * 别的 tab 切回，期间别的 tab 可能修改过 store）就同步一次。同步发生在路由变化的那一刻，
 * 而不是 onActivated：子页的 activated 先于 Layout 执行，如果等 Layout 再同步，子页读到的
 * 就是别的 tab 的状态。
 *
 * tab 关闭后释放子页（`keepChild`）：MainLayout 的 keep-alive 不会因关闭 tab 而清理缓存，
 * 被冻结的子页会一直占用内存，直到超出 max 被淘汰。Layout 壳本身仍保留在缓存中。
 */
export function useLibraryLayout(options: {
  /** 同步路由参数 id（null 表示列表页） */
  syncActiveId: (id: string | null) => void
  /** 同步 `_tab_id`（没有时为 'default'），先于 syncActiveId */
  syncTabId?: (tabId: string) => void
}): {
  viewRoute: ShallowRef<RouteLocationNormalizedLoaded>
  keepChild: ComputedRef<boolean>
} {
  const router = useRouter()
  const tabsStore = useTabsStore()
  const { syncActiveId, syncTabId } = options

  const ownTabKey = getTabCacheKey(router.currentRoute.value)
  const viewRoute = shallowRef(router.currentRoute.value)

  watch(
    router.currentRoute,
    (route) => {
      if (getTabCacheKey(route) === ownTabKey) {
        viewRoute.value = route
      }
    },
    // 必须在内层 <router-view> 重新渲染之前确定
    { flush: 'sync' }
  )

  // 与 vue-router 自身注入的 route 结构相同：每个字段一个 getter
  const frozenRoute = {} as RouteLocationNormalizedLoaded
  for (const key in START_LOCATION) {
    Object.defineProperty(frozenRoute, key, {
      get: () => viewRoute.value[key as keyof RouteLocationNormalizedLoaded],
      enumerable: true
    })
  }
  provide(routeLocationKey, shallowReactive(frozenRoute))

  watch(
    viewRoute,
    (route) => {
      // tab id 要先于 active id：store 按 tab 存 active id
      syncTabId?.(getTabIdFromQuery(route.query))
      const id = route.params.id
      syncActiveId(typeof id === 'string' && id ? id : null)
    },
    // sync：切回本 tab 时要赶在子页的 activated 之前
    { immediate: true, flush: 'sync' }
  )

  // 只用于决定是否释放子页，不用于判断路由归属（后者必须用 cache key，见上）
  const isActive = ref(true)
  onActivated(() => {
    isActive.value = true
  })
  onDeactivated(() => {
    isActive.value = false
  })

  /**
   * 依赖 router.afterEach 中的 addTab：它会为每个实例创建一个 tab。
   * 这里用 isActive，而不是判断当前路由是否属于自己：子页的 deactivated 钩子先于 Layout 执行，
   * 等 Layout 更新标记时，子页已完成失活（写回未保存的代码），之后才卸载。
   */
  const keepChild = computed(
    () => isActive.value || tabsStore.historyTabs.some((tab) => tab.key === ownTabKey)
  )

  return { viewRoute, keepChild }
}
