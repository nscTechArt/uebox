import { KeepAlive, defineComponent, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import BlueprintEditor from './BlueprintEditor.vue'
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import { useLayoutUiStore } from '@renderer/store/modules/layoutUiStore'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { buildBlueprintEditorRoute } from '@renderer/views/BlueprintLibrary/utils/blueprintTabRoute'

const { insertVariableNodeSpy, insertFunctionNodeSpy, flushSerializedCodeSpy } = vi.hoisted(() => ({
  insertVariableNodeSpy: vi.fn(),
  insertFunctionNodeSpy: vi.fn(),
  flushSerializedCodeSpy: vi.fn(() => true)
}))

const blueprintEditorTranslations: Record<string, string> = {
  'blueprintEditor.topbar.focusMode': '专注模式',
  'blueprintEditor.topbar.exitFocus': '退出专注'
}

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => blueprintEditorTranslations[key] || key
    })
  }
})

vi.mock('@renderer/views/BlueprintLibrary/BlueprintRenderer.vue', () => ({
  default: defineComponent({
    name: 'BlueprintRendererStub',
    props: {
      code: { type: String, default: '' },
      name: { type: String, default: '' }
    },
    setup(_, { expose }) {
      expose({
        insertVariableNode: insertVariableNodeSpy,
        insertFunctionNode: insertFunctionNodeSpy,
        flushSerializedCode: flushSerializedCodeSpy
      })
      return {}
    },
    template:
      '<div class="blueprint-renderer-stub" :data-blueprint-name="name" :data-code-length="code.length" />'
  })
}))

/*
 * AI 面板整个替身掉：它里面嵌的是主助手本身（`Assistant/Welcome.vue`），
 * 真挂起来会把 agent 内核、语音、审批那一整套拖进这个测试。
 * 这里要测的只是「形态切换的联动对不对」。
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
    template: `
      <div class="bp-ai-chat-stub" :data-mode="mode" :data-session-id="sessionId">
        <button class="set-docked" @click="$emit('update:mode', 'docked')">Docked</button>
        <button class="set-overlay" @click="$emit('update:mode', 'overlay')">Overlay</button>
        <button class="set-collapsed" @click="$emit('update:mode', 'collapsed')">Collapsed</button>
        <button class="restore-mode" @click="$emit('restore')">Restore</button>
      </div>
    `
  })
}))

function createRouterForTest() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/blueprint-library/:id',
        name: 'BlueprintEditor',
        component: { template: '<div />' }
      },
      {
        path: '/other',
        name: 'OtherPage',
        component: { template: '<div />' }
      }
    ]
  })
}

async function seedBlueprintEditor() {
  const pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()

  const store = useBlueprintLibraryStore()
  const blueprint = store.createBlueprint({
    name: 'BP_Test',
    blueprintType: 'Actor',
    engineVersion: '5.4'
  })
  store.setActiveBlueprintId(blueprint.id)

  const router = createRouterForTest()
  router.push(`/blueprint-library/${blueprint.id}`)
  await router.isReady()

  return { pinia, router, blueprint }
}

describe('BlueprintEditor UX state flows', () => {
  beforeEach(() => {
    localStorage.clear()
    insertVariableNodeSpy.mockReset()
    insertFunctionNodeSpy.mockReset()
    flushSerializedCodeSpy.mockReset()
    flushSerializedCodeSpy.mockReturnValue(true)
  })

  it('collapses both editor sidebars and the outer menu in focus mode, then reopens only the editor sidebars on exit', async () => {
    const { pinia, router } = await seedBlueprintEditor()
    const layoutUiStore = useLayoutUiStore()

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })

    const dispatchKey = (event: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...event }))
    }

    dispatchKey({ key: 'Tab' })
    await nextTick()
    expect(wrapper.find('.sidebar-left').exists()).toBe(false)
    expect(wrapper.find('.bp-sidebar-collapsed').exists()).toBe(true)

    dispatchKey({ key: 'f' })
    await nextTick()
    expect(wrapper.get('.focus-btn').text()).toContain('退出专注')
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('collapsed')
    expect(layoutUiStore.sideMenuCollapseRequestVersion).toBe(1)

    dispatchKey({ key: 'f' })
    await nextTick()

    expect(wrapper.get('.focus-btn').text()).toContain('专注模式')
    expect(wrapper.find('.sidebar-left').exists()).toBe(true)
    expect(wrapper.find('.bp-sidebar-collapsed').exists()).toBe(false)
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('docked')
    expect(layoutUiStore.sideMenuCollapseRequestVersion).toBe(1)
  })

  it('syncs the dedicated tab title from the blueprint name after the editor becomes active', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const tabsStore = useTabsStore()
    const targetRoute = buildBlueprintEditorRoute(blueprint.id)
    const tabKey = `${router.resolve(targetRoute).fullPath}`
    await router.push(targetRoute)
    await router.isReady()
    tabsStore.historyTabs = [
      {
        key: tabKey,
        title: 'menu.blueprintDetail',
        path: tabKey,
        sort: 1
      }
    ]

    mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })

    await flushPromises()

    expect(tabsStore.historyTabs[0]?.title).toBe('BP_Test')
  })

  it('does not rename the shared blueprint library tab when the editor route has no dedicated tab id', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const tabsStore = useTabsStore()

    tabsStore.historyTabs = [
      {
        key: '/blueprint-library',
        title: 'menu.blueprintLib',
        path: '/blueprint-library',
        sort: 1
      }
    ]

    await router.push(`/blueprint-library/${blueprint.id}`)
    await router.isReady()

    mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })

    await flushPromises()

    expect(tabsStore.historyTabs[0]?.title).toBe('menu.blueprintLib')
  })

  it('restores the previous AI panel mode when the collapsed stub emits restore', async () => {
    const { pinia, router } = await seedBlueprintEditor()

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })

    await wrapper.get('.set-overlay').trigger('click')
    await nextTick()
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('overlay')

    await wrapper.get('.set-collapsed').trigger('click')
    await nextTick()
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('collapsed')

    await wrapper.get('.restore-mode').trigger('click')
    await nextTick()
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('overlay')
  })

  it('restores the saved AI mode when Ctrl/Cmd + / is pressed from collapsed state', async () => {
    const { pinia, router } = await seedBlueprintEditor()

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })

    const dispatchKey = (event: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...event }))
    }

    await wrapper.get('.set-overlay').trigger('click')
    await nextTick()

    dispatchKey({ key: '/', ctrlKey: true })
    await nextTick()
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('collapsed')

    dispatchKey({ key: '/', ctrlKey: true })
    await nextTick()
    expect(wrapper.get('.bp-ai-chat-stub').attributes('data-mode')).toBe('overlay')
  })

  it('stops reacting to global shortcuts while deactivated under keep-alive', async () => {
    const { pinia, router } = await seedBlueprintEditor()
    const layoutUiStore = useLayoutUiStore()
    const showEditor = ref(true)

    const Harness = defineComponent({
      components: { KeepAlive },
      setup() {
        const DummyPage = defineComponent({
          name: 'DummyPage',
          template: '<div class="dummy-page">Other page</div>'
        })

        return {
          showEditor,
          editorComponent: BlueprintEditor,
          dummyComponent: DummyPage
        }
      },
      template: `
        <KeepAlive>
          <component :is="showEditor ? editorComponent : dummyComponent" class="editor-host" />
        </KeepAlive>
      `
    })

    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia, router],
        components: { KeepAlive }
      }
    })

    const dispatchKey = (event: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...event }))
    }

    dispatchKey({ key: 'f' })
    await nextTick()
    expect(wrapper.findComponent(BlueprintEditor).get('.focus-btn').text()).toContain('退出专注')
    expect(layoutUiStore.sideMenuCollapseRequestVersion).toBe(1)

    showEditor.value = false
    await flushPromises()
    expect(layoutUiStore.sideMenuCollapseRequestVersion).toBe(1)

    dispatchKey({ key: 'f' })
    await nextTick()

    showEditor.value = true
    await flushPromises()

    expect(wrapper.findComponent(BlueprintEditor).get('.focus-btn').text()).toContain('退出专注')
    expect(layoutUiStore.sideMenuCollapseRequestVersion).toBe(2)
  })

  it('drops a dragged variable into the renderer as a get node by default', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()
    store.addVariable(blueprint.id, {
      name: 'Command',
      type: 'String',
      defaultValue: '',
      isEditable: true,
      isBlueprintReadOnly: false,
      isExposedOnSpawn: false,
      category: '',
      description: '',
      replication: 'none'
    })

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })
    await nextTick()

    const payloadStore = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'copy',
      types: ['application/x-blueprint-variable'],
      setData: vi.fn((type: string, value: string) => {
        payloadStore.set(type, value)
      }),
      getData: vi.fn((type: string) => payloadStore.get(type) ?? '')
    }

    const variableItem = wrapper
      .findAll('.tree-item')
      .find((node) => node.text().includes('Command'))

    expect(variableItem).toBeTruthy()

    await variableItem!.trigger('dragstart', {
      dataTransfer,
      shiftKey: false
    })

    const dropZone = wrapper.get('.blueprint-viewer')
    await dropZone.trigger('dragenter', { dataTransfer, clientX: 120, clientY: 160 })
    await dropZone.trigger('dragover', { dataTransfer, clientX: 120, clientY: 160 })
    await dropZone.trigger('drop', { dataTransfer, clientX: 120, clientY: 160, shiftKey: false })

    expect(insertVariableNodeSpy).toHaveBeenCalledTimes(1)
    expect(insertVariableNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accessType: 'get',
        clientX: 120,
        clientY: 160,
        variable: expect.objectContaining({
          name: 'Command',
          type: 'String'
        })
      })
    )
  })

  it('switches the active graph when a different graph item is clicked', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()
    store.addGraph(blueprint.id, {
      name: '新事件图表_2',
      type: 'custom',
      code: 'Begin Object Class="/Script/BlueprintGraph.K2Node_CustomEvent" Name="K2Node_CustomEvent_0"\nEnd Object',
      nodeCount: 1,
      description: ''
    })

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })
    await nextTick()

    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      '新事件图表'
    )

    const secondGraphItem = wrapper
      .findAll('.tree-item')
      .find((node) => node.text().includes('新事件图表_2'))

    expect(secondGraphItem).toBeTruthy()

    await secondGraphItem!.trigger('click')
    await nextTick()

    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      '新事件图表_2'
    )
  })

  it('switches the active graph when the graph name itself is clicked', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()
    store.addGraph(blueprint.id, {
      name: '新事件图表_2',
      type: 'custom',
      code: 'Begin Object Class="/Script/BlueprintGraph.K2Node_CustomEvent" Name="K2Node_CustomEvent_0"\nEnd Object',
      nodeCount: 1,
      description: ''
    })

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })
    await nextTick()

    const secondGraphItem = wrapper
      .findAll('.tree-item')
      .find((node) => node.text().includes('新事件图表_2'))

    expect(secondGraphItem).toBeTruthy()

    await secondGraphItem!.get('.item-name').trigger('click')
    await nextTick()

    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      '新事件图表_2'
    )
  })

  it('keeps each cached blueprint editor pinned to its own graph selection across route switches', async () => {
    const { pinia, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()

    store.addGraph(blueprint.id, {
      name: 'BP1_Graph_2',
      type: 'custom',
      code: 'Begin Object Class="/Script/BlueprintGraph.K2Node_CustomEvent" Name="K2Node_CustomEvent_BP1"\nEnd Object',
      nodeCount: 1,
      description: ''
    })

    const secondBlueprint = store.createBlueprint({
      name: 'BP_Test_2',
      blueprintType: 'Actor',
      engineVersion: '5.4'
    })

    store.addGraph(secondBlueprint.id, {
      name: 'BP2_Graph_2',
      type: 'custom',
      code: 'Begin Object Class="/Script/BlueprintGraph.K2Node_CustomEvent" Name="K2Node_CustomEvent_BP2"\nEnd Object',
      nodeCount: 1,
      description: ''
    })

    const cachedRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/blueprint-library/:id',
          name: 'BlueprintEditor',
          component: BlueprintEditor
        }
      ]
    })

    await cachedRouter.push(`/blueprint-library/${blueprint.id}`)
    await cachedRouter.isReady()

    const Harness = defineComponent({
      components: { KeepAlive },
      setup() {
        return {
          currentRoute: cachedRouter.currentRoute
        }
      },
      template: `
        <router-view v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" :key="currentRoute.fullPath" />
          </KeepAlive>
        </router-view>
      `
    })

    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia, cachedRouter],
        components: { KeepAlive }
      }
    })

    await flushPromises()

    const selectGraphByName = async (name: string): Promise<void> => {
      const graphItem = wrapper.findAll('.tree-item').find((node) => node.text().includes(name))

      expect(graphItem).toBeTruthy()
      await graphItem!.trigger('click')
      await nextTick()
    }

    await selectGraphByName('BP1_Graph_2')
    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      'BP1_Graph_2'
    )

    await cachedRouter.push(`/blueprint-library/${secondBlueprint.id}`)
    await flushPromises()

    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      '新事件图表'
    )

    await cachedRouter.push(`/blueprint-library/${blueprint.id}`)
    await flushPromises()

    expect(wrapper.get('.blueprint-renderer-stub').attributes('data-blueprint-name')).toBe(
      'BP1_Graph_2'
    )
  })

  it('flushes the active renderer before navigating to another blueprint route', async () => {
    const { pinia, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()

    const secondBlueprint = store.createBlueprint({
      name: 'BP_Test_2',
      blueprintType: 'Actor',
      engineVersion: '5.4'
    })

    const activeRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/blueprint-library/:id',
          name: 'BlueprintEditor',
          component: BlueprintEditor
        }
      ]
    })

    await activeRouter.push(`/blueprint-library/${blueprint.id}`)
    await activeRouter.isReady()

    const Harness = defineComponent({
      template: '<router-view />'
    })

    mount(Harness, {
      global: {
        plugins: [pinia, activeRouter]
      }
    })

    await nextTick()
    expect(flushSerializedCodeSpy).not.toHaveBeenCalled()

    await activeRouter.push(`/blueprint-library/${secondBlueprint.id}`)
    await flushPromises()

    expect(flushSerializedCodeSpy).toHaveBeenCalled()
  })

  it('drops a dragged function into the renderer as a call node', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()
    store.addFunction(blueprint.id, {
      name: 'ApplyDamage',
      inputs: [{ name: 'BaseDamage', type: 'Float', defaultValue: '12.5' }],
      outputs: [{ name: 'FinalDamage', type: 'Float' }],
      code: '',
      description: '',
      isPure: false,
      access: 'public'
    })

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })
    await nextTick()

    const payloadStore = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'copy',
      types: ['application/x-blueprint-function'],
      setData: vi.fn((type: string, value: string) => {
        payloadStore.set(type, value)
      }),
      getData: vi.fn((type: string) => payloadStore.get(type) ?? '')
    }

    const functionItem = wrapper
      .findAll('.tree-item')
      .find((node) => node.text().includes('ApplyDamage'))

    expect(functionItem).toBeTruthy()

    await functionItem!.get('.item-name').trigger('dragstart', {
      dataTransfer
    })

    const dropZone = wrapper.get('.blueprint-viewer')
    await dropZone.trigger('dragenter', { dataTransfer, clientX: 240, clientY: 280 })
    await dropZone.trigger('dragover', { dataTransfer, clientX: 240, clientY: 280 })
    await dropZone.trigger('drop', { dataTransfer, clientX: 240, clientY: 280 })

    expect(insertFunctionNodeSpy).toHaveBeenCalledTimes(1)
    expect(insertFunctionNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clientX: 240,
        clientY: 280,
        fn: expect.objectContaining({
          name: 'ApplyDamage',
          isPure: false,
          inputs: [expect.objectContaining({ name: 'BaseDamage', type: 'Float' })],
          outputs: [expect.objectContaining({ name: 'FinalDamage', type: 'Float' })]
        })
      })
    )
  })

  it('derives function pins from function entry and result code when sidebar metadata is stale', async () => {
    const { pinia, router, blueprint } = await seedBlueprintEditor()
    const store = useBlueprintLibraryStore()
    store.addFunction(blueprint.id, {
      name: 'BoolRoundTrip',
      inputs: [],
      outputs: [],
      code: `Begin Object Class="/Script/BlueprintGraph.K2Node_FunctionEntry" Name="K2Node_FunctionEntry_0"
   NodePosX=0
   NodePosY=0
   CustomProperties Pin (PinId=EXECENTRY,PinName="execute",PinType.PinCategory="exec",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,)
   CustomProperties Pin (PinId=BOOLINPUT,PinName="NewParam",Direction="EGPD_Output",PinType.PinCategory="bool",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,DefaultValue="false",AutogeneratedDefaultValue="false",)
End Object
Begin Object Class="/Script/BlueprintGraph.K2Node_FunctionResult" Name="K2Node_FunctionResult_0"
   NodePosX=320
   NodePosY=0
   CustomProperties Pin (PinId=EXECRESULT,PinName="execute",PinType.PinCategory="exec",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,)
   CustomProperties Pin (PinId=BOOLOUTPUT,PinName="NewParam1",PinType.PinCategory="bool",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,DefaultValue="false",AutogeneratedDefaultValue="false",)
End Object`,
      description: '',
      isPure: false,
      access: 'public'
    })

    const wrapper = mount(BlueprintEditor, {
      global: {
        plugins: [pinia, router]
      }
    })
    await nextTick()

    const payloadStore = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'copy',
      types: ['application/x-blueprint-function'],
      setData: vi.fn((type: string, value: string) => {
        payloadStore.set(type, value)
      }),
      getData: vi.fn((type: string) => payloadStore.get(type) ?? '')
    }

    const functionItem = wrapper
      .findAll('.tree-item')
      .find((node) => node.text().includes('BoolRoundTrip'))

    expect(functionItem).toBeTruthy()

    await functionItem!.get('.item-name').trigger('dragstart', {
      dataTransfer
    })

    const dropZone = wrapper.get('.blueprint-viewer')
    await dropZone.trigger('dragenter', { dataTransfer, clientX: 260, clientY: 320 })
    await dropZone.trigger('dragover', { dataTransfer, clientX: 260, clientY: 320 })
    await dropZone.trigger('drop', { dataTransfer, clientX: 260, clientY: 320 })

    expect(insertFunctionNodeSpy).toHaveBeenCalledTimes(1)
    expect(insertFunctionNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: expect.objectContaining({
          name: 'BoolRoundTrip',
          inputs: [expect.objectContaining({ name: 'NewParam', type: 'Boolean' })],
          outputs: [expect.objectContaining({ name: 'NewParam1', type: 'Boolean' })]
        })
      })
    )
  })
})
