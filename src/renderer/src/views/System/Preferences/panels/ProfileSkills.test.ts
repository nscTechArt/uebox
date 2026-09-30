/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 「技能」页的三件事，界面上做不到就等于不存在。
 *
 * 1. **每条一个开关**，切一下要真的落到主进程 —— 只改本地 ref 的话，
 *    用户以为关掉了，下一轮那条技能照样加载。
 * 2. **点开有详情**，正文读得出来、改得动、存得回去。
 * 3. **删除只在详情里，而且只给自己的那份**。页头那个「删掉我的 N 条」
 *    主按钮已经撤了 —— 主按钮的作用是引导，没有理由引导用户删自己的技能。
 */

const listSkills = vi.fn()
const readSkill = vi.fn()
const writeSkill = vi.fn()
const setSkillDisabled = vi.fn()
const deleteSkills = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/utils/messageManager', () => ({
  message: { success: vi.fn(), error: vi.fn() }
}))
vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    listSkills: (...args: unknown[]) => listSkills(...args),
    readSkill: (...args: unknown[]) => readSkill(...args),
    writeSkill: (...args: unknown[]) => writeSkill(...args),
    setSkillDisabled: (...args: unknown[]) => setSkillDisabled(...args),
    deleteSkills: (...args: unknown[]) => deleteSkills(...args)
  }
}))

import ProfileSkills from './ProfileSkills.vue'

const SKILLS = [
  { name: 'ue-greybox-blockout', description: '搭灰盒', source: 'builtin', enabled: true },
  { name: 'my-skill', description: '我自己写的', source: 'user', enabled: true },
  { name: 'off-skill', description: '关掉的那条', source: 'builtin', enabled: false }
]

function mountPanel(): VueWrapper {
  return mount(ProfileSkills, {
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { 'a-input': true, 'a-textarea': true },
      // Teleport 到 body，查断言时从 document 上找
      renderStubDefaultSlot: true
    },
    attachTo: document.body
  }) as VueWrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  listSkills.mockResolvedValue({ skills: SKILLS })
  readSkill.mockResolvedValue({
    name: 'my-skill',
    source: 'user',
    content: '---\nname: my-skill\ndescription: 我自己写的\n---\n\n正文\n',
    savesAs: 'own'
  })
  writeSkill.mockResolvedValue(undefined)
  setSkillDisabled.mockResolvedValue(undefined)
  deleteSkills.mockResolvedValue(1)
  ;(window as unknown as { api: unknown }).api = { invoke: vi.fn(async () => undefined) }
})

describe('技能清单', () => {
  it('关掉的那条照样列出来 —— 藏起来就没法再打开', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('.entity-item')).toHaveLength(3)
    expect(wrapper.text()).toContain('off-skill')
  })

  it('页头没有批量删除按钮', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('.section-head').text()).not.toContain('delete')
    expect(wrapper.find('.section-head').text()).not.toContain('deleteMine')
  })

  it('切开关会落到主进程，而不是只改本地状态', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    // 第一条是开着的，切一下等于「关掉」
    await wrapper.findAllComponents({ name: 'AppSwitch' })[0].vm.$emit('update:checked', false)
    await flushPromises()

    expect(setSkillDisabled).toHaveBeenCalledWith('ue-greybox-blockout', true)
    // 落盘之后重读，界面显示的是主进程认可的状态
    expect(listSkills).toHaveBeenCalledTimes(2)
  })
})

describe('详情弹窗', () => {
  it('点一条打开详情，读出 SKILL.md 全文（含 frontmatter）', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.entity-open')[1].trigger('click')
    await flushPromises()

    expect(readSkill).toHaveBeenCalledWith('my-skill')
    expect(document.querySelector('.app-modal__panel')).not.toBeNull()
  })

  it('自己的那份给删除按钮', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.entity-open')[1].trigger('click')
    await flushPromises()

    expect(document.querySelector('.detail-footer')).not.toBeNull()
    expect(document.querySelector('.detail-footer')?.textContent).toContain('common.delete')
  })

  it('内置的那份不给删除按钮 —— 删了下次启动又回来，给了就是骗人', async () => {
    readSkill.mockResolvedValue({
      name: 'ue-greybox-blockout',
      source: 'builtin',
      content: '---\nname: ue-greybox-blockout\ndescription: 搭灰盒\n---\n\n正文\n',
      savesAs: 'copy'
    })

    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.entity-open')[0].trigger('click')
    await flushPromises()

    expect(document.querySelector('.detail-footer')?.textContent).not.toContain('common.delete')
    // 但要说清楚保存会另存一份覆盖它
    expect(document.querySelector('.app-modal__body')?.textContent).toContain(
      'profile.skills.overrideNote'
    )
  })
})
