import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TopNav from './TopNav.vue'

const passthrough = { template: '<div><slot /><slot name="overlay" /></div>' }
const menuItem = {
  emits: ['click'],
  template: '<button class="menu-item" @click="$emit(\'click\')"><slot /></button>'
}

describe('TopNav exports', () => {
  it('点击“导出图片”会触发图片导出', async () => {
    const wrapper = mount(TopNav, {
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
    const exportImage = wrapper.findAll('.menu-item').find((item) => item.text() === '导出图片')

    expect(exportImage).toBeDefined()
    await exportImage!.trigger('click')
    expect(wrapper.emitted('export-image')).toHaveLength(1)
  })
})
