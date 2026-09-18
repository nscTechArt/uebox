import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UserSection from './UserSection.vue'
const routerPush = vi.hoisted(() => vi.fn())

// 组件用 useRouter()，测试里不需要真实路由。
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: routerPush }) }
})

function mountUserSection(): ReturnType<typeof mount> {
  return mount(UserSection, {
    props: {
      collapsed: false
    }
  })
}

beforeEach(() => {
  Object.assign(window.api, {
    system: {
      getInfo: vi.fn().mockResolvedValue({ appVersion: '0.1.20' })
    }
  })
})

describe('UserSection 的社区版边界', () => {
  it('社区版不出现订阅、个人中心、推广与退出登录入口', () => {
    const wrapper = mountUserSection()
    const text = wrapper.text()

    expect(text).not.toContain('订阅会员')
    // 个人中心只承载账号资料、订阅与设备管理，社区版整页不存在
    expect(text).not.toContain('个人中心')
    expect(text).not.toContain('推广中心')
    expect(text).not.toContain('退出登录')
    // FREE 订阅徽章
    expect(wrapper.find('.subscription-badge').exists()).toBe(false)
    expect(wrapper.find('.pro-card').exists()).toBe(false)
  })

  it('社区版显示设置图标和版本号，不再显示 local 或用户浮窗', async () => {
    const wrapper = mountUserSection()

    await flushPromises()

    expect(wrapper.find('.preferences-icon').exists()).toBe(true)
    expect(wrapper.get('.version').text()).toBe('v0.1.20')
    expect(wrapper.text()).not.toContain('local')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.user-popover-panel').exists()).toBe(false)
  })

  it('社区版点击左下角直接进入偏好设置', async () => {
    const wrapper = mountUserSection()
    const shortcut = wrapper.get('button.preferences-shortcut')

    expect(shortcut.attributes('aria-label')).toBe('偏好设置')

    await shortcut.trigger('click')

    expect(routerPush).toHaveBeenCalledOnce()
    expect(routerPush).toHaveBeenCalledWith('/preferences')
  })
})
