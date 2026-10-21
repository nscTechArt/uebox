import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import { getTabCacheKey } from '@renderer/common/tabRoute'
import { useTabsStore } from '@renderer/store/modules/tabs'
import BlueprintLibraryLayout from './BlueprintLibraryLayout.vue'

// 缓存 key 与 MainLayout 使用同一个函数：Layout 依靠它判断路由归属
const AppShell = defineComponent({
  setup: () => ({ getTabCacheKey }),
  template: `
    <router-view v-slot="{ Component, route }">
      <keep-alive>
        <component v-if="route.meta.keepAlive" :is="Component" :key="getTabCacheKey(route)" />
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
  // 挂载和 afterEach 使用同一个 pinia：Layout 读取的 tab 列表必须和创建 tab 的是同一份
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('switches between cached routes without throwing keep-alive lifecycle errors', async () => {
    const router = createTestRouter()
    // 与真实应用一致，每次导航后创建 tab：Layout 根据 tab 是否还在决定是否保留子页
    router.afterEach((to) => {
      useTabsStore(pinia).addTab(to)
    })
    router.push('/blueprint-library')
    await router.isReady()

    const wrapper = mount(
      defineComponent({
        template: '<router-view />'
      }),
      {
        attachTo: document.body,
        global: {
          plugins: [pinia, router]
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
