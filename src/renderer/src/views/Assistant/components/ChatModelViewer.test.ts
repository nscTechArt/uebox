import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

/**
 * 气泡里的模型预览有两件事要守住。
 *
 * 一是滚轮：在模型上滚是缩放，不该顺手把聊天记录一起翻走。ChatLog 的消息列表是
 * `scaleY(-1)` 翻过来的，它在滚动容器上挂了 `@wheel`，自己 preventDefault 之后
 * 手动改 scrollTop —— 那是 JS 干的活，浏览器的 preventDefault 拦不住，只要事件
 * 冒泡上去就照样滚。
 *
 * 二是能收起来：预览器 600px 高，还挂在最后一条消息的末尾，不想看的时候一直挡着。
 */

// 真查看器要起 WebGL，测试环境里没有
vi.mock('@renderer/components/ModelViewer.vue', () => ({
  default: {
    name: 'ModelViewerStub',
    props: ['filePath', 'autoPlay'],
    emits: ['load', 'error'],
    template: '<canvas class="stub-canvas" />'
  }
}))

import ChatModelViewer from './ChatModelViewer.vue'

/** 把组件挂到一个带 wheel 监听的父节点上，模拟 ChatLog 那层滚动容器 */
function mountInScroller(props: Record<string, unknown> = {}): {
  wrapper: ReturnType<typeof mount>
  outerWheel: ReturnType<typeof vi.fn>
  scroller: HTMLDivElement
} {
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  const outerWheel = vi.fn()
  scroller.addEventListener('wheel', outerWheel)

  const wrapper = mount(ChatModelViewer, {
    props: { filePath: 'H:/a.glb', ...props },
    attachTo: scroller
  })
  return { wrapper, outerWheel, scroller }
}

function wheelOn(el: Element): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

describe('ChatModelViewer 的滚轮', () => {
  it('模型加载出来后，滚轮不再传给外层滚动容器', async () => {
    const { wrapper, outerWheel } = mountInScroller()
    wrapper.findComponent({ name: 'ModelViewerStub' }).vm.$emit('load')
    await nextTick()

    const event = wheelOn(wrapper.find('.stub-canvas').element)

    expect(outerWheel).not.toHaveBeenCalled()
    // 也要掐掉浏览器自己的滚动链：滚动不看事件传播，只看默认行为
    expect(event.defaultPrevented).toBe(true)
    wrapper.unmount()
  })

  it('还没加载出来就放行，别留一块滚不动的死区', async () => {
    const { wrapper, outerWheel } = mountInScroller()
    await nextTick()

    const event = wheelOn(wrapper.find('.viewer-body').element)

    expect(outerWheel).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('加载失败后也放行', async () => {
    const { wrapper, outerWheel } = mountInScroller()
    const loader = wrapper.findComponent({ name: 'ModelViewerStub' })
    loader.vm.$emit('load')
    await nextTick()
    loader.vm.$emit('error', new Error('文件坏了'))
    await nextTick()

    wheelOn(wrapper.find('.viewer-body').element)

    expect(outerWheel).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('ChatModelViewer 的收起', () => {
  it('点标题栏收起，整个 loader 一起卸载（把 WebGL 上下文还回去）', async () => {
    const { wrapper } = mountInScroller()
    expect(wrapper.find('.viewer-body').exists()).toBe(true)

    await wrapper.find('.viewer-header').trigger('click')

    expect(wrapper.find('.viewer-body').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'ModelViewerStub' }).exists()).toBe(false)
    // 收起了还得知道这是哪个模型
    expect(wrapper.find('.header-title').text()).toBe('a.glb')

    await wrapper.find('.viewer-header').trigger('click')
    expect(wrapper.find('.viewer-body').exists()).toBe(true)
    wrapper.unmount()
  })

  it('收起后高度变了，通知外面重新量一次', async () => {
    const { wrapper } = mountInScroller()

    await wrapper.find('.viewer-header').trigger('click')

    expect(wrapper.emitted('resize')).toHaveLength(1)
    wrapper.unmount()
  })

  it('不是最新的那个模型，一开始就收着，loader 不占 WebGL 上下文', () => {
    const { wrapper } = mountInScroller({ defaultCollapsed: true })

    expect(wrapper.find('.viewer-body').exists()).toBe(false)
    expect(wrapper.find('.header-title').text()).toBe('a.glb')
    wrapper.unmount()
  })

  it('又出了个新模型，这一个自动让位收起来', async () => {
    const { wrapper } = mountInScroller()
    expect(wrapper.find('.viewer-body').exists()).toBe(true)

    await wrapper.setProps({ defaultCollapsed: true })

    expect(wrapper.find('.viewer-body').exists()).toBe(false)
    wrapper.unmount()
  })

  it('用户自己点开过的就别抢，新模型来了也照样摊着', async () => {
    const { wrapper } = mountInScroller()
    // 收起再点开 —— 这一个的开合从此听用户的
    await wrapper.find('.viewer-header').trigger('click')
    await wrapper.find('.viewer-header').trigger('click')
    expect(wrapper.find('.viewer-body').exists()).toBe(true)

    await wrapper.setProps({ defaultCollapsed: true })

    expect(wrapper.find('.viewer-body').exists()).toBe(true)
    wrapper.unmount()
  })

  it('中文文件名照原样显示，不露百分号编码', () => {
    const { wrapper } = mountInScroller({
      filePath: 'local-resource://H:/%E7%B4%A0%E6%9D%90%E5%BA%93/%E6%9F%AF%E5%9F%BA%E5%B1%8B.glb'
    })

    expect(wrapper.find('.header-title').text()).toBe('柯基屋.glb')
    wrapper.unmount()
  })

  it('收起状态下滚轮照常传给外层，别把标题栏也变成死区', async () => {
    const { wrapper, outerWheel } = mountInScroller()
    wrapper.findComponent({ name: 'ModelViewerStub' }).vm.$emit('load')
    await nextTick()
    await wrapper.find('.viewer-header').trigger('click')

    wheelOn(wrapper.find('.viewer-header').element)

    expect(outerWheel).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
