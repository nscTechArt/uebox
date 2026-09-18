import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { createStoredEntry } from '../../../../../tests/material-library/fixtures'
import LibraryAIPanel from '@renderer/views/library-common/components/LibraryAIPanel.vue'
import MaterialEditor from './MaterialEditor.vue'
import MaterialRenderer from './MaterialRenderer.vue'
import { buildMaterialEditorRoute } from './utils/materialTabRoute'

/*
 * AI 面板整个替身掉：它里面嵌的是主助手本身（`Assistant/Welcome.vue`），
 * 真挂起来会把 agent 内核、语音、审批那一整套拖进这个测试。
 * 这里要测的是「面板拿到的上下文对不对」，那在 props 上就看得见。
 */
vi.mock('@renderer/views/library-common/components/LibraryAIPanel.vue', () => ({
  default: defineComponent({
    name: 'LibraryAIPanelStub',
    props: {
      mode: { type: String, default: 'docked' },
      sessionId: { type: String, default: '' },
      context: { type: Object, default: null }
    },
    emits: ['update:mode', 'restore', 'snapshot-selection'],
    template: '<div class="lib-ai-panel-stub" />'
  })
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/material-library', name: 'MaterialGallery', component: { template: '<div />' } },
      { path: '/material-library/:id', name: 'MaterialEditor', component: MaterialEditor }
    ]
  })
}

async function mountEditor(
  path: string | ReturnType<typeof buildMaterialEditorRoute> = '/material-library/material-master'
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createTestRouter()
  router.push(path)
  await router.isReady()

  const wrapper = mount(MaterialEditor, {
    global: {
      plugins: [router]
    }
  })

  return { wrapper, router }
}

describe('MaterialEditor', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps the material detail navigation focused on offline node assets', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        scalarParameters: [{ name: 'Roughness', type: 'scalar', overrideValue: 0.4 }],
        textureDependencies: [
          { path: '/Game/Textures/T_Master', name: 'T_Master', kind: 'texture', isResolved: true }
        ],
        childInstancePaths: ['/Game/Materials/MI_MasterSurface']
      })
    ])

    const { wrapper } = await mountEditor()
    const sectionLabels = wrapper.findAll('.tree-item').map((button) => button.text())

    expect(sectionLabels).toHaveLength(3)
    expect(sectionLabels.some((label) => label.includes('节点图'))).toBe(true)
    expect(sectionLabels.some((label) => label.includes('贴图依赖'))).toBe(true)
    expect(sectionLabels.some((label) => label.includes('函数依赖'))).toBe(true)
    expect(sectionLabels.some((label) => label.includes('参数'))).toBe(false)
    expect(wrapper.findAll('.material-param-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('Roughness')
    expect(sectionLabels.some((label) => label.includes('总览'))).toBe(false)
    expect(sectionLabels.some((label) => label.includes('实例关系'))).toBe(false)
    expect(sectionLabels.some((label) => label.includes('编译诊断'))).toBe(false)
    // AI 面板在（它自己的标题文案归 LibraryAIPanel 管，这里只认组件在不在）
    expect(wrapper.findComponent(LibraryAIPanel).exists()).toBe(true)
    expect(wrapper.text()).not.toContain('我的蓝图')
  })

  it('switches detail sections without changing the route tab key', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        scalarParameters: [{ name: 'Roughness', type: 'scalar', overrideValue: 0.4 }],
        textureDependencies: [
          {
            path: '/Game/Textures/T_Master',
            name: 'T_Master',
            kind: 'texture',
            assetType: 'Texture2D',
            isResolved: true
          }
        ]
      })
    ])

    const { wrapper, router } = await mountEditor()
    const treeItems = wrapper.findAll('.tree-item')

    await treeItems[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findAll('.texture-dependency-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('T_Master')
    expect(wrapper.text()).toContain('/Game/Textures/T_Master')
  })

  it('keeps material parameters in the sidebar and focuses the graph without route changes', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        scalarParameters: [
          {
            name: 'TextureCoordinate_0.U Tiling',
            type: 'scalar',
            overrideValue: 2,
            source: 'nodeProperty'
          }
        ]
      })
    ])

    const { wrapper, router } = await mountEditor()
    const materialParam = wrapper.find('.material-param-item')

    expect(materialParam.exists()).toBe(true)
    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')

    await materialParam.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
    expect(materialParam.classes()).toContain('active')
  })

  it('groups and collapses multiple editable values from the same material node in the sidebar', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        scalarParameters: [
          {
            name: 'TextureCoordinate_0.Coordinate Index',
            type: 'scalar',
            overrideValue: 0,
            source: 'nodeProperty'
          },
          {
            name: 'TextureCoordinate_0.U Tiling',
            type: 'scalar',
            overrideValue: 2,
            source: 'nodeProperty'
          },
          {
            name: 'TextureCoordinate_0.V Tiling',
            type: 'scalar',
            overrideValue: 2,
            source: 'nodeProperty'
          }
        ],
        staticSwitchParameters: [
          {
            name: 'TextureCoordinate_0.Un Mirror U',
            type: 'staticSwitch',
            overrideValue: false,
            source: 'nodeProperty'
          },
          {
            name: 'TextureCoordinate_0.Un Mirror V',
            type: 'staticSwitch',
            overrideValue: false,
            source: 'nodeProperty'
          }
        ]
      })
    ])

    const { wrapper, router } = await mountEditor()
    const nodeGroups = wrapper.findAll('.material-param-node')

    expect(nodeGroups).toHaveLength(1)
    expect(nodeGroups[0].text()).toContain('TextureCoordinate_0')
    expect(nodeGroups[0].text()).toContain('5')
    expect(wrapper.findAll('.material-param-child')).toHaveLength(5)

    await nodeGroups[0].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
    expect(wrapper.findAll('.material-param-child')).toHaveLength(0)
    expect(wrapper.find('.material-param-node').classes()).toContain('collapsed')

    await wrapper.find('.material-param-node').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.material-param-child')).toHaveLength(5)
  })

  it('wires AI selection snapshots without opening another material route tab', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        graphBlueprintCode:
          'Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate Name="MaterialExpressionTextureCoordinate_0"\nEnd Object'
      })
    ])

    const { wrapper, router } = await mountEditor()
    const aiPanel = wrapper.findComponent(LibraryAIPanel)

    // 上下文里带的是这个条目，而且会话 id 跟着条目走
    expect(aiPanel.props('sessionId')).toBe('library-chat-material-material-master')
    expect(aiPanel.props('context')).toMatchObject({
      library: 'material',
      entryId: 'material-master',
      entryName: 'M_MasterSurface',
      selectedNodes: []
    })

    aiPanel.vm.$emit('snapshot-selection')
    await flushPromises()

    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findComponent(LibraryAIPanel).props('context')).toMatchObject({
      selectedNodes: []
    })
  })

  it('falls back to the node graph for removed legacy sections', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface'
      })
    ])

    const { wrapper } = await mountEditor('/material-library/material-master?section=diagnostics')

    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
  })

  it('falls back to the node graph for the removed parameter page', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        scalarParameters: [{ name: 'Roughness', type: 'scalar', overrideValue: 0.4 }]
      })
    ])

    const { wrapper } = await mountEditor('/material-library/material-master?section=parameters')

    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
    expect(wrapper.findAll('.material-param-item')).toHaveLength(1)
  })

  it('can initialize a section from the URL without rewriting it on later section switches', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface',
        textureDependencies: [
          { path: '/Game/Textures/T_Master', name: 'T_Master', kind: 'texture', isResolved: true }
        ]
      })
    ])

    const { wrapper, router } = await mountEditor(
      '/material-library/material-master?section=texture-dependencies'
    )

    expect(wrapper.findAll('.texture-dependency-row')).toHaveLength(1)

    await wrapper.findAll('.tree-item')[0].trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
    expect(router.currentRoute.value.query.section).toBe('texture-dependencies')
  })

  it('defaults to node graph section when no query section is provided', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface'
      })
    ])

    const { wrapper, router } = await mountEditor()
    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findComponent(MaterialRenderer).props('mode')).toBe('graph')
  })

  it('syncs the dedicated tab title from the material name after the editor becomes active', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface'
      })
    ])

    const router = createTestRouter()
    const targetRoute = buildMaterialEditorRoute('material-master')
    const tabKey = `${router.resolve(targetRoute).fullPath}`
    await router.push(targetRoute)
    await router.isReady()

    const tabsStore = useTabsStore()
    tabsStore.historyTabs = [
      {
        key: tabKey,
        title: 'menu.materialDetail',
        path: tabKey,
        sort: 1
      }
    ]

    mount(MaterialEditor, {
      global: {
        plugins: [router]
      }
    })
    await flushPromises()

    expect(tabsStore.historyTabs[0]?.title).toBe('M_MasterSurface')
  })

  it('does not rename the shared material library tab when the editor route has no dedicated tab id', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-master',
        name: 'M_MasterSurface'
      })
    ])

    const router = createTestRouter()
    await router.push('/material-library/material-master')
    await router.isReady()

    const tabsStore = useTabsStore()
    tabsStore.historyTabs = [
      {
        key: '/material-library',
        title: 'menu.materialLib',
        path: '/material-library',
        sort: 1
      }
    ]

    mount(MaterialEditor, {
      global: {
        plugins: [router]
      }
    })
    await flushPromises()

    expect(tabsStore.historyTabs[0]?.title).toBe('menu.materialLib')
  })
})
