import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import MaterialLibraryLayout from './MaterialLibraryLayout.vue'

const AppShell = defineComponent({
  template: `
    <router-view v-slot="{ Component, route }">
      <keep-alive>
        <component :is="Component" :key="route.fullPath" />
      </keep-alive>
    </router-view>
  `
})

const MaterialGalleryStub = defineComponent({
  template: '<div class="material-gallery-stub">gallery</div>'
})

const MaterialEditorStub = defineComponent({
  template: '<div class="material-editor-stub">editor</div>'
})

const OtherPageStub = defineComponent({
  template: '<div class="other-page-stub">other</div>'
})

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          {
            path: 'material-library',
            component: MaterialLibraryLayout,
            meta: {
              keepAlive: true
            },
            children: [
              {
                path: '',
                name: 'MaterialGallery',
                component: MaterialGalleryStub,
                meta: {
                  keepAlive: true
                }
              },
              {
                path: ':id',
                name: 'MaterialEditor',
                component: MaterialEditorStub,
                meta: {
                  keepAlive: true
                }
              }
            ]
          },
          {
            path: 'other',
            name: 'OtherPage',
            component: OtherPageStub
          }
        ]
      }
    ]
  })
}

describe('MaterialLibraryLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('switches between cached parent routes without throwing keep-alive lifecycle errors', async () => {
    const router = createTestRouter()
    router.push('/material-library')
    await router.isReady()

    const wrapper = mount(
      defineComponent({
        template: '<router-view />'
      }),
      {
        attachTo: document.body,
        global: {
          plugins: [createPinia(), router]
        }
      }
    )

    expect(wrapper.find('.material-gallery-stub').exists()).toBe(true)

    await router.push('/material-library/material-1')
    await flushPromises()
    expect(wrapper.find('.material-editor-stub').exists()).toBe(true)

    await router.push('/other')
    await flushPromises()
    expect(wrapper.find('.other-page-stub').exists()).toBe(true)

    await router.push('/material-library/material-1')
    await flushPromises()
    expect(wrapper.find('.material-editor-stub').exists()).toBe(true)

    await router.push('/material-library')
    await flushPromises()
    expect(wrapper.find('.material-gallery-stub').exists()).toBe(true)
  })
})
