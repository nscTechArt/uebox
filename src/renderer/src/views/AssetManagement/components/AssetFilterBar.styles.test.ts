import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileStyleAsync, parse } from '@vue/compiler-sfc'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuSubmenu from '@renderer/components/AppMenuSubmenu.vue'

const SCOPE_ID = 'data-v-assetfilterbarstyles'
const FILENAME = resolve('src/renderer/src/views/AssetManagement/components/AssetFilterBar.vue')

let compiledCss = ''

const cleanups: Array<() => void> = []

beforeAll(async () => {
  const { descriptor } = parse(readFileSync(FILENAME, 'utf8'), { filename: FILENAME })
  const parts: string[] = []
  for (const style of descriptor.styles) {
    const result = await compileStyleAsync({
      filename: FILENAME,
      source: style.content,
      id: SCOPE_ID,
      scoped: style.scoped,
      preprocessLang: style.lang === 'less' ? 'less' : undefined
    })
    expect(result.errors).toEqual([])
    parts.push(result.code)
  }
  compiledCss = parts.join('\n')
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function injectStyles(): void {
  const styleEl = document.createElement('style')
  styleEl.textContent = compiledCss
  document.head.appendChild(styleEl)
  cleanups.push(() => styleEl.remove())
}

function mountUnrelatedMenu(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(
    {
      components: { AppMenu, AppMenuItem, AppMenuSubmenu },
      template: `
      <div class="app-dropdown">
        <AppMenu>
          <AppMenuItem item-key="rename">重命名</AppMenuItem>
          <AppMenuSubmenu>
            <template #title>归入工程</template>
            <AppMenuItem item-key="project-a">项目 A</AppMenuItem>
          </AppMenuSubmenu>
          <AppMenuItem item-key="delete">删除</AppMenuItem>
        </AppMenu>
      </div>
    `
    },
    { attachTo: host }
  )
  cleanups.push(() => {
    wrapper.unmount()
    host.remove()
  })
  return wrapper.get<HTMLElement>('.app-menu').element
}

// happy-dom 不会把 overflow 简写展开成 overflow-x / overflow-y，简写要单独读
function overflowOf(el: HTMLElement): { overflow: string; overflowX: string; overflowY: string } {
  const cs = getComputedStyle(el)
  return {
    overflow: cs.getPropertyValue('overflow') || 'visible',
    overflowX: cs.overflowX || 'visible',
    overflowY: cs.overflowY || 'visible'
  }
}

const ALL_VISIBLE = { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }

describe('AssetFilterBar 样式', () => {
  it('加载资产库筛选样式不改变其他菜单的可见溢出', () => {
    const menu = mountUnrelatedMenu()
    expect(overflowOf(menu)).toEqual(ALL_VISIBLE)

    injectStyles()

    expect(overflowOf(menu)).toEqual(ALL_VISIBLE)
  })
})
