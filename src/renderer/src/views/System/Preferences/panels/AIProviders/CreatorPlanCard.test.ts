/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CreatorPlanCard from './CreatorPlanCard.vue'
import type { CreatorPlanPreview, CreatorPlanState } from '@core/shared/creatorPlan'

/**
 * 卡片三种样子：没连接（一个「连接」按钮）、已连接（套餐摘要 + 管理 / 重新导入 / 断开）、
 * 导入预览（默认勾选规则来自主进程，这里只守「按默认勾、按勾的应用」）。
 * 替身打在 window.api.creatorPlan 上，API 封装和组件都走真的。
 */

const stubs = {
  // 只渲染打开的弹窗，并把「确定」做成一个可点的按钮
  AppModal: {
    props: ['open', 'okText'],
    emits: ['ok', 'cancel'],
    template:
      '<div v-if="open" class="modal"><slot /><button class="modal-ok" @click="$emit(\'ok\')">{{ okText }}</button></div>'
  }
}

const notConnected: CreatorPlanState = {
  connected: false,
  summary: null,
  managedRoles: [],
  error: null
}

const connected: CreatorPlanState = {
  connected: true,
  managedRoles: ['agent', 'summary'],
  error: null,
  summary: {
    tierName: 'Pro',
    status: 'active',
    interval: 'month',
    currentPeriodEnd: '2026-10-01T00:00:00Z',
    cancelAtPeriodEnd: false,
    quotaResetsAt: '2026-10-01T00:00:00Z',
    manageUrl: 'https://plan.example/account/billing',
    textTokens: { limit: 1_000_000, used: 1234 }
  }
}

const preview: CreatorPlanPreview = {
  summary: connected.summary!,
  changes: [
    {
      role: 'chat',
      model: 'uebox-chat',
      modelDisplayName: 'Creator · Chat',
      current: { providerId: 'mine', modelId: 'gpt-x', providerName: 'Mine' },
      managed: false,
      defaultSelected: false
    },
    {
      role: 'agent',
      model: 'uebox-agent',
      modelDisplayName: 'Creator · Agent',
      current: null,
      managed: false,
      defaultSelected: true
    }
  ]
}

function stubApi(
  overrides: Record<string, unknown> = {}
): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    state: vi.fn(async () => ({ ok: true, data: notConnected })),
    connect: vi.fn(async () => ({ ok: true, data: preview })),
    preview: vi.fn(async () => ({ ok: true, data: preview })),
    apply: vi.fn(async () => ({ ok: true, data: connected })),
    disconnect: vi.fn(async () => ({ ok: true, data: null })),
    cancel: vi.fn(async () => {}),
    onDeviceCode: vi.fn(() => () => {}),
    ...overrides
  }
  window.api = {
    creatorPlan: api,
    shell: { openExternal: vi.fn() }
  } as unknown as typeof window.api
  return api
}

describe('CreatorPlanCard', () => {
  it('没连接：说明 + 「连接」按钮', async () => {
    stubApi()
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('一个订阅配好多个角色')
    expect(wrapper.text()).toContain('连接')
    expect(wrapper.text()).not.toContain('断开')
  })

  it('已连接：档位、额度、管着几个角色，以及管理 / 重新导入 / 断开', async () => {
    stubApi({ state: vi.fn(async () => ({ ok: true, data: connected })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Pro · 月付')
    expect(text).toContain('生效中')
    expect(text).toContain('1,234')
    expect(text).toContain('管理着 2 个角色')
    for (const label of ['管理订阅', '重新导入', '断开']) expect(text).toContain(label)
  })

  it('连接完成：按默认勾选弹出预览；点应用只提交勾上的角色，并通知父组件重读', async () => {
    const api = stubApi()
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('.modal').exists()).toBe(true)
    expect(wrapper.text()).toContain('现在：gpt-x · Mine')
    expect(wrapper.text()).toContain('现在：未设置')

    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()

    expect(api.apply).toHaveBeenCalledWith(['agent'])
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('.modal').exists()).toBe(false)
  })

  it('用户在浏览器里取消：不弹错误，也不弹预览', async () => {
    stubApi({ connect: vi.fn(async () => ({ ok: false, code: 'cancelled', error: 'x' })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.modal').exists()).toBe(false)
  })
})
