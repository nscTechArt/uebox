import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import type { EditorHealthResult } from '@core/shared/editorHealth'
import { evaluateEditorHealth } from '@core/shared/editorHealth'

/**
 * 顶栏状态监控：没连编辑器不出现、有异常才变黄带数字、「问 AI」只填输入框不替用户发。
 */

const connected = ref<unknown[] | null>([])
const getEditorHealth = vi.fn<(path: string) => Promise<EditorHealthResult>>()

vi.mock('@renderer/composables/useBridgeStatus', () => ({
  useConnectedProjects: () => connected
}))
vi.mock('@renderer/api/editorHealth', () => ({
  getEditorHealth: (path: string) => getEditorHealth(path)
}))

import EditorStatusMonitor from './EditorStatusMonitor.vue'

const dropdownStub = { template: '<div><slot /><slot name="overlay" /></div>' }
const tooltipStub = { props: ['title'], template: '<div :data-tip="title"><slot /></div>' }

const PROJECT = {
  connectionId: 'conn-1',
  projectName: 'Bound',
  projectPath: 'I:/CG Game/Bound',
  engineVersion: '5.5.4-40574608+++UE5+Release-5.5',
  isConnected: true
}

function okResult(overrides = {}): EditorHealthResult {
  const raw = {
    startup_seconds: 148,
    asset_registry_seconds: 100,
    enabled_plugin_count: 180,
    editor_hitch_pct: 0,
    editor_hitch_samples: 3000,
    ddc_supported: true,
    local_ddc_hit_pct: 98,
    available_memory_gb: 76.9,
    ...overrides
  }
  return { status: 'ok', raw, report: evaluateEditorHealth(raw) }
}

async function mountMonitor(chatSid = 'sid'): Promise<ReturnType<typeof mount>> {
  const chat = useChatSessionsStore()
  chat.ensureSession(chatSid, '二段跳')
  chat.setProject(chatSid, { projectName: 'Bound' })
  const wrapper = mount(EditorStatusMonitor, {
    props: { chatSid },
    global: { stubs: { AppDropdown: dropdownStub, AppTooltip: tooltipStub } }
  })
  await flushPromises()
  return wrapper
}

// 不卸载的话，前面各条挂的组件都还在监听 focus，最后一条会被读好几次
enableAutoUnmount(afterEach)

beforeEach(() => {
  connected.value = [PROJECT]
  getEditorHealth.mockReset().mockResolvedValue(okResult())
})

describe('EditorStatusMonitor', () => {
  it('工程没连着编辑器：按钮不出现，也不去读', async () => {
    connected.value = []
    const wrapper = await mountMonitor()

    expect(wrapper.find('.monitor-btn').exists()).toBe(false)
    expect(getEditorHealth).not.toHaveBeenCalled()
  })

  it('一切正常：灰色按钮、不带数字，面板里没有「需要注意」', async () => {
    const wrapper = await mountMonitor()

    expect(getEditorHealth).toHaveBeenCalledWith('I:/CG Game/Bound')
    expect(wrapper.find('.monitor-btn').classes()).not.toContain('bad')
    expect(wrapper.find('.monitor-count').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('需要注意')
    expect(wrapper.text()).toContain('2 分 28 秒')
    expect(wrapper.text()).toContain('Bound · UE 5.5.4')
  })

  it('有异常：按钮变黄带个数，异常项列在最前并写明预期', async () => {
    getEditorHealth.mockResolvedValue(okResult({ local_ddc_hit_pct: 62, startup_seconds: 200 }))
    const wrapper = await mountMonitor()

    expect(wrapper.find('.monitor-btn').classes()).toContain('bad')
    expect(wrapper.find('.monitor-count').text()).toBe('2')
    expect(wrapper.text()).toContain('需要注意')
    expect(wrapper.findAll('.bad-item')).toHaveLength(2)
    expect(wrapper.text()).toContain('预期 > 85.0%')
  })

  it('「问 AI」把问题填进这条会话的输入框，不替用户发出去', async () => {
    getEditorHealth.mockResolvedValue(okResult({ local_ddc_hit_pct: 62 }))
    const wrapper = await mountMonitor()

    await wrapper.find('.bad-item .ask-btn').trigger('click')

    expect(useChatSessionsStore().getDraft('sid')).toBe(
      '状态监控里「本地缓存命中」是 62.0%（预期 > 85.0%），帮我查查原因。'
    )
  })

  it('插件太旧：面板里说清楚要更新插件，按钮不报异常', async () => {
    getEditorHealth.mockResolvedValue({ status: 'plugin_outdated' })
    const wrapper = await mountMonitor()

    expect(wrapper.find('.monitor-btn').classes()).not.toContain('bad')
    expect(wrapper.text()).toContain('更新插件并重启编辑器后可用')
  })

  it('盒子窗口重新拿到焦点时再读一次（用户刚从编辑器切回来）', async () => {
    await mountMonitor()
    getEditorHealth.mockClear()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()

    expect(getEditorHealth).toHaveBeenCalledOnce()
  })

  it('读到一半换了工程：旧工程的结果不写到新工程名下，新工程照样去读', async () => {
    const OTHER = {
      ...PROJECT,
      connectionId: 'conn-2',
      projectName: 'Other',
      projectPath: 'D:/Other'
    }
    connected.value = [PROJECT, OTHER]
    let resolveOld: (value: EditorHealthResult) => void = () => {}
    getEditorHealth.mockImplementationOnce(
      () => new Promise<EditorHealthResult>((resolve) => (resolveOld = resolve))
    )
    const wrapper = await mountMonitor()

    useChatSessionsStore().setProject('sid', { projectName: 'Other' })
    await flushPromises()
    expect(getEditorHealth).toHaveBeenLastCalledWith('D:/Other')

    resolveOld(okResult({ startup_seconds: 900, local_ddc_hit_pct: 10 }))
    await flushPromises()
    expect(wrapper.find('.monitor-count').exists()).toBe(false)
  })
})
