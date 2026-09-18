import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import AppPageLoading from './AppPageLoading.vue'
import AppPageSkeleton from './AppPageSkeleton.vue'
import LibraryBrowser from '@renderer/views/library-common/browser/LibraryBrowser.vue'

describe('destination-shaped page loading', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the project banner and separates engine cards from project covers', () => {
    const wrapper = mount(AppPageLoading, { props: { path: '/' } })
    expect(wrapper.find('.project-banner img').exists()).toBe(true)
    expect(wrapper.findAllComponents(AppPageSkeleton).map((item) => item.props('variant'))).toEqual(
      ['engines', 'projects']
    )
    expect(wrapper.find('.asset-tree').exists()).toBe(false)
  })

  it.each(['blueprint', 'material'])('uses the real %s browser shell in loading mode', (kind) => {
    const wrapper = mount(AppPageLoading, { props: { path: `/${kind}-library` } })
    const browser = wrapper.getComponent(LibraryBrowser)
    expect(browser.props('loading')).toBe(true)
    expect(browser.props('scope')).toMatchObject({ id: kind, density: 'light' })
    expect(wrapper.find('.browser-sidebar').exists()).toBe(true)
    expect(wrapper.find('.browser-toolbar').exists()).toBe(true)
    expect(wrapper.find('.gallery-shell').attributes('inert')).toBeDefined()
  })

  it('uses saved asset widths and details visibility without overwriting them', () => {
    localStorage.setItem('assetManagement.treePanelWidth', '410')
    localStorage.setItem('assetManagement.displaySize', '180')
    localStorage.setItem('assetManagement.detailsPanel.visible', 'false')
    const wrapper = mount(AppPageLoading, { props: { path: '/asset-management' } })
    expect(wrapper.get('.asset-tree').attributes('style')).toContain('410px')
    expect(wrapper.get('.asset-main').attributes('style')).toContain('180px')
    expect(wrapper.find('.asset-details').exists()).toBe(false)
    expect(wrapper.findAllComponents(AppPageSkeleton).map((item) => item.props('variant'))).toEqual(
      ['folders', 'assets']
    )
    expect(localStorage.getItem('assetManagement.detailsPanel.visible')).toBe('false')
  })

  it('shows three studio columns without inventing a preview image', () => {
    const wrapper = mount(AppPageLoading, { props: { path: '/aigc-studio' } })
    expect(wrapper.find('.workspace-input').exists()).toBe(true)
    expect(wrapper.find('.workspace-preview').exists()).toBe(true)
    expect(wrapper.find('.workspace-history').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('replaces the pending layout when the destination changes', async () => {
    const wrapper = mount(AppPageLoading, { props: { path: '/' } })
    await wrapper.setProps({ path: '/notebooks' })
    expect(wrapper.find('.project-banner').exists()).toBe(false)
    expect(wrapper.getComponent(AppPageSkeleton).props('variant')).toBe('notebooks')
    await wrapper.setProps({ path: '/blueprint-library/item-1' })
    expect(wrapper.find('.gallery-shell').exists()).toBe(false)
    expect(wrapper.find('.workspace-preview').exists()).toBe(true)
  })
})
