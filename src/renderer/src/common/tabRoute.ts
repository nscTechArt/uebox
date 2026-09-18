import type { RouteLocationNormalizedLoaded, RouteMeta } from 'vue-router'

type MinimalMatchedRoute = {
  path: string
  meta: RouteMeta
}

type MinimalRouteLike = Pick<
  RouteLocationNormalizedLoaded,
  'path' | 'fullPath' | 'meta' | 'query'
> & {
  matched?: MinimalMatchedRoute[]
}

export interface ResolvedTabRoute {
  key: string
  meta: RouteMeta
}

function hasDedicatedTabInstance(route: MinimalRouteLike): boolean {
  const tabId = route.query?._tab_id
  return typeof tabId === 'string' && tabId.trim().length > 0
}

export function resolveTabRoute(route: MinimalRouteLike): ResolvedTabRoute | null {
  if (route.path === '/spotlight' || route.fullPath.startsWith('/spotlight')) {
    return null
  }

  if (hasDedicatedTabInstance(route)) {
    return {
      key: route.fullPath,
      meta: route.meta || {}
    }
  }

  const meta = route.meta || {}
  if (meta.isShowInTab === false) {
    const matched = route.matched || []
    for (let i = matched.length - 1; i >= 0; i--) {
      const parentMeta = matched[i].meta || {}
      if (parentMeta.isShowInTab === true) {
        return {
          key: matched[i].path,
          meta: parentMeta
        }
      }
    }
    return null
  }

  return {
    key: route.fullPath,
    meta
  }
}
