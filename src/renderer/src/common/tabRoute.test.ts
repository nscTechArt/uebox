import { describe, expect, it } from 'vitest'
import type { RouteLocationMatched, RouteMeta, RouteLocationNormalizedLoaded } from 'vue-router'
import { resolveTabRoute } from './tabRoute'

type TestRoute = Pick<RouteLocationNormalizedLoaded, 'path' | 'fullPath' | 'meta' | 'query'> & {
  matched?: Array<Pick<RouteLocationMatched, 'path' | 'meta'>>
}

function createRoute(route: Partial<TestRoute> & Pick<TestRoute, 'path' | 'fullPath'>): TestRoute {
  return {
    meta: {} as RouteMeta,
    query: {},
    matched: [],
    ...route
  }
}

describe('resolveTabRoute', () => {
  it('uses the parent route key for nested detail routes that share a tab', () => {
    const route = createRoute({
      path: '/blueprint-library/blueprint-1',
      fullPath: '/blueprint-library/blueprint-1',
      meta: { isShowInTab: false, title: 'menu.blueprintDetail' } as RouteMeta,
      matched: [
        {
          path: '/blueprint-library',
          meta: { isShowInTab: true, title: 'menu.blueprintLib' } as RouteMeta
        },
        {
          path: '/blueprint-library/:id',
          meta: { isShowInTab: false, title: 'menu.blueprintDetail' } as RouteMeta
        }
      ]
    })

    expect(resolveTabRoute(route)).toEqual({
      key: '/blueprint-library',
      meta: { isShowInTab: true, title: 'menu.blueprintLib' }
    })
  })

  it('keeps dedicated tab instances keyed by fullPath when _tab_id is present', () => {
    const route = createRoute({
      path: '/asset-management',
      fullPath: '/asset-management?_tab_id=123',
      meta: { isShowInTab: true, title: 'menu.assetLib' } as RouteMeta,
      query: { _tab_id: '123' }
    })

    expect(resolveTabRoute(route)).toEqual({
      key: '/asset-management?_tab_id=123',
      meta: { isShowInTab: true, title: 'menu.assetLib' }
    })
  })

  it('returns null for spotlight routes', () => {
    const route = createRoute({
      path: '/spotlight',
      fullPath: '/spotlight',
      meta: { isShowInTab: false } as RouteMeta
    })

    expect(resolveTabRoute(route)).toBeNull()
  })
})
