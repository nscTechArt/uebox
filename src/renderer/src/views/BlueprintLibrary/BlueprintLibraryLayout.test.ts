import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import BlueprintLibraryLayout from './BlueprintLibraryLayout.vue'

const AppShell = defineComponent({
  template: `
    <router-view v-slot="{ Component, route }">
      <keep-alive>
        <component v-if="route.meta.keepAlive" :is="Component" :key="route.fullPath" />
      </keep-alive>
      <component v-if="!route.meta.keepAlive" :is="Component" :key="route.fullPath" />
    </router-view>
  `
})

const BlueprintGalleryStub = defineComponent({
  template: '<div class="blueprint-gallery-stub">gallery</div>'
})

const BlueprintEditorStub = defineComponent({
  template: '<div class="blueprint-editor-stub">editor</div>'
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
            path: 'blueprint-library',
            component: BlueprintLibraryLayout,
            meta: {
              keepAlive: true
            },
            children: [
              {
                path: '',
                name: 'BlueprintGallery',
                component: BlueprintGalleryStub,
                meta: {
                  keepAlive: true
                }
              },
              {
                path: ':id',
                name: 'BlueprintEditor',
                component: BlueprintEditorStub,
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

describe('BlueprintLibraryLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('switches between cached routes without throwing keep-alive lifecycle errors', async () => {
    const router = createTestRouter()
    router.push('/blueprint-library')
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

    expect(wrapper.find('.blueprint-gallery-stub').exists()).toBe(true)

    await router.push('/blueprint-library/blueprint-1')
    await flushPromises()
    expect(wrapper.find('.blueprint-editor-stub').exists()).toBe(true)

    await router.push('/other')
    await flushPromises()
    expect(wrapper.find('.other-page-stub').exists()).toBe(true)

    await router.push('/blueprint-library/blueprint-1')
    await flushPromises()
    expect(wrapper.find('.blueprint-editor-stub').exists()).toBe(true)

    await router.push('/blueprint-library')
    await flushPromises()
    expect(wrapper.find('.blueprint-gallery-stub').exists()).toBe(true)
  })
})
