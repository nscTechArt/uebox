import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import BlueprintGallery from './BlueprintGallery.vue'
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'

vi.mock('@/utils/messageManager', () => ({
  message: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key
    })
  }
})

vi.mock('ant-design-vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ant-design-vue')>()
  return {
    ...actual,
    Modal: {
      ...actual.Modal,
      confirm: vi.fn()
    }
  }
})

vi.mock('./BlueprintCollectionOverlay.vue', () => ({
  default: {
    name: 'BlueprintCollectionOverlayStub',
    template: '<div />'
  }
}))

vi.mock('./BlueprintMigrationWizard.vue', () => ({
  default: {
    name: 'BlueprintMigrationWizardStub',
    template: '<div />'
  }
}))

vi.mock('@renderer/views/AssetManagement/components/modals/ImageCropperModal.vue', () => ({
  default: {
    name: 'ImageCropperModalStub',
    template: '<div />'
  }
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/blueprint-library',
        name: 'BlueprintGallery',
        component: { template: '<div />' }
      }
    ]
  })
}

describe('BlueprintGallery', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  it('edits an existing blueprint description from the info modal', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useBlueprintLibraryStore()
    store.blueprints.splice(0)
    store.collections.splice(0)

    const blueprint = store.createBlueprint({
      name: 'BP_Door',
      blueprintType: 'BlueprintClass',
      engineVersion: '5.4',
      description: '旧备注'
    })

    const router = createTestRouter()
    router.push('/blueprint-library')
    await router.isReady()

    const wrapper = mount(BlueprintGallery, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        stubs: {
          teleport: true,
          AppModal: true,
          'a-radio-button': true,
          'a-radio-group': true,
          'a-button': true
        }
      }
    })

    const editInfoItem = wrapper
      .findAll('.menu-item')
      .find((item) => item.text().includes('编辑信息'))
    expect(editInfoItem).toBeDefined()

    await editInfoItem!.trigger('click')

    const nameInput = wrapper.get('.modal-box input.form-input')
    const descriptionInput = wrapper.get<HTMLTextAreaElement>('.modal-box textarea.form-textarea')
    expect(descriptionInput.element.value).toBe('旧备注')

    await nameInput.setValue('BP_Door_Updated')
    await descriptionInput.setValue('更新后的备注描述')
    await wrapper.get('.modal-box .btn-confirm').trigger('click')

    const updatedBlueprint = store.blueprints.find((bp) => bp.id === blueprint.id)
    expect(updatedBlueprint?.name).toBe('BP_Door_Updated')
    expect(updatedBlueprint?.description).toBe('更新后的备注描述')
  })

  /**
   * 蓝图库的云同步已整体下线（两个版本都没有，后续重做）。
   *
   * 这条断言守的是「别又长回来」：同步按钮、卡片上的同步徽标都不该存在。
   * 曾经的形态是渲染一个灰掉的云图标配一句「请先登录」，而社区版根本没有
   * 登录入口，等于把用户指向一扇不存在的门。
   */
  it('蓝图库不渲染任何云同步入口', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useBlueprintLibraryStore()
    store.blueprints.splice(0)
    store.collections.splice(0)

    store.createBlueprint({
      name: 'BP_Synced',
      blueprintType: 'BlueprintClass',
      engineVersion: '5.4'
    })

    const router = createTestRouter()
    router.push('/blueprint-library')
    await router.isReady()

    const wrapper = mount(BlueprintGallery, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        stubs: {
          teleport: true,
          AppModal: true,
          'a-radio-button': true,
          'a-radio-group': true,
          'a-button': true
        }
      }
    })

    expect(wrapper.find('.btn-sync').exists()).toBe(false)
    expect(wrapper.find('.sync-badge').exists()).toBe(false)
    // 本地能力不受影响：从旧版导入的入口照常在
    expect(wrapper.find('.btn-import').exists()).toBe(true)

    // 页面内不再重复显示标题，两个页面操作都并入浏览器工具栏。
    expect(wrapper.find('.gallery-header').exists()).toBe(false)
    const toolbar = wrapper.get('.browser-toolbar')
    const importButton = toolbar.get('.btn-import')
    expect(importButton.attributes('aria-label')).toBeTruthy()
    expect(importButton.attributes('aria-label')).toBe(importButton.attributes('title'))
    expect(toolbar.find('.btn-primary-create').exists()).toBe(true)
  })
})
