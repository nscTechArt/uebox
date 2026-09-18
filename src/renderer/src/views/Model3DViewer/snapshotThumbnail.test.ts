import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * 「截图更新缩略图」这条链子有四节，断哪一节表现都是"点了没反应"：
 * 工具条按钮 → 页面调查看器的 captureSnapshot → 查看器 emit snapshot → 页面存库。
 *
 * 之前就是最后一节没接：截图拍了、事件也发了，页面没人听，图片进了垃圾桶。
 * 光看代码看不出来（每一节自己都对），所以这条链子要有测试从头走到尾。
 */

const routeQuery: Record<string, string | undefined> = {}

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

// 真查看器要起 WebGL；这里只要它能被调用、能把截图发出来
vi.mock('@renderer/components/ModelViewer.vue', () => ({
  default: {
    name: 'ModelViewerStub',
    props: ['filePath', 'fileUrl', 'file', 'lightPreset', 'exposure', 'viewMode'],
    emits: ['snapshot', 'modelStats', 'load', 'error'],
    methods: {
      captureSnapshot(this: { $emit: (e: string, ...args: unknown[]) => void }): void {
        this.$emit('snapshot', 'data:image/jpeg;base64,AAAA')
      },
      forceResize: vi.fn(),
      resetView: vi.fn(),
      toggleUpAxis: vi.fn()
    },
    template: '<canvas class="stub-canvas" />'
  }
}))

const saveThumbnail = vi.fn()
vi.mock('@renderer/api/assetData', () => ({
  assetDataAPI: {
    saveThumbnail: (...args: unknown[]) => saveThumbnail(...args)
  }
}))

// vi.mock 会被提升到文件顶部，工厂里不能引用普通的顶层变量，得走 vi.hoisted
const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn() }
}))
vi.mock('@renderer/utils/messageManager', () => ({ message }))

import Model3DViewerPage from './index.vue'

function mountPage(): ReturnType<typeof mount> {
  return mount(Model3DViewerPage, {
    global: {
      plugins: [createPinia()],
      mocks: { $t: (key: string) => key }
    }
  })
}

/** 工具条上最后一个按钮就是相机 */
function snapshotButton(wrapper: ReturnType<typeof mount>): ReturnType<typeof wrapper.findAll>[0] {
  const buttons = wrapper.findAll('.view-mode-toolbar .mode-btn')
  return buttons[buttons.length - 1]
}

beforeEach(() => {
  saveThumbnail.mockReset().mockResolvedValue('thumb.jpg')
  message.success.mockReset()
  message.error.mockReset()
  Object.keys(routeQuery).forEach((key) => delete routeQuery[key])
  // 页面会去问文件大小，测试里给个空壳
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
    ipcRenderer: { invoke: vi.fn().mockResolvedValue({ size: 1024 }) }
  }
})

describe('截图更新缩略图', () => {
  it.each(['select', 'drop'])('手动换模型（%s）后不再写回原资产', async (method) => {
    routeQuery.filePath = 'H:/assets/a.glb'
    routeQuery.assetKey = 'asset-a'
    Object.assign(window.api, {
      dialog: {
        showOpenDialog: vi
          .fn()
          .mockResolvedValue({ canceled: false, filePaths: ['H:/local/b.glb'] })
      }
    })
    window.api.getPathForFile = vi.fn().mockResolvedValue('H:/local/b.glb')
    const wrapper = mountPage()
    await nextTick()
    expect(snapshotButton(wrapper).attributes('disabled')).toBeUndefined()
    if (method === 'select') await wrapper.get('.file-select-btn').trigger('click')
    else
      await wrapper
        .get('.stub-canvas')
        .trigger('drop', { dataTransfer: { files: [new File(['model'], 'b.glb')] } })
    await flushPromises()
    expect(snapshotButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper
      .findComponent({ name: 'ModelViewerStub' })
      .vm.$emit('snapshot', 'data:image/jpeg;base64,AAAA')
    await flushPromises()
    expect(saveThumbnail).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('从资产库进来：点一下就把图存回那个资产，并让列表去刷新', async () => {
    routeQuery.filePath = 'H:/素材库/柯基屋.glb'
    routeQuery.assetKey = 'asset-123'
    const refreshed = vi.fn()
    window.addEventListener('asset-thumbnail:updated', refreshed)

    const wrapper = mountPage()
    await nextTick()

    await snapshotButton(wrapper).trigger('click')
    await nextTick()
    await nextTick()

    expect(saveThumbnail).toHaveBeenCalledWith('asset-123', 'data:image/jpeg;base64,AAAA')
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(message.success).toHaveBeenCalled()

    window.removeEventListener('asset-thumbnail:updated', refreshed)
    wrapper.unmount()
  })

  it('存库失败要说出来，不能装作成功', async () => {
    routeQuery.filePath = 'H:/素材库/柯基屋.glb'
    routeQuery.assetKey = 'asset-123'
    saveThumbnail.mockRejectedValue(new Error('磁盘满了'))

    const wrapper = mountPage()
    await nextTick()

    await snapshotButton(wrapper).trigger('click')
    await nextTick()
    await nextTick()

    expect(message.error).toHaveBeenCalled()
    expect(message.success).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('自己拖进来的文件没有资产可更新，按钮是灰的 —— 不做点了没反应的按钮', async () => {
    routeQuery.filePath = 'H:/桌面/随便一个.fbx'

    const wrapper = mountPage()
    await nextTick()

    expect(snapshotButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
