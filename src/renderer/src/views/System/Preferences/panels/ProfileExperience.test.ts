/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 「经验」分组要做到的几件事：
 *
 * 1. 读失败说读失败，不显示成「还没有经验」。
 * 2. 已淘汰的默认不列，勾选才出现。
 * 3. 点开有详情；固定保留、删除都要真的落到主进程。
 * 4. 有可撤销的整理时才给「撤销上次整理」按钮。
 */

const listExperiences = vi.fn()
const setExperiencePinned = vi.fn()
const deleteExperience = vi.fn()
const undoLastCuration = vi.fn()
const confirmDialog = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/utils/messageManager', () => ({
  message: { success: vi.fn(), error: vi.fn() }
}))
vi.mock('@renderer/utils/dialog', () => ({
  confirmDialog: (options: unknown) => confirmDialog(options)
}))
vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    listExperiences: (...args: unknown[]) => listExperiences(...args),
    setExperiencePinned: (...args: unknown[]) => setExperiencePinned(...args),
    deleteExperience: (...args: unknown[]) => deleteExperience(...args),
    undoLastCuration: (...args: unknown[]) => undoLastCuration(...args)
  }
}))

import ProfileExperience from './ProfileExperience.vue'

const stats = {
  shown: 6,
  shownOk: 4,
  holdout: 3,
  holdoutOk: 1,
  adopted: 5,
  adoptedOk: 4,
  adoptedFail: 0,
  ignoredStreak: 0,
  lift: 0.33
}

const ENTRIES = [
  {
    id: 'g1',
    title: '角色没有 is_hidden',
    tool: 'ue_run_python_script',
    errorPattern: "has no attribute 'is_hidden'",
    advice: '改用 is_hidden_ed()',
    expect: { param: 'script' },
    source: '2026-09-28',
    status: 'proven',
    layer: 'global',
    engines: ['5.5', '5.6'],
    stats
  },
  {
    id: 'p1',
    title: '界面资产锁着',
    tool: 'ue_save',
    errorPattern: 'read-only',
    advice: '先签出',
    expect: { tool: 'ue_checkout' },
    source: '',
    status: 'retired',
    layer: 'project',
    projectName: 'ShooterDemo',
    projectPath: 'H:/P/ShooterDemo',
    stats: { ...stats, lift: undefined }
  }
]

function mountSection(): VueWrapper {
  return mount(ProfileExperience, {
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { 'a-select': true },
      renderStubDefaultSlot: true
    },
    attachTo: document.body
  }) as VueWrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  listExperiences.mockResolvedValue({ entries: ENTRIES })
  setExperiencePinned.mockResolvedValue(undefined)
  deleteExperience.mockResolvedValue(undefined)
})

describe('经验分组', () => {
  it('已淘汰的默认不列；计数只算在用的', async () => {
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.findAll('.entity-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('角色没有 is_hidden')
    expect(wrapper.find('.count').text()).toBe('1')
    expect(wrapper.text()).toContain('UE 5.5 · 5.6')
  })

  it('读失败说读失败', async () => {
    listExperiences.mockRejectedValue(new Error('磁盘坏了'))
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('profile.experience.loadFailed')
    expect(wrapper.find('.count').text()).toBe('—')
  })

  it('点开看详情，删除要先确认，确认后落到主进程', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('.entity-open').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('profile.experience.detail.lift')

    const deleteButton = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('common.delete')
    )
    deleteButton?.click()
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    await (confirmDialog.mock.calls[0][0] as { onOk: () => Promise<void> }).onOk()
    expect(deleteExperience).toHaveBeenCalledWith({
      layer: 'global',
      tool: 'ue_run_python_script',
      id: 'g1'
    })
  })

  it('有可撤销的整理才给按钮，确认后才撤销', async () => {
    const plain = mountSection()
    await flushPromises()
    expect(plain.text()).not.toContain('profile.experience.undo')
    plain.unmount()

    listExperiences.mockResolvedValue({
      entries: ENTRIES,
      lastCuration: { id: 'x', at: '2026-09-30T14:02:11.123Z', added: 2, retired: 1 }
    })
    undoLastCuration.mockResolvedValue({ id: 'x', at: '', added: 2, retired: 1 })
    const wrapper = mountSection()
    await flushPromises()
    const undoButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('profile.experience.undo'))
    await undoButton?.trigger('click')
    expect(undoLastCuration).not.toHaveBeenCalled()
    await (confirmDialog.mock.calls[0][0] as { onOk: () => Promise<void> }).onOk()
    expect(undoLastCuration).toHaveBeenCalledTimes(1)
  })
})
