import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import AppMenu from './AppMenu.vue'
import AppMenuItem from './AppMenuItem.vue'
import AppMenuSubmenu from './AppMenuSubmenu.vue'

const mounted: VueWrapper[] = []

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountMenu(onChoose = vi.fn()): VueWrapper {
  const wrapper = mount(
    {
      components: { AppMenu, AppMenuItem, AppMenuSubmenu },
      setup: () => ({ onChoose }),
      template: `
      <AppMenu>
        <AppMenuSubmenu>
          <template #title>归属项目</template>
          <AppMenuItem item-key="project-a" @click="onChoose">项目 A</AppMenuItem>
        </AppMenuSubmenu>
      </AppMenu>
    `
    },
    { attachTo: document.body }
  ) as VueWrapper
  mounted.push(wrapper)
  return wrapper
}

describe('AppMenuSubmenu', () => {
  it('鼠标移到父项时显示子菜单，并可点击其中的操作', async () => {
    const onChoose = vi.fn()
    const wrapper = mountMenu(onChoose)

    expect(
      wrapper.find('[role="menuitem"][aria-haspopup="menu"]').attributes('aria-expanded')
    ).toBe('false')

    await wrapper.get('.app-menu-submenu').trigger('mouseenter')
    expect(wrapper.find('.app-menu-submenu__popup').exists()).toBe(true)

    await wrapper.get('.app-menu-submenu__popup [role="menuitem"]').trigger('click')
    expect(onChoose).toHaveBeenCalledOnce()
  })

  it('键盘打开后把焦点送进第一项', async () => {
    const wrapper = mountMenu()
    const trigger = wrapper.get('[role="menuitem"][aria-haspopup="menu"]')

    await trigger.trigger('keydown', { key: 'ArrowRight' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.app-menu-submenu__popup').exists()).toBe(true)
    expect(document.activeElement).toBe(
      wrapper.get('.app-menu-submenu__popup [role="menuitem"]').element
    )
  })
})
