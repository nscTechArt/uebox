/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CreatorPlanCard from './CreatorPlanCard.vue'
import type { CreatorPlanPreview, CreatorPlanStoragePreview } from '@core/shared/creatorPlan'

/**
 * 导入预览里「对象存储」那一行：
 * - 套餐带存储才出现；按主进程给的默认勾
 * - 应用时把勾没勾一起交给主进程；预览里没有这一行时不传（主进程不动对象存储）
 * - 「现在」那一列：自己的桶显示桶名和服务商
 */

const stubs = {
  AppModal: {
    props: ['open', 'okText'],
    emits: ['ok', 'cancel'],
    template:
      '<div v-if="open" class="modal"><slot /><button class="modal-ok" @click="$emit(\'ok\')">{{ okText }}</button></div>'
  }
}

const summary: CreatorPlanPreview['summary'] = {
  tierName: 'Pro',
  status: 'active',
  interval: 'month',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  quotaResetsAt: null,
  cooldownEndsAt: null,
  manageUrl: 'https://plan.example/account/billing',
  quotas: []
}

function previewWith(storage: CreatorPlanStoragePreview | null): CreatorPlanPreview {
  return {
    summary,
    changes: [
      {
        role: 'agent',
        model: 'uebox-agent',
        modelDisplayName: 'Creator · Agent',
        current: null,
        managed: false,
        defaultSelected: true
      }
    ],
    storage
  }
}

const storage = (
  current: CreatorPlanStoragePreview['current'],
  defaultSelected: boolean
): CreatorPlanStoragePreview => ({
  quotaBytes: 10 * 1024 ** 3,
  maxObjectBytes: 500 * 1024 ** 2,
  retentionDays: 30,
  current,
  defaultSelected
})

async function openPreview(
  preview: CreatorPlanPreview
): Promise<{ wrapper: ReturnType<typeof mount>; apply: ReturnType<typeof vi.fn> }> {
  const apply = vi.fn(async () => ({
    ok: true,
    data: { connected: true, summary, managedRoles: [], error: null, deprecations: [] }
  }))
  window.api = {
    creatorPlan: {
      state: vi.fn(async () => ({
        ok: true,
        data: { connected: false, summary: null, managedRoles: [], error: null, deprecations: [] }
      })),
      connect: vi.fn(async () => ({ ok: true, data: preview })),
      apply,
      cancel: vi.fn(async () => {}),
      onDeviceCode: vi.fn(() => () => {})
    },
    shell: { openExternal: vi.fn() }
  } as unknown as typeof window.api
  const wrapper = mount(CreatorPlanCard, { global: { stubs } })
  await flushPromises()
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '连接')!
    .trigger('click')
  await flushPromises()
  return { wrapper, apply }
}

describe('导入预览：对象存储', () => {
  it('没开对象存储：出现这一行、默认勾上，应用时带 storage: true', async () => {
    const { wrapper, apply } = await openPreview(previewWith(storage({ kind: 'none' }, true)))
    const text = wrapper.text()
    expect(text).toContain('对象存储')
    expect(text).toContain('10 GB 空间 · 最后一次用到后留 30 天')
    expect(text).toContain('现在：未开启')
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    expect(apply).toHaveBeenCalledWith(['agent'], { storage: true })
  })

  it('自己配好了桶：显示桶名和服务商，默认不勾；勾上再应用', async () => {
    const { wrapper, apply } = await openPreview(
      previewWith(storage({ kind: 'own', preset: 'aliyun', bucket: 'my-bucket' }, false))
    )
    expect(wrapper.text()).toContain('现在：my-bucket · 阿里云 OSS')
    const boxes = wrapper.findAll('[role="checkbox"]')
    const storageBox = boxes[boxes.length - 1]!
    expect(storageBox.attributes('aria-checked')).toBe('false')
    await storageBox.trigger('click')
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    expect(apply).toHaveBeenCalledWith(['agent'], { storage: true })
  })

  it('套餐不带存储：没有这一行，应用时不传第二个参数', async () => {
    const { wrapper, apply } = await openPreview(previewWith(null))
    expect(wrapper.text()).not.toContain('对象存储')
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    expect(apply).toHaveBeenCalledWith(['agent'])
  })
})
