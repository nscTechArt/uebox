import { shallowRef } from 'vue'
import {
  isNavigationFailure,
  NavigationFailureType,
  type RouteLocationNormalized,
  type Router
} from 'vue-router'

// Owned by navigation, so it can render before a lazy page or its data guard resolves.
export const pendingPage = shallowRef<RouteLocationNormalized | null>(null)

export function installPageLoading(router: Router): void {
  let target: RouteLocationNormalized | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  router.beforeEach((to, from) => {
    clearTimeout(timer)
    target = to
    pendingPage.value = null
    if (
      (from.matched.length > 0 && to.path === from.path) ||
      to.meta.standalone ||
      !/^\/(?:$|aigc-studio(?:\/|$)|asset-management(?:\/|$)|blueprint-library(?:\/|$)|material-library(?:\/|$)|notebooks(?:\/|$))/.test(
        to.path
      )
    )
      return
    // Cached navigation should not flash a placeholder.
    timer = setTimeout(() => {
      pendingPage.value = to
    }, 100)
  })

  const finish = (to: RouteLocationNormalized): void => {
    // An older, cancelled navigation must not clear the newer page's feedback.
    if (target !== to) return
    clearTimeout(timer)
    target = null
    pendingPage.value = null
  }
  router.afterEach((to, _from, failure) => {
    // Clicking the still-current page cancels an in-flight navigation without
    // running beforeEach (Vue Router calls it a duplicated navigation).
    if (isNavigationFailure(failure, NavigationFailureType.duplicated) && target) {
      finish(target)
    } else {
      finish(to)
    }
  })
  router.onError((_error, to) => finish(to))
}
