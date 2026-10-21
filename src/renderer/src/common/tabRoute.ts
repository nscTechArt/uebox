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

/** 路由带有非空的 `_tab_id`，说明它是专用 tab，缓存 key 使用 fullPath */
export function hasDedicatedTabInstance(route: MinimalRouteLike): boolean {
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

/**
 * 路由所在 tab 的 id，即 `_tab_id`；没有时为 'default'（模块默认的 tab）。
 * 笔记本、蓝图库按它分 tab 存状态。
 */
export function getTabIdFromQuery(query: Record<string, unknown>): string {
  const tabId = query._tab_id
  return typeof tabId === 'string' && tabId.trim() ? tabId : 'default'
}

/**
 * 主内容区 keep-alive 的缓存 key：一个 key 对应一个页面实例。
 *
 * 嵌套的库 Layout 也依靠它判断路由是否属于自己，所以两处必须使用同一个函数。
 */
export function getTabCacheKey(route: MinimalRouteLike): string {
  return resolveTabRoute(route)?.key || route.fullPath
}
