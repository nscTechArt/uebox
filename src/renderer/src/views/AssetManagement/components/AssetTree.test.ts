import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import AssetTree from './AssetTree.vue'

vi.mock('../composables/useAssetContext', () => ({ useAssetContext: () => ({}) }))
vi.mock('@renderer/store/modules/tagStatsStore', () => ({
  useTagStatsStore: () => ({ totalCount: 0, refreshTotalCount: vi.fn() })
}))
vi.mock('@renderer/store/modules/favoriteStore', () => ({
  useFavoriteStore: () => ({ totalCount: 0, refreshTotalCount: vi.fn() })
}))
vi.mock('./VaultSwitcher.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./modals/ImportToProjectModal.vue', () => ({
  default: { name: 'ImportToProjectModal', props: ['open', 'source'], template: '<div />' }
}))

const folder = {
  key: 'fog',
  title: 'EasyFog',
  type: 'folder' as const,
  path: 'EasyFog',
  folderType: 'plugin' as const
}

function mountTree(): VueWrapper {
  return shallowMount(AssetTree, {
    props: { treeData: [folder], selectedKeys: ['another-folder'], expandedKeys: [] },
    global: {
      stubs: {
        AInput: true,
        AForm: true,
        AFormItem: true,
        ATree: { name: 'ATree', template: '<div />' },
        ContextMenu: {
          name: 'ContextMenu',
          props: ['menuItems'],
          template: '<div />',
          methods: { show: vi.fn() }
        }
      }
    }
  })
}

describe('AssetTree project import', () => {
  it('opens the existing import dialog for the right-clicked folder, preserving plugin metadata', async () => {
    const wrapper = mountTree()
    wrapper.getComponent({ name: 'ATree' }).vm.$emit('rightClick', {
      event: new MouseEvent('contextmenu'),
      node: folder
    })
    await nextTick()
    const menu = wrapper.getComponent({ name: 'ContextMenu' })
    expect(menu.props('menuItems')).toContainEqual(
      expect.objectContaining({
        key: 'import-to-project',
        disabled: false
      })
    )
    menu.vm.$emit('click', 'import-to-project', {})
    await nextTick()
    const modal = wrapper.getComponent({ name: 'ImportToProjectModal' })
    expect(modal.props('open')).toBe(true)
    expect(modal.props('source')).toEqual({ ...folder, id: 'fog', name: 'EasyFog' })
    wrapper.unmount()
  })

  it.each(['ALL', 'missing'])('does not open an import for %s', async (key) => {
    const wrapper = mountTree()
    wrapper.getComponent({ name: 'ATree' }).vm.$emit('rightClick', {
      event: new MouseEvent('contextmenu'),
      node: { key }
    })
    await nextTick()
    wrapper.getComponent({ name: 'ContextMenu' }).vm.$emit('click', 'import-to-project', {})
    await nextTick()
    expect(wrapper.findComponent({ name: 'ImportToProjectModal' }).exists()).toBe(false)
    wrapper.unmount()
  })
})
