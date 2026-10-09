import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import zhCN from '@renderer/i18n/locales/zh-CN'
import TopNav from './TopNav.vue'

const passthrough = { template: '<div><slot /><slot name="overlay" /></div>' }
const menuItem = {
  emits: ['click'],
  template: '<button class="menu-item" @click="$emit(\'click\')"><slot /></button>'
}

function mountTopNav(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(TopNav, {
    props,
    global: {
      stubs: {
        SessionProjectChip: true,
        AppDropdown: passthrough,
        AppMenu: passthrough,
        AppMenuItem: menuItem,
        AppMenuDivider: true
      }
    }
  })
}

describe('TopNav exports', () => {
  it('点击“导出图片”会触发图片导出', async () => {
    const wrapper = mountTopNav()
    const exportImage = wrapper.findAll('.menu-item').find((item) => item.text() === '导出图片')

    expect(exportImage).toBeDefined()
    await exportImage!.trigger('click')
    expect(wrapper.emitted('export-image')).toHaveLength(1)
  })

  it('点击「侧边问一句」会发出 side-question', async () => {
    const wrapper = mountTopNav()
    const sideQuestion = wrapper
      .findAll('.menu-item')
      .find((item) => item.text() === zhCN.assistant.sideQuestion.open)

    expect(sideQuestion).toBeDefined()
    await sideQuestion!.trigger('click')
    expect(wrapper.emitted('side-question')).toHaveLength(1)
  })

  it('把 chatSid 透传给 SessionProjectChip 和 EditorStatusMonitor', () => {
    const chipStub = {
      name: 'SessionProjectChip',
      props: { chatSid: { type: String, default: '' } },
      template: '<div />'
    }
    const monitorStub = {
      name: 'EditorStatusMonitor',
      props: { chatSid: { type: String, default: '' } },
      template: '<div />'
    }
    const wrapper = mount(TopNav, {
      props: { chatSid: 'chat-7' },
      global: {
        stubs: {
          SessionProjectChip: chipStub,
          EditorStatusMonitor: monitorStub,
          AppDropdown: passthrough,
          AppMenu: passthrough,
          AppMenuItem: menuItem,
          AppMenuDivider: true
        }
      }
    })

    expect(wrapper.findComponent(chipStub).props('chatSid')).toBe('chat-7')
    expect(wrapper.findComponent(monitorStub).props('chatSid')).toBe('chat-7')
  })
})
