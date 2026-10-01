import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import type { AgentReviewResult, AgentReviewTarget } from '@core/shared/agentReview'
import type { ResponseMetadataChange } from '@renderer/store/modules/chatMessages'

const reviewChanges = vi.fn()
vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    reviewChanges: (targets: AgentReviewTarget[]): Promise<AgentReviewResult> =>
      reviewChanges(targets),
    openAsset: vi.fn()
  }
}))

import AIBubble from './AIBubble.vue'
import { REVIEW_FIX_ACTION, SELF_CHECK_ACTION } from '../composables/selfCheck'

/**
 * 审查是**一次点击两件事**：先问引擎事实，紧接着让模型自证。
 *
 * 拆成两个按钮的话，用户得点两次才知道一件事的全貌，而中间那个状态
 * （查完了但还没让它解释）对谁都没有用。这些测试盯着那一条链没断。
 */

/** 一条「新建了材质 M_Wood」的改动记录，够生成一行改动清单 */
const materialChange: ResponseMetadataChange = {
  toolName: 'material_create',
  risk: 'mutating',
  target: '/Game/A/M_Wood',
  reversible: true,
  failed: false
}

function mountBubble(
  changes: ResponseMetadataChange[] = [materialChange],
  status: 'typing' | 'done' = 'done'
): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-1',
      content: '已经改好了',
      status,
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

describe('AIBubble 审查改动', () => {
  beforeEach(() => {
    reviewChanges.mockReset()
  })

  it('点一次，既问引擎也让它自证', async () => {
    reviewChanges.mockResolvedValue({
      success: true,
      checked: 1,
      findings: [
        { target: '/Game/A/M_Wood', code: 'unsaved', severity: 'warning' },
        { target: '/Game/A/M_Wood', code: 'naming', severity: 'info', detail: 'M_ / MI_' }
      ],
      engineChecked: true
    })

    const wrapper = mountBubble()
    await wrapper.find('.response-review-run').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 机器那一半：结论 + 逐条问题
    expect(reviewChanges).toHaveBeenCalledWith([
      { path: '/Game/A/M_Wood', action: 'created', kind: 'material' }
    ])
    expect(wrapper.find('.response-review-summary').text()).toContain('2')
    expect(wrapper.findAll('.response-review-item')).toHaveLength(2)

    // 模型那一半：同一次点击里发出去
    const actions = wrapper.emitted('action') ?? []
    expect(actions).toHaveLength(1)
    expect(actions[0][0]).toMatchObject({
      id: 'msg-1',
      action: SELF_CHECK_ACTION,
      data: { checked: 1, engineChecked: true }
    })
    expect(wrapper.find('.response-review-selfcheck').exists()).toBe(true)
  })

  it('机器查干净了也照样自证 —— 那正是它最有用的时候', async () => {
    reviewChanges.mockResolvedValue({
      success: true,
      checked: 3,
      findings: [],
      engineChecked: true
    })

    const wrapper = mountBubble()
    await wrapper.find('.response-review-run').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.findAll('.response-review-item')).toHaveLength(0)
    expect(wrapper.emitted('action')).toHaveLength(1)
  })

  /**
   * 未连接引擎时内核不注册 ue.* 只读工具，模型一个能核实的工具都没有。
   * 那时候要它「用工具重新查一遍」，只能换回一段凭记忆编的话 ——
   * 而凭记忆正是自证要禁掉的东西。
   */
  it('引擎没连上时只报机器那一半，不发自证', async () => {
    reviewChanges.mockResolvedValue({
      success: true,
      checked: 1,
      findings: [],
      engineChecked: false,
      engineError: '没有连接的虚幻引擎项目'
    })

    const wrapper = mountBubble()
    await wrapper.find('.response-review-run').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.find('.response-review-summary').text()).toContain('引擎')
    expect(wrapper.emitted('action')).toBeUndefined()
    expect(wrapper.find('.response-review-selfcheck').exists()).toBe(false)
  })

  it('审查本身炸了就不发自证 —— 没有结论可对质', async () => {
    reviewChanges.mockRejectedValue(new Error('管道断了'))

    const wrapper = mountBubble()
    await wrapper.find('.response-review-run').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.find('.response-review-summary').text()).toBe('管道断了')
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it('这一轮只动了本地文件时根本不显示审查入口', () => {
    const wrapper = mountBubble([
      {
        toolName: 'write_local_file',
        risk: 'mutating',
        target: 'D:/proj/说明.html',
        reversible: true,
        failed: false
      }
    ])

    // 先确认清单本身画出来了。只断言「审查入口不存在」的话，整个气泡什么都没渲染
    // 时它照样绿 —— 2026-09-04 把审查条卷进折叠区那次，红的是上面四条，这条一直绿着
    expect(wrapper.find('.response-changes-header').exists()).toBe(true)
    expect(wrapper.find('.response-review').exists()).toBe(false)
  })

  /**
   * 审查是动作不是明细，得跟标题同一行留在收起区外面。
   * 它曾经住在收起区里 —— 用户得先点开「本轮改动」才知道有这个功能，
   * 而 AI 刚说完「改好了」正是最该一眼看见它的时候。
   */
  it('改动清单默认收起，但审查按钮照样看得见、点得动', async () => {
    reviewChanges.mockResolvedValue({
      success: true,
      checked: 1,
      findings: [{ target: '/Game/A/M_Wood', code: 'unsaved', severity: 'warning' }],
      engineChecked: true
    })

    const wrapper = mountBubble()

    // 明细是收起的：一条施工步骤都没画出来
    expect(wrapper.findAll('.response-changes-step')).toHaveLength(0)
    // 审查按钮却在，不用先展开
    expect(wrapper.find('.response-review-run').exists()).toBe(true)

    await wrapper.find('.response-review-run').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 收起状态下点的审查，结论也要看得见
    expect(wrapper.findAll('.response-review-item')).toHaveLength(1)
    expect(wrapper.findAll('.response-changes-step')).toHaveLength(0)
  })
})

/**
 * 一轮刚结束时自动跑机器那一半。自证仍然要用户自己点 ——
 * 「是不是我要的」只有人试过才知道。
 */
describe('AIBubble 一轮结束时自动体检', () => {
  const clean: AgentReviewResult = { success: true, checked: 1, findings: [], engineChecked: true }

  beforeEach(() => {
    reviewChanges.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function finishTurn(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.setProps({ status: 'done' })
    await vi.advanceTimersByTimeAsync(1000)
  }

  it('看着它从 typing 变成 done，就静默体检一次，不发自证', async () => {
    reviewChanges.mockResolvedValue(clean)
    const wrapper = mountBubble([materialChange], 'typing')

    await finishTurn(wrapper)

    expect(reviewChanges).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.response-review-summary').classes()).toContain('ok')
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it('翻历史对话时不跑 —— 气泡一挂上来就是 done', async () => {
    mountBubble([materialChange], 'done')
    await vi.advanceTimersByTimeAsync(1000)

    expect(reviewChanges).not.toHaveBeenCalled()
  })

  it('一闪而过的 done 不算结束', async () => {
    const wrapper = mountBubble([materialChange], 'typing')

    await wrapper.setProps({ status: 'done' })
    await vi.advanceTimersByTimeAsync(100)
    await wrapper.setProps({ status: 'typing' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(reviewChanges).not.toHaveBeenCalled()
  })

  it('改的资产太多就不自动跑，留给用户点', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...materialChange,
      target: `/Game/A/M_${i}`
    }))
    const wrapper = mountBubble(many, 'typing')

    await finishTurn(wrapper)

    expect(reviewChanges).not.toHaveBeenCalled()
  })

  it('引擎没连时不出声 —— 用户没要过这次检查', async () => {
    reviewChanges.mockResolvedValue({ ...clean, engineChecked: false })
    const wrapper = mountBubble([materialChange], 'typing')

    await finishTurn(wrapper)

    expect(wrapper.find('.response-review-summary').exists()).toBe(false)
  })

  it('查出编译报错时带上引擎原文，并给「交给 AI 修」', async () => {
    reviewChanges.mockResolvedValue({
      ...clean,
      findings: [
        {
          target: '/Game/A/M_Wood',
          code: 'compile-error',
          severity: 'error',
          detail: 'Accessed None'
        }
      ]
    })
    const wrapper = mountBubble([materialChange], 'typing')

    await finishTurn(wrapper)

    expect(wrapper.find('.response-review-item').text()).toContain('Accessed None')
    const buttons = wrapper.findAll('.response-review-run')
    expect(buttons).toHaveLength(2)

    await buttons[1].trigger('click')
    const actions = wrapper.emitted('action') ?? []
    expect(actions).toHaveLength(1)
    expect(actions[0][0]).toMatchObject({ action: REVIEW_FIX_ACTION })
    // 点过就收起，回复在下面
    expect(wrapper.findAll('.response-review-run')).toHaveLength(1)
  })

  it('只有未保存这类小问题时不给修的入口', async () => {
    reviewChanges.mockResolvedValue({
      ...clean,
      findings: [{ target: '/Game/A/M_Wood', code: 'unsaved', severity: 'warning' }]
    })
    const wrapper = mountBubble([materialChange], 'typing')

    await finishTurn(wrapper)

    expect(wrapper.findAll('.response-review-run')).toHaveLength(1)
  })
})
