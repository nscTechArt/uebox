import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SideMenu from './SideMenu.vue'
import {
  installObserverStubs,
  installWindowApiStub
} from '../../../../../tests/utils/componentMount'

/**
 * SideMenu → ChatSessionList 的连线断言。
 *
 * `tsconfig.web.json` 没开 `strictTemplates`，prop 名改漏一边只会表现为
 * 高亮跟不上当前对话、点条目没反应 —— 挂起来断言编译后的 props 和监听器。
 */

const { routerPush, currentRoute } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  currentRoute: {
    query: { sid: 'chat-7' as string },
    params: {},
    path: '/',
    fullPath: '/',
    name: 'AssistantWelcome' as string | undefined,
    meta: {}
  }
}))

// usePluginInstallNotice 顶层 import 真 router 实例；这条链从 router/modules
// 半路回头去摸还没初始化完的 routesDefault。断在 hook 上（仓里既有先例），
// 比 mock 掉 router/modules 好：SideMenu 的菜单生成吃的是真路由表
vi.mock('@renderer/hooks/usePluginInstallNotice', () => ({
  notifyPluginInstallFailure: vi.fn(),
  notifyPluginUpgradeFailure: vi.fn()
}))

// SideMenu 的依赖链会在模块加载时建真路由实例（usePluginInstallNotice →
// router/index.ts 顶层调 createRouter），createRouter 这些导出必须留着
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => currentRoute,
    useRouter: () => ({
      push: routerPush,
      replace: vi.fn(),
      back: vi.fn(),
      afterEach: vi.fn(),
      currentRoute: { value: currentRoute }
    })
  }
})

const stubs = {
  ChatSessionList: {
    name: 'ChatSessionList',
    props: { activeChatSid: String, collapsed: Boolean },
    template: '<div />'
  },
  UserSection: true,
  SidebarToolsCustomize: true,
  BrandMark: true,
  AppTooltip: true
}

function mountSideMenu(): ReturnType<typeof mount> {
  return mount(SideMenu, {
    props: { collapsed: false, peeking: false },
    global: { stubs }
  })
}

beforeEach(() => {
  installWindowApiStub()
  installObserverStubs()
  routerPush.mockClear()
})

describe('SideMenu 连线', () => {
  it('当前路由的对话以 activeChatSid 传给 <ChatSessionList>', () => {
    const list = mountSideMenu().findComponent({ name: 'ChatSessionList' })
    expect(list.exists()).toBe(true)
    expect(list.props('activeChatSid')).toBe('chat-7')
    expect(list.props('collapsed')).toBe(false)
    expect(list.vm.$attrs.activeSessionId).toBeUndefined()
  })

  it('open / new-chat 事件接到导航上', () => {
    const list = mountSideMenu().findComponent({ name: 'ChatSessionList' })
    expect(typeof list.vm.$attrs.onOpen).toBe('function')
    expect(typeof list.vm.$attrs.onNewChat).toBe('function')

    list.vm.$emit('open', 'chat-9')
    expect(routerPush).toHaveBeenCalledTimes(1)

    list.vm.$emit('new-chat')
    expect(routerPush).toHaveBeenCalledTimes(2)
    expect(routerPush).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'AssistantWelcome' })
    )
  })
})
