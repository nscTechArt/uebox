import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_TAB_KEY, useTabsStore, type TabItem } from './tabs'

function createTab(overrides: Partial<TabItem>): TabItem {
  return {
    key: '/home',
    title: 'menu.projectLib',
    path: '/home',
    sort: 1,
    fixed: false,
    isCanDelete: true,
    ...overrides
  }
}

/**
 * 项目库（路由 `/`）不再是钉死的固定标签页。
 *
 * 它现在只剩一条特殊待遇：一个标签都没有时落到这里。
 */
describe('项目库标签页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('能像普通标签页一样被关掉', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({ key: DEFAULT_TAB_KEY, path: DEFAULT_TAB_KEY, sort: 8 }),
      createTab({
        key: '/asset-management',
        title: 'menu.assetLib',
        path: '/asset-management',
        sort: 9
      })
    ]
    store.activeTab = DEFAULT_TAB_KEY

    const newActiveTabKey = store.removeTab(DEFAULT_TAB_KEY)

    expect(store.historyTabs.map((tab) => tab.key)).toEqual(['/asset-management'])
    expect(newActiveTabKey).toBe('/asset-management')
  })

  /** 以前它被硬编码钉在第一位，拖不走；现在一律按 sort 排 */
  it('不再被钉在第一位，纯按 sort 排序', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({ key: DEFAULT_TAB_KEY, path: DEFAULT_TAB_KEY, sort: 3 }),
      createTab({
        key: '/asset-management',
        title: 'menu.assetLib',
        path: '/asset-management',
        sort: 1
      }),
      createTab({ key: '/notebooks', title: 'menu.notebooks', path: '/notebooks', sort: 2 })
    ]

    expect(store.sortedTabs.map((tab) => tab.key)).toEqual([
      '/asset-management',
      '/notebooks',
      DEFAULT_TAB_KEY
    ])
  })

  it('一个标签都没有时，启动落到项目库', () => {
    const store = useTabsStore()

    store.historyTabs = []
    store.activeTab = '/asset-management'

    expect(store.resolveStartupTab()).toBe(DEFAULT_TAB_KEY)
  })

  it('有标签时，启动回到上次激活的那一个', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({ key: DEFAULT_TAB_KEY, path: DEFAULT_TAB_KEY, sort: 8 }),
      createTab({ key: '/notebooks', title: 'menu.notebooks', path: '/notebooks', sort: 14 })
    ]
    store.activeTab = '/notebooks'

    expect(store.resolveStartupTab()).toBe('/notebooks')
  })

  it('上次激活的标签已经不在了，就回到第一个', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({ key: '/notebooks', title: 'menu.notebooks', path: '/notebooks', sort: 14 })
    ]
    store.activeTab = '/material-library'

    expect(store.resolveStartupTab()).toBe('/notebooks')
  })

  /** 老用户的 localStorage 里存的还是旧标题，不迁的话标签上会显示 `menu.home` 这串原文 */
  it('把旧的首页标题迁到项目库', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({ key: DEFAULT_TAB_KEY, path: DEFAULT_TAB_KEY, title: 'menu.home' }),
      createTab({ key: '/legacy', path: '/legacy', title: '首页' })
    ]

    expect(store.migrateTabTitles()).toBe(true)
    expect(store.historyTabs.map((tab) => tab.title)).toEqual([
      'menu.projectLib',
      'menu.projectLib'
    ])
  })

  /**
   * 老用户 localStorage 里那个项目库标签是带着 fixed / isCanDelete=false 存下来的，
   * `addTab` 不会重新初始化已存在的标签，光改路由 meta 解不开它。
   */
  it('解锁老数据里被钉死的项目库标签', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({
        key: DEFAULT_TAB_KEY,
        path: DEFAULT_TAB_KEY,
        fixed: true,
        isCanDelete: false
      })
    ]

    expect(store.unlockProjectLibTab()).toBe(true)
    expect(store.historyTabs[0]?.fixed).toBe(false)
    expect(store.historyTabs[0]?.isCanDelete).toBe(true)
    expect(store.removeTab(DEFAULT_TAB_KEY)).toBeNull()
    expect(store.historyTabs).toHaveLength(0)
  })
})

describe('tabs store library cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('normalizes a misplaced material library tab to the canonical route', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({
        key: '/blueprint-manager',
        title: 'menu.materialLib',
        path: '/blueprint-manager',
        sort: 10
      })
    ]
    store.activeTab = '/blueprint-manager'

    const changed = store.cleanupLibraryTabs()
    const materialTab = store.historyTabs.find((tab) => tab.title === 'menu.materialLib')

    expect(changed).toBe(true)
    expect(materialTab?.key).toBe('/material-library')
    expect(materialTab?.path).toBe('/material-library')
    expect(store.activeTab).toBe('/material-library')
  })

  it('deduplicates library tabs when the canonical tab already exists', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({
        key: '/material-library',
        title: 'menu.materialLib',
        path: '/material-library',
        sort: 10
      }),
      createTab({
        key: '/blueprint-library',
        title: 'menu.materialLib',
        path: '/blueprint-library',
        sort: 11
      }),
      createTab({
        key: '/blueprint-manager',
        title: 'menu.blueprintLib',
        path: '/blueprint-manager',
        sort: 12
      })
    ]
    store.activeTab = '/blueprint-manager'

    const changed = store.cleanupLibraryTabs()
    const materialTabs = store.historyTabs.filter((tab) => tab.title === 'menu.materialLib')
    const blueprintTab = store.historyTabs.find((tab) => tab.title === 'menu.blueprintLib')

    expect(changed).toBe(true)
    expect(materialTabs).toHaveLength(1)
    expect(materialTabs[0]?.key).toBe('/material-library')
    expect(blueprintTab?.key).toBe('/blueprint-library')
    expect(blueprintTab?.path).toBe('/blueprint-library')
  })

  it('keeps dedicated notebook detail tabs with _tab_id intact during nested cleanup', () => {
    const store = useTabsStore()

    store.historyTabs = [
      createTab({
        key: '/notebooks/notebook-1?_tab_id=nb-tab-1',
        title: 'menu.notebookDetail',
        path: '/notebooks/notebook-1?_tab_id=nb-tab-1',
        sort: 10
      })
    ]
    store.activeTab = '/notebooks/notebook-1?_tab_id=nb-tab-1'

    const changed = store.cleanupNestedRouteTabs()

    expect(changed).toBe(false)
    expect(store.historyTabs[0]?.key).toBe('/notebooks/notebook-1?_tab_id=nb-tab-1')
    expect(store.activeTab).toBe('/notebooks/notebook-1?_tab_id=nb-tab-1')
  })
})
