import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import LanguageGate from './LanguageGate.vue'
const routerReplace = vi.hoisted(() => vi.fn())
const setLocaleMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/i18n')>()
  return { ...actual, setLocale: setLocaleMock }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ replace: routerReplace }) }
})

// mainRoutes 直接 import MainLayout，而它经 store 又回头 import router/index.ts。
// 这里只关心路由表本身，把布局组件打桩断开这条链。
vi.mock('@renderer/layout/MainLayout.vue', () => ({
  default: { name: 'MainLayoutStub', template: '<div />' }
}))

beforeEach(() => {
  setActivePinia(createPinia())
  routerReplace.mockClear()
  setLocaleMock.mockClear()
})

async function chooseFirstLanguage(): Promise<void> {
  const wrapper = mount(LanguageGate)
  await wrapper.findAll('button.option')[0].trigger('click')
}

describe('LanguageGate 选完语言之后的落点', () => {
  it('完成语言选择后进入首页', async () => {
    await chooseFirstLanguage()

    expect(setLocaleMock).toHaveBeenCalledWith('zh-CN')
    expect(routerReplace).toHaveBeenCalledWith('/')
    expect(routerReplace).not.toHaveBeenCalledWith('/auth/login')
  })

  /**
   * 上一条断言的是「跳 `/`」这个具体值，改需求时容易被顺手改掉。
   * 这条守的是背后的**不变量**：语言门的目的地必须在核心路由表里真的存在。
   */
  it('语言门的目的地在核心路由表里解析得出来', async () => {
    await chooseFirstLanguage()

    const target = routerReplace.mock.calls[0][0] as string
    const routesDefault = (await import('@renderer/router/modules')).default
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [...routesDefault] as RouteRecordRaw[]
    })

    expect(router.resolve(target).matched.length).toBeGreaterThan(0)
    // 反证：登录页在公开核心里确实解析不出来，所以当初那一跳必然落到 404
    expect(router.resolve('/auth/login').matched.map((r) => r.name)).toEqual(['NotFoundRedirect'])
  })
})

describe('LanguageGate 的说明文案', () => {
  it('社区版不承诺「支付方式」—— 这里没有支付这回事', () => {
    const wrapper = mount(LanguageGate)

    expect(wrapper.text()).not.toContain('支付')
    expect(wrapper.text()).not.toContain('payment')
  })
})
