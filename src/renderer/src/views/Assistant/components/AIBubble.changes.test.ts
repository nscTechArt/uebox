import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import type { ResponseMetadataChange } from '@renderer/store/modules/chatMessages'

vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    reviewChanges: vi.fn(),
    openAsset: vi.fn()
  }
}))

import AIBubble from './AIBubble.vue'

/**
 * 「本轮改动」上的差异信息。
 *
 * 真机截图里这一行只有「Actor 修改属性」四个字 —— 改了哪个属性、改成了什么，
 * 用户一样都看不到。**行数变少不是目标，行上说得清才是**：清单存在的全部意义
 * 是「让我知道刚才我的工程被改了什么」，一个说不出改了什么的清单等于没有。
 */

function mountBubble(changes: ResponseMetadataChange[]): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-1',
      content: '改好了',
      status: 'done' as const,
      responseMetadata: { changes }
    },
    global: {
      stubs: {
        MarkdownRenderer: true,
        AgentProcessLog: true,
        ThinkingProcess: true,
        ChatModelViewer: true,
        AssetList: true,
        MessageSources: true,
        NavigationButton: true,
        'a-button': true,
        'a-dropdown': true,
        'a-menu': true,
        'a-menu-item': true,
        'a-menu-divider': true,
        'a-tooltip': { template: '<div><slot name="title" /><slot /></div>' }
      }
    }
  })
}

function change(over: Partial<ResponseMetadataChange>): ResponseMetadataChange {
  return {
    toolName: 'ue_set_property',
    risk: 'mutating',
    target: 'PointLight_1',
    reversible: true,
    failed: false,
    ...over
  }
}

async function expandChanges(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('.response-changes-header').trigger('click')
}

describe('AIBubble 本轮改动的差异信息', () => {
  it('默认只展示摘要，用户点击后才展示改动明细', async () => {
    const wrapper = mountBubble([change({ detail: 'Intensity=10000' })])

    expect(wrapper.find('.response-changes-header').text()).toContain('本轮改动（1）')
    expect(wrapper.find('.response-changes-item').exists()).toBe(false)
    expect(wrapper.find('.response-changes-caret').classes()).toContain('collapsed')

    await expandChanges(wrapper)

    expect(wrapper.find('.response-changes-item').exists()).toBe(true)
    expect(wrapper.find('.response-changes-caret').classes()).not.toContain('collapsed')
  })

  it('改了哪个 Actor、改成什么，都在行上', async () => {
    const wrapper = mountBubble([change({ detail: 'Intensity=10000' })])
    await expandChanges(wrapper)

    const row = wrapper.find('.response-changes-item')
    expect(row.text()).toContain('PointLight_1')
    expect(row.find('.response-changes-cmd').text()).toBe('Intensity=10000')
  })

  it('一行只做了一件事才把差异摆到行上；二十多步的材质挑哪一步都是以偏概全', async () => {
    const wrapper = mountBubble([
      change({ toolName: 'material_add_node', target: '/Game/M_A', detail: 'x' }),
      change({ toolName: 'material_connect_pins', target: '/Game/M_A', detail: 'y' })
    ])
    await expandChanges(wrapper)

    expect(wrapper.findAll('.response-changes-item')).toHaveLength(1)
    expect(wrapper.find('.response-changes-item').find('.response-changes-cmd').exists()).toBe(
      false
    )
  })

  it('展开区里逐步显示差异 —— 排查时要看的就是这个', async () => {
    const wrapper = mountBubble([
      change({ target: 'Cube_1', detail: 'bHidden=true' }),
      change({ toolName: 'ue_set_transform', target: 'Cube_1', detail: 'set.location=(0, 0, 100)' })
    ])

    await expandChanges(wrapper)
    await wrapper.find('.response-changes-toggle').trigger('click')

    const steps = wrapper.findAll('.response-changes-step')
    expect(steps).toHaveLength(2)
    expect(steps.map((step) => step.find('.response-changes-cmd').text())).toEqual([
      'bHidden=true',
      'set.location=(0, 0, 100)'
    ])
  })

  /**
   * 插件的 detail 是启停方向（`Enable`）—— 它已经变成了这一步的文案「启用插件」
   * 和行上的动作标签。再原样印一个英文单词只是噪音。
   */
  it('插件的启停方向不重复印第三遍', async () => {
    const wrapper = mountBubble([
      change({
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'GLTFImporter',
        detail: 'Enable'
      })
    ])
    await expandChanges(wrapper)

    expect(wrapper.find('.response-changes-item').find('.response-changes-cmd').exists()).toBe(
      false
    )
  })

  it('没有差异信息的旧消息展开后照旧显示，不会因此空一块', async () => {
    const wrapper = mountBubble([change({ toolName: 'material_create', target: '/Game/M_Wood' })])
    await expandChanges(wrapper)

    const row = wrapper.find('.response-changes-item')
    expect(row.text()).toContain('M_Wood')
    expect(row.find('.response-changes-cmd').exists()).toBe(false)
  })

  /**
   * 本地命令行不上面板（见 `changeSummary.ts` 的 `PANEL_HIDDEN_TOOLS`）。
   *
   * 真机上一轮五条 `where ffmpeg` / `ls -l` 探路命令，就是五行顶着「不可回滚」
   * 红标的黑盒 —— 用户什么都没改，面板却像出了大事。命令仍在台账里（「用量」页
   * 照常统计），也仍在过程日志和每一次的审批弹窗里。
   */
  it('只跑了本地命令行的那一轮，整个面板不出现', () => {
    const wrapper = mountBubble([
      change({ toolName: 'run_shell_command', risk: 'destructive', target: '', reversible: false })
    ])

    expect(wrapper.find('.response-changes').exists()).toBe(false)
  })

  it('本地命令行不占行，同一轮里真的改了的东西照常显示', async () => {
    const wrapper = mountBubble([
      change({ toolName: 'run_shell_command', risk: 'destructive', target: '', reversible: false }),
      change({ toolName: 'material_create', target: '/Game/M_Wood' })
    ])

    expect(wrapper.find('.response-changes-header').text()).toContain('本轮改动（1）')

    await expandChanges(wrapper)

    const rows = wrapper.findAll('.response-changes-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('M_Wood')
  })

  /**
   * UE 的控制台命令和 Python 脚本动的就是这个工程，它们照常占一行 ——
   * 别把「本地命令行不显示」误读成「所有命令都不显示」。
   */
  it('引擎的控制台命令照常占一行，带着命令原文', async () => {
    const wrapper = mountBubble([
      change({
        toolName: 'ue_run_console_command',
        risk: 'destructive',
        target: '',
        detail: 'stat fps'
      })
    ])
    await expandChanges(wrapper)

    expect(wrapper.find('.response-changes-cmd').text()).toBe('stat fps')
  })
})
