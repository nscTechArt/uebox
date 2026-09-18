import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8')

describe('macOS native window controls layout', () => {
  it('keeps the brand lockup on macOS, only shifting it clear of the traffic lights', () => {
    const sidebar = read('components/SideMenu.vue')
    // 让位不等于撤掉：红绿灯占了左边那段，品牌标识往右挪，
    // 但不能整个不渲染 —— 否则 Mac 上没有任何地方显示应用名。
    expect(sidebar).toContain('<div class="logo">')
    expect(sidebar).not.toContain('<div v-if="!isMac" class="logo">')
    expect(sidebar).toMatch(/\.sider-header\.mac-controls-inset\s*\{[^}]*\.logo\s*\{/)
  })

  it('reserves a control lane in both expanded and collapsed sidebar layouts', () => {
    const tabs = read('components/TabsHeader.vue')
    expect(tabs).toContain("'mac-controls-inset': isMac && (collapsed || !showSidebarToggle)")
    expect(tabs).toContain('<div v-if="!isMac" class="window-controls">')
    expect(read('components/SideMenu.vue')).toContain(':class="{ \'mac-controls-inset\': isMac }"')
    for (const source of [tabs, read('components/SideMenu.vue')]) {
      expect(source).toMatch(/\.mac-controls-inset\s*\{\s*padding-left: var\(--space-20\)/)
    }
  })

  it('gives the traffic lights their own strip instead of forcing the tab bar on', () => {
    const layout = read('MainLayout.vue')
    // showTab 归路由管。强开标签栏会把明确写了 showTab: false 的路由一起盖掉，
    // 红绿灯要的只是顶上一条让位 + 可拖拽的区域，那就单给它一条。
    expect(layout).toContain('const showTab = computed(() => route.meta.showTab !== false)')
    expect(layout).toContain(
      "window.api?.platform === 'darwin' && !showTab.value && !showMenu.value"
    )
    expect(layout).toContain('<div v-if="showMacTitlebarInset" class="mac-titlebar-inset">')
    expect(layout).toMatch(/\.mac-titlebar-inset\s*\{[^}]*-webkit-app-region: drag;/)
  })
})
