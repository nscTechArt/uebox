import { describe, expect, it, vi } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'

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

describe('mainRoutes 的社区版边界', () => {
  it('社区版剔除所有 commercialOnly 路由', async () => {
    const children = await loadChildren()

    expect(children.filter((route) => route.meta?.commercialOnly)).toHaveLength(0)
  })

  it('社区版保留偏好设置与首页这类本地路由', async () => {
    const children = await loadChildren()
    const paths = children.map((route) => route.path)

    expect(paths).toContain('/preferences')
    expect(paths).toContain('')
  })

  it('切换应用 Tab 后保留偏好设置当前页面', async () => {
    const preferences = (await loadChildren()).find((route) => route.path === '/preferences')

    expect(preferences?.meta?.keepAlive).toBe(true)
  })

  it('保留 AI 创作入口，但不显示 AIGC 徽标', async () => {
    const children = await loadChildren()
    const aigcRoute = children.find((route) => route.path === '/aigc-studio')

    expect(aigcRoute).toBeDefined()
    expect(aigcRoute?.meta?.isShowInMenu).toBe(true)
    expect(aigcRoute?.meta?.isAIGC).toBeUndefined()
  })

  /** 已移除的账户页面不能再次进入路由。 */
  it('不注册已移除的账户页面', async () => {
    // 个人中心（账号资料/订阅/设备）、团队协作、共创市场、推广中心
    const commercialPaths = ['/profile', '/team', '/co-create-market', '/referral']

    const paths = (await loadChildren()).map((route) => route.path)
    for (const path of commercialPaths) {
      expect(paths, `${path} 不该出现在公开仓库的路由表里`).not.toContain(path)
    }
  })

  /**
   * 公开核心里不该再有区域门禁。
   *
   * 这条守的是一次真实的漏网：`/aigc-studio` 曾被标 `meta.cnOnly`，理由是
   * 「依赖 DashScope / 混元3D 等国内生态，且没有应用内计费载体」。这两条在社区版
   * 都不成立 —— 生图早就改成用户自带 Key 的本地模型，社区版也没有应用内钱包。
   * 结果是：只要把界面语言切成英文，region 就推导成 global，整个 AI 创作入口
   * 连同**唯一真能离线跑通的生图**一起被挡在门外。
   *
   * 而当时的测试只查路由表里有没有这一项，查不到守卫层，所以一直是绿的。
   */
  it('公开仓库不该有任何区域门禁标记', async () => {
    const children = await loadChildren()
    const gated = children.filter((route) => route.meta?.cnOnly)
    expect(
      gated.map((r) => r.path),
      '公开核心的功能对所有区域一视同仁'
    ).toEqual([])
  })

  /** 路由名重复会让 vue-router 静默丢掉后注册的那个，排查起来毫无线索 */
  it('没有重名或重复路径的路由', async () => {
    const children = await loadChildren()

    const names = children.map((route) => String(route.name ?? '')).filter(Boolean)
    expect(names.length, `路由名重复：${names.filter((n, i) => names.indexOf(n) !== i)}`).toBe(
      new Set(names).size
    )

    const paths = children.map((route) => route.path)
    expect(paths.length, `路径重复：${paths.filter((x, i) => paths.indexOf(x) !== i)}`).toBe(
      new Set(paths).size
    )
  })

  /** 测试页不该挂在正式路由上 —— 它会出现在标签页里，用户点得到 */
  it('不注册测试页路由', async () => {
    const paths = (await loadChildren()).map((route) => route.path)

    expect(paths).not.toContain('/screen-recorder-test')
  })
})
