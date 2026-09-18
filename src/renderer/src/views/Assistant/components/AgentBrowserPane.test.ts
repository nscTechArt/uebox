import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentBrowserPane from './AgentBrowserPane.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string): string => key }) }))
vi.mock('@renderer/utils/messageManager', () => ({ message: { error: vi.fn() } }))

let wrapper: VueWrapper
let container: HTMLDivElement
let available = 1000
const resizeCallbacks = new Set<() => void>()
const setBounds = vi.fn()

function pointer(target: EventTarget, type: string, x: number, pointerId = 1, button = 0): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, pointerId, button }))
}

async function paint(): Promise<void> {
  await nextTick()
  resizeCallbacks.forEach((callback) => callback())
  await vi.advanceTimersByTimeAsync(40)
  await nextTick()
}

function width(): number {
  return parseFloat((wrapper.element as HTMLElement).style.width)
}

beforeEach(async () => {
  vi.useFakeTimers()
  available = 1000
  setBounds.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe(): void {
        resizeCallbacks.add(this.callback)
      }
      disconnect(): void {
        resizeCallbacks.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('pane-surface')) {
      const size = parseFloat(this.parentElement?.style.width ?? '') || 520
      return new DOMRect(available - size, 80, size, 700)
    }
    return new DOMRect(0, 40, available, 740)
  })
  window.api.agentBrowser = {
    tab: vi.fn().mockResolvedValue({ success: true, data: null }),
    setBounds,
    close: vi.fn(),
    getState: vi.fn(),
    openUrl: vi.fn(),
    toolbar: vi.fn()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(AgentBrowserPane, {
    attachTo: container,
    props: { sessionId: 'session-a', open: true, visible: true },
    global: { stubs: {} }
  })
  await paint()
})

afterEach(() => {
  wrapper.unmount()
  container.remove()
  resizeCallbacks.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('浏览器分割线', () => {
  it('审查复用侧栏并隐藏浏览器原生视图，切回后恢复', async () => {
    await wrapper.setProps({
      reviewOpen: true,
      reviewActive: true,
      group: {
        activeTabId: 'web',
        tabs: [{ id: 'web', title: 'Web', url: 'https://example.com', loading: false }]
      }
    })
    await paint()
    expect(setBounds).toHaveBeenLastCalledWith(null, 'session-a')
    expect(wrapper.find('.pane-review').exists()).toBe(true)
    expect(wrapper.find('.pane-header').isVisible()).toBe(false)
    expect(wrapper.findAll('[role="tab"]')[0].attributes('aria-selected')).toBe('true')
    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    expect(wrapper.emitted('selectBrowser')).toHaveLength(1)
    await wrapper.setProps({ reviewActive: false })
    await paint()
    expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 520 }), 'session-a')
    await wrapper.find('[aria-label="assistant.fileDiff.closeReview"]').trigger('click')
    expect(wrapper.emitted('closeReview')).toHaveLength(1)
    expect(window.api.agentBrowser.close).not.toHaveBeenCalled()
  })
  it('向左拖动变宽，拖动期间隐藏原生视图，松手恢复最终 bounds', async () => {
    const handle = wrapper.get('[role="separator"]')
    expect(width()).toBe(520)
    pointer(handle.element, 'pointerdown', 480)
    expect(setBounds).toHaveBeenLastCalledWith(null, 'session-a')
    pointer(document, 'pointermove', 380)
    await paint()
    expect(width()).toBe(620)
    expect(setBounds).toHaveBeenLastCalledWith(null, 'session-a')
    pointer(document, 'pointerup', 380)
    await paint()
    expect(setBounds).toHaveBeenLastCalledWith(
      { x: 380, y: 80, width: 620, height: 700 },
      'session-a'
    )
    expect(document.body.style.cursor).toBe('')
  })

  it('限制两侧最小宽度，并随窗口缩小重新约束', async () => {
    const handle = wrapper.get('[role="separator"]')
    pointer(handle.element, 'pointerdown', 480)
    pointer(document, 'pointermove', -500)
    await paint()
    expect(width()).toBe(640)
    pointer(document, 'pointermove', 2000)
    await paint()
    expect(width()).toBe(360)
    pointer(document, 'pointerup', 2000)
    available = 600
    await paint()
    expect(width()).toBe(300)
    expect(handle.attributes('aria-valuemax')).toBe('300')
  })

  it('键盘调整和双击重置，Escape 取消本次拖动', async () => {
    const handle = wrapper.get('[role="separator"]')
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(width()).toBe(544)
    await handle.trigger('keydown', { key: 'Home' })
    expect(width()).toBe(360)
    await handle.trigger('keydown', { key: 'End' })
    expect(width()).toBe(640)
    await handle.trigger('dblclick')
    expect(width()).toBe(520)
    pointer(handle.element, 'pointerdown', 480)
    pointer(document, 'pointermove', 400)
    await paint()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await paint()
    expect(width()).toBe(520)
  })

  it('忽略右键和其他指针，切走或失焦时结束拖动并恢复原有 body 样式', async () => {
    const handle = wrapper.get('[role="separator"]')
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'
    pointer(handle.element, 'pointerdown', 480, 1, 2)
    expect(document.body.style.cursor).toBe('crosshair')
    pointer(handle.element, 'pointerdown', 480)
    pointer(document, 'pointermove', 200, 2)
    await paint()
    expect(width()).toBe(520)
    await wrapper.setProps({ visible: false })
    await paint()
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
    expect(setBounds).toHaveBeenLastCalledWith(null, 'session-a')
    await wrapper.setProps({ visible: true })
    pointer(handle.element, 'pointerdown', 480)
    window.dispatchEvent(new Event('blur'))
    expect(document.body.style.cursor).toBe('crosshair')
  })

  it('卸载时停止拖动，移除监听，不再显示原生网页', async () => {
    pointer(wrapper.get('[role="separator"]').element, 'pointerdown', 480)
    wrapper.unmount()
    expect(document.body.style.cursor).toBe('')
    expect(setBounds).toHaveBeenLastCalledWith(null, 'session-a')
    const count = setBounds.mock.calls.length
    pointer(document, 'pointermove', 200)
    expect(setBounds).toHaveBeenCalledTimes(count)
    expect(resizeCallbacks.size).toBe(0)
  })
})

it('显示域名，聚焦编辑完整地址，回车打开会话新页面', async () => {
  await wrapper.setProps({ url: 'https://www.unrealengine.com/feed?tags=news' })
  const input = wrapper.get('input')
  expect((input.element as HTMLInputElement).value).toBe('unrealengine.com')
  await input.trigger('focus')
  expect((input.element as HTMLInputElement).value).toBe(
    'https://www.unrealengine.com/feed?tags=news'
  )
  await input.setValue('example.com/docs')
  vi.mocked(window.api.agentBrowser.openUrl).mockResolvedValue({
    success: true,
    data: { url: 'https://example.com/docs' }
  })
  await input.trigger('keydown', { key: 'Enter' })
  await paint()
  expect(window.api.agentBrowser.openUrl).toHaveBeenCalledWith('session-a', 'example.com/docs')
  expect((input.element as HTMLInputElement).value).toBe('example.com')
})

it('页面跳转同步域名，编辑期间不覆盖输入，Esc 取消且不导航', async () => {
  await wrapper.setProps({ url: 'https://example.com/first' })
  const input = wrapper.get('input')
  await input.trigger('focus')
  await input.setValue('new.example.com')
  await wrapper.setProps({ url: 'https://example.org/redirect' })
  expect((input.element as HTMLInputElement).value).toBe('new.example.com')
  await input.trigger('keydown', { key: 'Escape' })
  expect((input.element as HTMLInputElement).value).toBe('example.org')
  expect(window.api.agentBrowser.openUrl).not.toHaveBeenCalled()
})

it('输入法确认和空地址不导航，加载失败显示提示并恢复输入框', async () => {
  const { message } = await import('@renderer/utils/messageManager')
  const input = wrapper.get('input')
  await input.trigger('focus')
  await input.setValue('example.com')
  await input.trigger('keydown', { key: 'Enter', isComposing: true })
  expect(window.api.agentBrowser.openUrl).not.toHaveBeenCalled()
  vi.mocked(window.api.agentBrowser.openUrl).mockRejectedValue(new Error('offline'))
  await input.trigger('keydown', { key: 'Enter' })
  await paint()
  expect(message.error).toHaveBeenCalledWith('assistant.browserPane.navigationFailed')
  expect((input.element as HTMLInputElement).disabled).toBe(false)
  vi.mocked(window.api.agentBrowser.openUrl).mockClear()
  await input.trigger('focus')
  await input.setValue(' ')
  await input.trigger('keydown', { key: 'Enter' })
  expect(window.api.agentBrowser.openUrl).not.toHaveBeenCalled()
})

it('按浏览历史启用按钮，加载时刷新切换为停止，并按会话执行操作', async () => {
  const back = wrapper.get('[data-action="back"]')
  const forward = wrapper.get('[data-action="forward"]')
  const reload = wrapper.get('[data-action="reload-stop"]')
  expect(back.attributes('disabled')).toBeDefined()
  expect(forward.attributes('disabled')).toBeDefined()
  vi.mocked(window.api.agentBrowser.toolbar).mockResolvedValue({ success: true, data: null })
  await wrapper.setProps({ navigation: { canGoBack: true, canGoForward: true, loading: false } })
  for (const [button, action] of [
    [back, 'back'],
    [forward, 'forward'],
    [reload, 'reload']
  ] as const) {
    await button.trigger('click')
    expect(window.api.agentBrowser.toolbar).toHaveBeenLastCalledWith('session-a', action)
  }
  await wrapper.setProps({ navigation: { canGoBack: true, canGoForward: false, loading: true } })
  expect(forward.attributes('disabled')).toBeDefined()
  expect(reload.attributes('aria-label')).toBe('assistant.browserPane.stop')
  await reload.trigger('click')
  expect(window.api.agentBrowser.toolbar).toHaveBeenLastCalledWith('session-a', 'stop')
})

it('Tab 栏能新建、选择、关闭，并将整组切换到独立窗口', async () => {
  await wrapper.setProps({
    group: {
      activeTabId: 'first',
      tabs: [
        { id: 'first', title: 'First', url: 'https://example.com/', loading: false },
        { id: 'second', title: 'Second', url: 'https://example.org/', loading: false }
      ]
    }
  })
  expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
  await wrapper.findAll('[role="tab"]')[1].trigger('click')
  expect(window.api.agentBrowser.tab).toHaveBeenLastCalledWith('session-a', {
    action: 'select',
    tabId: 'second'
  })
  await wrapper.findAll('[aria-label="assistant.browserPane.closeTab"]')[0].trigger('click')
  expect(window.api.agentBrowser.tab).toHaveBeenLastCalledWith('session-a', {
    action: 'close',
    tabId: 'first'
  })
  await wrapper.find('[aria-label="assistant.browserPane.detach"]').trigger('click')
  expect(window.api.agentBrowser.tab).toHaveBeenLastCalledWith('session-a', {
    action: 'mode',
    mode: 'window'
  })
  await wrapper.setProps({ standalone: true })
  expect(wrapper.find('.pane-resizer').exists()).toBe(false)
  await wrapper.find('[aria-label="assistant.browserPane.embed"]').trigger('click')
  expect(window.api.agentBrowser.tab).toHaveBeenLastCalledWith('session-a', {
    action: 'mode',
    mode: 'embedded'
  })
  await wrapper.find('[aria-label="assistant.browserPane.newTab"]').trigger('click')
  expect(window.api.agentBrowser.tab).toHaveBeenLastCalledWith('session-a', { action: 'create' })
})
