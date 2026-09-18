/**
 * 桥接状态订阅：订阅要先于拉取，卸载要摘干净。
 *
 * 两个红灯用例，都无声：
 * 1. 先 await getStatus() 再订阅 —— 组件在 await 期间被卸载（切设置标签页就会），
 *    onBeforeUnmount 拿到的是 null，订阅建在卸载之后，再也摘不掉。切十几次就
 *    MaxListenersExceededWarning，每个还吊着一份已丢弃的组件闭包。
 * 2. 卸载不退订 —— 同样是每来一次泄一个，而且不会有任何报错。
 *
 * 这个文件**必须 import 真的那个 composable**。上一版在测试里手抄了一份
 * 一模一样的实现来测，于是把真组件里的两行调换顺序，三条用例照样全绿 ——
 * 一条守不住任何东西的防线，比没有防线更糟，因为它看着像有。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { useBridgeStatus, useConnectedProjects } from './useBridgeStatus'

type FakeApi = {
  getStatus: () => Promise<unknown>
  onStatusChanged: (cb: (s: unknown) => void) => () => void
}

type WindowWithApi = { api?: unknown }
let originalApi: unknown
let apiSaved = false

/**
 * 只此一个 mount 工厂。
 *
 * 两个 describe 各写一份的话，`window.api` 的存取约定（下面 afterEach 解释的那条）
 * 就有两处要维护 —— 而且 `vue/one-component-per-file` 会因为第二个 defineComponent
 * 报 warning，那个文件在 lint 棘轮里的预算是 0。
 */
function mountWithApi(api: unknown, use: () => () => string): VueWrapper {
  // composable 读的是 window.api.websocket，测试就从那里喂进去 ——
  // 不给它开一个「测试专用的参数」，否则真机走的又是另一条路
  if (!apiSaved) {
    originalApi = (window as WindowWithApi).api
    apiSaved = true
  }
  ;(window as WindowWithApi).api = { websocket: api }

  return mount(
    defineComponent({
      setup() {
        const text = use()
        return () => h('div', text())
      }
    })
  )
}

function mountWith(api: FakeApi): VueWrapper {
  return mountWithApi(api, () => {
    const bridge = useBridgeStatus()
    return () => String((bridge.value as { state?: string } | null)?.state ?? 'null')
  })
}

// 挂上去的组件一律自动卸载。不然用例跑完组件还活着、订阅还挂着，
// 而 afterEach 已经把 window.api 换回去了 —— 这个文件讲的就是「卸载要退订」，
// 自己先漏一地说不过去
enableAutoUnmount(afterEach)

// 还回去，不是删掉 —— tests/setup.ts 每个文件只装一次 window.api，
// 删了之后这个文件里下一个不走 mountWith 的用例就会拿到 undefined
afterEach(() => {
  if (apiSaved) (window as WindowWithApi).api = originalApi
})

describe('useBridgeStatus', () => {
  it('卸载时退订', async () => {
    const unsubscribe = vi.fn()
    const wrapper = mountWith({
      getStatus: async () => ({ state: 'listening' }),
      onStatusChanged: () => unsubscribe
    })
    await flushPromises()

    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  /*
   * 这条是主菜：订阅必须发生在第一个 await 之前。
   * 反过来写的话，在 getStatus 还没回来时卸载，onBeforeUnmount 摘到的是 null，
   * 而订阅随后才建起来 —— 泄漏且无声。
   */
  it('await 期间卸载也不会漏掉退订', async () => {
    const unsubscribe = vi.fn()
    let resolveStatus: (v: unknown) => void = () => {}
    const wrapper = mountWith({
      getStatus: () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
      onStatusChanged: () => unsubscribe
    })

    // getStatus 还挂着就卸载
    wrapper.unmount()
    resolveStatus({ state: 'listening' })
    await flushPromises()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('问不到状态时停在 null —— 不报一句没核实过的「没运行」', async () => {
    const wrapper = mountWith({
      getStatus: async () => {
        throw new Error('IPC 断了')
      },
      onStatusChanged: () => () => {}
    })
    await flushPromises()

    expect(wrapper.text()).toBe('null')
  })

  it('推过来的新状态会盖掉旧的', async () => {
    let push: (s: unknown) => void = () => {}
    const wrapper = mountWith({
      getStatus: async () => ({ state: 'listening' }),
      onStatusChanged: (cb) => {
        push = cb
        return () => {}
      }
    })
    await flushPromises()

    push({ state: 'idle' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toBe('idle')
  })

  /*
   * 订阅和首拉各自一个 try：订阅挂了不该把首拉也拖下水。
   * 合成一个 try 的话，preload 只坏了订阅那一半时界面连一次性快照都拿不到，
   * 永远停在「还没问到」—— 而那三个用它的组件已经把自己的重拉删掉了。
   */
  it('订阅抛了：不炸挂载钩子，首拉照跑', async () => {
    const wrapper = mountWith({
      getStatus: async () => ({ state: 'listening' }),
      onStatusChanged: () => {
        throw new TypeError('preload 没起来')
      }
    })
    await flushPromises()

    expect(wrapper.text()).toBe('listening')
  })

  it('首拉抛了：不炸挂载钩子，订阅照样建起来', async () => {
    let push: (s: unknown) => void = () => {}
    const wrapper = mountWith({
      getStatus: async () => {
        throw new Error('IPC 断了')
      },
      onStatusChanged: (cb) => {
        push = cb
        return () => {}
      }
    })
    await flushPromises()

    push({ state: 'idle' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toBe('idle')
  })

  /*
   * 「先订阅」自己带来的坑：getStatus 还挂着的时候推送先到，等 getStatus 回来
   * 就会拿那份旧快照把新值盖回去 —— 界面倒退回一个已经不成立的状态。
   * 用户在桥接正好停掉的那一刻打开设置页就撞得上。
   */
  it('初始快照回来得晚，也不许盖掉已经推过来的新状态', async () => {
    let resolveStatus: (v: unknown) => void = () => {}
    let push: (s: unknown) => void = () => {}
    const wrapper = mountWith({
      getStatus: () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
      onStatusChanged: (cb) => {
        push = cb
        return () => {}
      }
    })
    await flushPromises()

    // 推送先到，初始快照后到 —— 后到的是旧的
    push({ state: 'idle' })
    resolveStatus({ state: 'listening' })
    await flushPromises()

    expect(wrapper.text()).toBe('idle')
  })
})

/**
 * useConnectedProjects 是把 ProfilePlugin 里手写的那段生命周期收进来的那个导出，
 * 也就是回归历史落在它身上 —— 之前一条用例都没有：把订阅挪到 await 之后、
 * 或者让它不退订，全仓测试照样全绿。
 */
describe('useConnectedProjects', () => {
  function mountProjects(api: {
    getProjects: () => Promise<unknown>
    onProjectsChanged: (cb: (v: unknown) => void) => () => void
  }): VueWrapper {
    return mountWithApi(api, () => {
      const projects = useConnectedProjects()
      return () => String(projects.value?.length ?? 'null')
    })
  }

  it('拉到的列表长度渲染出来', async () => {
    const wrapper = mountProjects({
      getProjects: async () => [{ connectionId: 'a' }, { connectionId: 'b' }],
      onProjectsChanged: () => () => {}
    })
    await flushPromises()

    expect(wrapper.text()).toBe('2')
  })

  it('卸载时退订', async () => {
    const unsubscribe = vi.fn()
    const wrapper = mountProjects({
      getProjects: async () => [],
      onProjectsChanged: () => unsubscribe
    })
    await flushPromises()

    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('await 期间卸载也不会漏掉退订', async () => {
    const unsubscribe = vi.fn()
    let resolveProjects: (v: unknown) => void = () => {}
    const wrapper = mountProjects({
      getProjects: () =>
        new Promise((resolve) => {
          resolveProjects = resolve
        }),
      onProjectsChanged: () => unsubscribe
    })

    wrapper.unmount()
    resolveProjects([])
    await flushPromises()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('推送会盖掉首拉的结果', async () => {
    let push: (v: unknown) => void = () => {}
    const wrapper = mountProjects({
      getProjects: async () => [{ connectionId: 'a' }],
      onProjectsChanged: (cb) => {
        push = cb
        return () => {}
      }
    })
    await flushPromises()

    push([])
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toBe('0')
  })
})
