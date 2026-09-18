import { describe, expect, it, vi } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'

/**
 * 项目库（原「首页」）在路由表里的三条约定。
 *
 * 这三条都只写在 meta 里，改错了界面上不会报错，只会安静地变回旧样子：
 * 标签又关不掉、侧边栏里跑到资产库下面去、或者干脆从菜单消失。
 */

// mainRoutes 直接 import 了 MainLayout，而它经 store 又回头 import router/index.ts，
// 形成循环依赖。这里只关心路由表本身，把布局组件打桩断开这条链。
vi.mock('@renderer/layout/MainLayout.vue', () => ({
  default: { name: 'MainLayoutStub', template: '<div />' }
}))

async function loadChildren(): Promise<RouteRecordRaw[]> {
  vi.resetModules()
  const module = await import('./mainRoutes')
  return (module.default.children ?? []) as RouteRecordRaw[]
}

describe('项目库路由', () => {
  it('标题指向项目库的多语言键', async () => {
    const projectLib = (await loadChildren()).find((route) => route.path === '')

    expect(projectLib?.meta?.title).toBe('menu.projectLib')
  })

  /** 「不锁死」：能关、能拖、能取消固定，和别的标签页一视同仁 */
  it('是一个普通标签页，不固定也不禁止关闭', async () => {
    const projectLib = (await loadChildren()).find((route) => route.path === '')

    expect(projectLib?.meta?.fixed).toBe(false)
    expect(projectLib?.meta?.isCanDelete).toBe(true)
  })

  it('在侧边栏里排在资产库上面', async () => {
    const children = await loadChildren()
    const projectLib = children.find((route) => route.path === '')
    const assetLib = children.find((route) => route.path === '/asset-management')

    expect(projectLib?.meta?.isShowInMenu).toBe(true)
    expect(Number(projectLib?.meta?.sort)).toBeLessThan(Number(assetLib?.meta?.sort))
  })
})
