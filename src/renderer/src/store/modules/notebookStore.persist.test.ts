import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'
import { useNotebookStore } from './notebookStore'

/**
 * localStorage 中只应保存 tab 的界面状态。
 *
 * 来源正文和持有计数只属于本次运行的内存状态：如果计数在重启后被恢复，
 * 「无人持有时释放正文」就永远不会触发。
 *
 * 插件要在 pinia 安装到 app 之后才会生效，只调用 use() 不够。
 */
describe('notebookStore persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia().use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it('persists only the tab ui state, not runtime source state', async () => {
    useNotebookStore().retainSources('nb')
    await flushPromises()

    const saved = localStorage.getItem('notebook-store')
    expect(saved).not.toBeNull()
    expect(Object.keys(JSON.parse(saved!))).toEqual(['tabUiStates'])
  })
})
