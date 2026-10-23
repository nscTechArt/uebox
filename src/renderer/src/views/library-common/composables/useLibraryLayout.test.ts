import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter, useRoute } from 'vue-router'
import type { Router } from 'vue-router'
import { defineComponent, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import BlueprintLibraryLayout from '@renderer/views/BlueprintLibrary/BlueprintLibraryLayout.vue'
import MaterialLibraryLayout from '@renderer/views/MaterialLibrary/MaterialLibraryLayout.vue'
import NotebookLayout from '@renderer/views/Notebook/NotebookLayout.vue'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import { getTabCacheKey } from '@renderer/common/tabRoute'
import { useTabsStore } from '@renderer/store/modules/tabs'

/**
 * 三个嵌套库 Layout 在 MainLayout 的 keep-alive 下切换 tab 时，子页必须原样保留。
 *
 * 测试外壳与 MainLayout 使用同一个 cache key 函数 —— Layout 依靠它判断路由归属，
 * 外壳若换一套 key 规则，测的就不是真实系统。
 */
const AppShell = defineComponent({
  setup: () => ({ getTabCacheKey }),
  template: `
    <router-view v-slot="{ Component, route }">
      <keep-alive :max="50">
        <component :is="Component" v-if="route.meta.keepAlive" :key="getTabCacheKey(route)" />
      </keep-alive>
    </router-view>
  `
})

let mounts: string[] = []
let routeReactions: string[] = []
let lifecycle: string[] = []

/** 记录每个实例的挂载、失活、卸载，它看到的路由变化，以及一份组件内状态 */
const ChildPage = defineComponent({
  setup() {
    const route = useRoute()
    const state = ref('initial')
    const seenAt = route.fullPath
    onMounted(() => mounts.push(seenAt))
    onDeactivated(() => lifecycle.push(`${seenAt} deactivated`))
    onBeforeUnmount(() => lifecycle.push(`${seenAt} unmounted`))
    watch(
      () => route.fullPath,
      (path) => routeReactions.push(`${seenAt} saw ${path}`)
    )
    return { state, seenAt }
  },
  template: `<div class="child" :data-at="seenAt" :data-state="state"><button class="mutate" @click="state = 'changed'" /></div>`
})

const OtherPage = defineComponent({ template: '<div class="other" />' })

function createTestRouter(layout: Component, child: Component = ChildPage): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          {
            path: 'lib',
            component: layout,
            meta: { isShowInTab: true, keepAlive: true },
            children: [
              { path: '', component: child, meta: { isShowInTab: false, keepAlive: true } },
              { path: ':id', component: child, meta: { isShowInTab: false, keepAlive: true } }
            ]
          },
          { path: 'other', component: OtherPage, meta: { isShowInTab: true, keepAlive: true } }
        ]
      }
    ]
  })
}

async function setup(
  layout: Component,
  startPath: string,
  child?: Component
): Promise<{ wrapper: VueWrapper; go: (path: string) => Promise<void> }> {
  mounts = []
  routeReactions = []
  lifecycle = []
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createTestRouter(layout, child)
  // 与真实应用一致，每次导航后创建 tab：Layout 根据 tab 是否还在决定是否保留子页
  router.afterEach((to) => {
    useTabsStore(pinia).addTab(to)
  })
  router.push(startPath)
  await router.isReady()
  const wrapper = mount(defineComponent({ template: '<router-view />' }), {
    attachTo: document.body,
    global: { plugins: [pinia, router] }
  })
  await flushPromises()
  const go = async (path: string): Promise<void> => {
    await router.push(path)
    await flushPromises()
  }
  return { wrapper, go }
}

function childAt(path: string): Element | null {
  return document.querySelector(`.child[data-at="${path}"]`)
}

const LIST = '/lib'
const EDITOR_1 = '/lib/x1?_tab_id=t1'
const EDITOR_2 = '/lib/x2?_tab_id=t2'

const layouts: [string, Component][] = [
  ['BlueprintLibraryLayout', BlueprintLibraryLayout],
  ['MaterialLibraryLayout', MaterialLibraryLayout],
  ['NotebookLayout', NotebookLayout]
]

describe.each(layouts)('%s under keep-alive', (_name, layout) => {
  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('keeps the child page when leaving for another module and coming back', async () => {
    const { wrapper, go } = await setup(layout, LIST)
    await wrapper.find('.mutate').trigger('click')

    await go('/other')
    await go(LIST)

    expect(childAt(LIST)?.getAttribute('data-state')).toBe('changed')
    expect(mounts).toEqual([LIST])
  })

  it('keeps both tabs of the same layout intact when switching between them', async () => {
    const { wrapper, go } = await setup(layout, LIST)
    await wrapper.find('.mutate').trigger('click')

    await go(EDITOR_1)
    await wrapper.find(`.child[data-at="${EDITOR_1}"] .mutate`).trigger('click')
    await go(LIST)
    await go('/other')
    await go(EDITOR_1)
    // 缓存中实例的 DOM 不在 document 中，只能在它回到前台时检查
    expect(childAt(EDITOR_1)?.getAttribute('data-state')).toBe('changed')
    await go(LIST)
    expect(childAt(LIST)?.getAttribute('data-state')).toBe('changed')
    // 每个 tab 恰好一个实例，缓存中的 Layout 里没有出现其他 tab 的子页
    expect(mounts).toEqual([LIST, EDITOR_1])
  })

  it('keeps editor tab child pages intact and unaffected by other tabs routes', async () => {
    const { wrapper, go } = await setup(layout, EDITOR_1)
    await wrapper.find(`.child[data-at="${EDITOR_1}"] .mutate`).trigger('click')

    await go(EDITOR_2)
    await go('/other')
    await go(EDITOR_1)

    // 两个编辑器 tab 各一个实例，E1 的 Layout 里没有出现 E2 的子页
    expect(mounts).toEqual([EDITOR_1, EDITOR_2])
    expect(childAt(EDITOR_1)?.getAttribute('data-state')).toBe('changed')
    expect(routeReactions).toEqual([])
  })
})

/**
 * keep-alive 不会因关闭 tab 而清理缓存：tab 关闭后，Layout 需要自行释放子页，
 * 否则被冻结的子页会一直占用内存。
 */
describe.each(layouts)('%s releases the child page when its tab is closed', (_name, layout) => {
  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  function closeTab(key: string): void {
    const tabsStore = useTabsStore()
    tabsStore.historyTabs = tabsStore.historyTabs.filter((tab) => tab.key !== key)
  }

  it('unmounts a background tab child page once its tab is closed', async () => {
    const { go } = await setup(layout, EDITOR_1)
    await go(EDITOR_2)
    expect(lifecycle).toEqual([`${EDITOR_1} deactivated`])

    closeTab(EDITOR_1)
    await flushPromises()

    expect(lifecycle).toEqual([`${EDITOR_1} deactivated`, `${EDITOR_1} unmounted`])
  })

  // 子页要在 deactivated 中写回未保存的内容：必须先失活、再卸载
  it('keeps the closed front tab until it leaves, then deactivates before unmounting', async () => {
    const { go } = await setup(layout, EDITOR_1)

    closeTab(EDITOR_1)
    await flushPromises()
    expect(lifecycle).toEqual([])

    await go(EDITOR_2)

    expect(lifecycle).toEqual([`${EDITOR_1} deactivated`, `${EDITOR_1} unmounted`])
  })
})

describe('NotebookLayout records the open notebook per tab', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  // 从侧栏回到笔记本列表时，路由守卫按 tab 跳回它打开的笔记本：其他 tab 的路由不能改写这条记录
  it('keeps each tab open notebook, untouched by other tabs routes', async () => {
    const { go } = await setup(NotebookLayout, EDITOR_1)
    const store = useNotebookStore()
    expect(store.getActiveNotebookIdForTab('t1')).toBe('x1')

    await go(EDITOR_2)
    await go(LIST)
    await go('/other')
    await go(EDITOR_1)

    expect(store.getActiveNotebookIdForTab('t1')).toBe('x1')
    expect(store.getActiveNotebookIdForTab('t2')).toBe('x2')
    expect(store.getActiveNotebookIdForTab('default')).toBeNull()
  })
})
