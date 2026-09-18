import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

/*
 * AI 面板整个替身掉：它里面嵌的是主助手本身，真挂起来会把 agent 内核、
 * 语音、审批那一整套拖进来。要测的是「面板拿到的上下文对不对」，
 * 那在 props 上就看得见。
 */
vi.mock('@renderer/views/library-common/components/LibraryAIPanel.vue', () => ({
  default: defineComponent({
    name: 'LibraryAIPanelStub',
    props: {
      mode: { type: String, default: 'docked' },
      sessionId: { type: String, default: '' },
      context: { type: Object, default: null }
    },
    emits: ['update:mode', 'restore', 'snapshot-selection'],
    template: '<div class="lib-ai-panel-stub" />'
  })
}))

import LibraryAIPanel from '@renderer/views/library-common/components/LibraryAIPanel.vue'
import SnippetDetail from './SnippetDetail.vue'

const T3D =
  'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="K2Node_IfThenElse_0"\nEnd Object'

function payloadOf(overrides: Record<string, unknown> = {}): unknown {
  return {
    form: 'snippet',
    t3d: T3D,
    sourceBlueprintPath: '/Game/BP_Player',
    sourceGraphName: 'EventGraph',
    meta: {
      nodeCount: 3,
      connectionCount: 2,
      classes: ['Branch', 'Function'],
      openPorts: []
    },
    ...overrides
  }
}

function mountDetail(payload: unknown = payloadOf()): VueWrapper {
  return mount(SnippetDetail, {
    props: { name: '受击闪红', payload, entryId: 'entry-1' }
  })
}

describe('SnippetDetail 交给助手的上下文', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('把片段正文整段带过去 —— 不然助手只能对着「3 个节点」猜', () => {
    const panel = mountDetail().findComponent(LibraryAIPanel)
    const context = panel.props('context') as { overview: string }

    expect(context.overview).toContain(T3D)
  })

  it('带上条目身份和摘要', () => {
    const panel = mountDetail().findComponent(LibraryAIPanel)
    const context = panel.props('context') as {
      library: string
      entryId: string
      entryName: string
      overview: string
    }

    expect(context.library).toBe('blueprint')
    expect(context.entryId).toBe('entry-1')
    expect(context.entryName).toBe('受击闪红')
    expect(context.overview).toContain('节点 3 / 连线 2')
    expect(context.overview).toContain('Branch')
    expect(context.overview).toContain('/Game/BP_Player')
  })

  it('正文太长就截断，并且说明截了 —— 不假装给全了', () => {
    const huge = 'x'.repeat(20000)
    const panel = mountDetail(payloadOf({ t3d: huge })).findComponent(LibraryAIPanel)
    const context = panel.props('context') as { overview: string }

    expect(context.overview).toContain('截断')
    expect(context.overview.length).toBeLessThan(huge.length)
  })

  it('会话 id 跟着条目走，而且用 library-chat- 打头', () => {
    // 前缀是「别把它列进侧边栏」和「通知点回来认得路」的依据
    const panel = mountDetail().findComponent(LibraryAIPanel)
    expect(panel.props('sessionId')).toBe('library-chat-blueprint-entry-1')
  })

  it('老条目形态的 payload 不挂面板 —— 那种没有正文可给', () => {
    const wrapper = mountDetail({ graphs: [{ name: 'EventGraph', code: T3D }] })
    expect(wrapper.findComponent(LibraryAIPanel).exists()).toBe(false)
  })
})
