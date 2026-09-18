import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentBrowserAPI, type AgentBrowserState } from '@renderer/api/agentBrowser'
import { useSessionBrowser } from './useSessionBrowser'

vi.mock('@renderer/api/agentBrowser', () => ({ agentBrowserAPI: { getState: vi.fn() } }))

const navigation = { canGoBack: false, canGoForward: false, loading: false }
const opened: AgentBrowserState = {
  tabs: [],
  activeTabId: null,
  navigation,
  open: true,
  mode: 'embedded',
  url: 'https://example.com/'
}
let listener: (...args: unknown[]) => void
const wrappers: ReturnType<typeof mount>[] = []

function setup(id = 'a'): {
  id: ReturnType<typeof ref<string>>
  active: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof vi.fn>
  browser: ReturnType<typeof useSessionBrowser>
} {
  const sessionId = ref(id)
  const active = ref(true)
  const error = vi.fn()
  let browser!: ReturnType<typeof useSessionBrowser>
  const wrapper = mount(
    defineComponent({
      setup() {
        browser = useSessionBrowser(sessionId, active, error)
        return () => h('div')
      }
    })
  )
  wrappers.push(wrapper)
  return { id: sessionId, active, error, browser }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentBrowserAPI.getState).mockResolvedValue(opened)
  vi.spyOn(window.api, 'on').mockImplementation((_channel, handler) => {
    listener = handler
    return handler
  })
  vi.spyOn(window.api, 'off').mockImplementation(() => undefined)
})

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('会话浏览器面板', () => {
  it('首次进入和重新激活时恢复，切走不关闭保存的页面', async () => {
    const state = setup()
    await flushPromises()
    expect(state.browser.open.value).toBe(true)
    expect(state.browser.url.value).toBe('https://example.com/')
    expect(agentBrowserAPI.getState).toHaveBeenCalledWith('a', true)
    state.active.value = false
    await flushPromises()
    expect(agentBrowserAPI.getState).toHaveBeenCalledTimes(1)
    state.active.value = true
    await flushPromises()
    expect(agentBrowserAPI.getState).toHaveBeenCalledTimes(2)
  })

  it('忽略其他会话广播和切换之前的延迟响应', async () => {
    let resolveA!: (state: AgentBrowserState) => void
    vi.mocked(agentBrowserAPI.getState).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve
        })
    )
    const state = setup()
    state.id.value = 'b'
    vi.mocked(agentBrowserAPI.getState).mockResolvedValue({
      tabs: [],
      activeTabId: null,
      navigation,
      open: false,
      mode: 'embedded',
      url: ''
    })
    await flushPromises()
    resolveA(opened)
    listener({ sessionId: 'a', ...opened })
    await flushPromises()
    expect(state.browser.open.value).toBe(false)
    listener({ sessionId: 'b', ...opened })
    expect(state.browser.open.value).toBe(true)
  })

  it('关闭广播不能被旧查询重新打开，恢复失败会提示', async () => {
    let resolveState!: (state: AgentBrowserState) => void
    vi.mocked(agentBrowserAPI.getState).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveState = resolve
        })
    )
    const state = setup()
    listener({ sessionId: 'a', open: false, mode: 'embedded' })
    resolveState(opened)
    await flushPromises()
    expect(state.browser.open.value).toBe(false)
    vi.mocked(agentBrowserAPI.getState).mockRejectedValue(new Error('offline'))
    state.active.value = false
    await flushPromises()
    state.active.value = true
    await flushPromises()
    expect(state.error).toHaveBeenCalledOnce()
  })

  it('没有 Agent 会话 ID 时不恢复，卸载会移除广播监听', async () => {
    setup('')
    await flushPromises()
    expect(agentBrowserAPI.getState).not.toHaveBeenCalled()
    wrappers.pop()?.unmount()
    expect(window.api.off).toHaveBeenCalledWith('agent-browser:state', listener)
  })
})
