import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import NotebookLayout from './NotebookLayout.vue'

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

const NotebookListStub = defineComponent({
  template: '<div class="notebook-list-stub">list</div>'
})

const NotebookDetailStub = defineComponent({
  template: '<div class="notebook-detail-stub">detail</div>'
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
            path: 'notebooks',
            component: NotebookLayout,
            meta: {
              keepAlive: true
            },
            children: [
              {
                path: '',
                name: 'NotebookList',
                component: NotebookListStub,
                meta: {
                  keepAlive: true
                }
              },
              {
                path: ':id',
                name: 'NotebookDetail',
                component: NotebookDetailStub,
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

describe('NotebookLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('switches between cached routes without throwing keep-alive lifecycle errors', async () => {
    const router = createTestRouter()
    router.push('/notebooks')
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

    expect(wrapper.find('.notebook-list-stub').exists()).toBe(true)

    await router.push('/notebooks/notebook-1')
    await flushPromises()
    expect(wrapper.find('.notebook-detail-stub').exists()).toBe(true)

    await router.push('/other')
    await flushPromises()
    expect(wrapper.find('.other-page-stub').exists()).toBe(true)

    await router.push('/notebooks/notebook-1')
    await flushPromises()
    expect(wrapper.find('.notebook-detail-stub').exists()).toBe(true)

    await router.push('/notebooks')
    await flushPromises()
    expect(wrapper.find('.notebook-list-stub').exists()).toBe(true)
  })
})
