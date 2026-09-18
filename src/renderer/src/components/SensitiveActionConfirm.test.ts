/**
 * 「这是什么？」那条解释请求。
 *
 * 盯的是两件容易悄悄坏掉的事：
 *
 * 1. **不许绑厂商**。这里原来写着 `provider: 'qwen', model: 'qwen-turbo'`。那两个
 *    参数其实早就被 `aiAPI` 丢掉了（它只转发 role），所以坏的不是行为、是**读代码
 *    的人**：谁看了都会以为社区版这条路绑死在某一家，改的时候照着抄。
 * 2. **换卡片要真的掐断**。审批是队列，答完一条马上弹下一条。上一版只是清空了
 *    `aiExplanation`，可请求还在流，它的增量会接着往里写 —— 用户看到的是「新卡片上
 *    挂着上一条的解释」，而那条解释描述的是他刚刚已经批准或拒绝掉的操作。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SensitiveActionConfirm from './SensitiveActionConfirm.vue'
import { provideApprovalDock } from './useApprovalDock'
import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'

const aiMocks = vi.hoisted(() => ({ chatText: vi.fn() }))

vi.mock('@renderer/api/ai', async () => {
  // ChatAbortedError 要用真的：组件靠 `instanceof` 把「用户切走了」和「模型出错」
  // 分开，换成假的就永远走错误分支
  const actual = await vi.importActual<typeof import('@renderer/api/ai')>('@renderer/api/ai')
  return {
    ChatAbortedError: actual.ChatAbortedError,
    aiAPI: { chatText: aiMocks.chatText }
  }
})

vi.mock('@renderer/services/notebook/contextBudget', () => ({
  getModelLimits: vi.fn(async () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }))
}))

vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: { replyApproval: vi.fn() }
}))

/** 队列里放一条待审批。组件只是它的视图，没有这一条就整个不渲染 */
function enqueue(toolCallId: string): void {
  usePendingApprovalsStore().enqueue({
    sessionId: 's1',
    toolCallId,
    toolName: 'delete_asset',
    namespace: 'asset',
    risk: 'destructive',
    args: { path: '/Game/Foo' },
    allowAlways: true
  })
}

/**
 * 卡片内容 `<Teleport>` 到停靠位（或 body）—— 不打掉 Teleport，
 * `wrapper.find` 在自己的子树里什么都找不到。
 */
function mountConfirm(): ReturnType<typeof mount> {
  return track(mount(SensitiveActionConfirm, { global: { stubs: { teleport: true } } }))
}

/**
 * 挂过的组件都要卸掉，一个不能留。
 *
 * 不卸的话它那个 Teleport 还活着：下一个用例摘掉停靠位时，上一个实例会把
 * 自己的卡片补到 `body` 上 ——「落点」那几条断言照样过，但过的是别人的卡片。
 */
const mounted: ReturnType<typeof mount>[] = []

function track(wrapper: ReturnType<typeof mount>): ReturnType<typeof mount> {
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.innerHTML = ''
})

type ChatTextParams = Parameters<typeof import('@renderer/api/ai').aiAPI.chatText>[0]

function lastCall(): ChatTextParams {
  return aiMocks.chatText.mock.calls.at(-1)![0] as ChatTextParams
}

describe('SensitiveActionConfirm 的 AI 解释', () => {
  beforeEach(() => {
    aiMocks.chatText.mockReset()
    aiMocks.chatText.mockResolvedValue('这一步会删掉一个资产。')
  })

  it('走用户配置的轻量档模型，不带任何厂商/模型参数', async () => {
    enqueue('call-1')
    const wrapper = mountConfirm()

    await wrapper.find('.btn-explain').trigger('click')
    await flushPromises()

    expect(aiMocks.chatText).toHaveBeenCalledTimes(1)
    const request = lastCall()

    // 社区版不绑厂商：这两个键**存在**就是回归，哪怕值是对的
    expect(request).not.toHaveProperty('provider')
    expect(request).not.toHaveProperty('model')

    expect(request.level).toBe('fast')
    expect(request.callType).toBe('sensitive-action-explain')
    // 钳进模型上限之后仍是 256（8192 的模型钳不动它）
    expect(request.maxTokens).toBe(256)
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0].role).toBe('system')
  })

  it('增量到达时边出边显示', async () => {
    aiMocks.chatText.mockImplementation(async (params: ChatTextParams) => {
      params.onDelta?.('先出一半', '先出一半')
      return '先出一半，再出后半'
    })

    enqueue('call-1')
    const wrapper = mountConfirm()

    await wrapper.find('.btn-explain').trigger('click')
    await flushPromises()

    expect(wrapper.find('.ai-explanation').text()).toBe('先出一半')
  })

  it('换到下一条待审批时掐断上一条的请求，且不显示为错误', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let seen: AbortSignal | undefined
      const { ChatAbortedError } = await import('@renderer/api/ai')
      aiMocks.chatText.mockImplementation(async (params: ChatTextParams) => {
        seen = params.signal
        // 真实 chatText 的行为：中止时抛 ChatAbortedError，不是 resolve
        await new Promise<void>((resolve) =>
          params.signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        throw new ChatAbortedError()
      })

      enqueue('call-1')
      const wrapper = mountConfirm()
      await wrapper.find('.btn-explain').trigger('click')
      await flushPromises()
      expect(seen?.aborted).toBe(false)

      // 用户答了这一条，队列里换成下一条
      usePendingApprovalsStore().settle('call-1')
      enqueue('call-2')
      await flushPromises()

      expect(seen?.aborted).toBe(true)
      // 新卡片上不许留着上一条的解释，也不许留一句「获取失败」
      expect(wrapper.find('.ai-explanation').exists()).toBe(false)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('模型出错时给一句能看懂的兜底，不把异常抛给界面', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      aiMocks.chatText.mockRejectedValue(new Error('没有配置轻量任务模型'))

      enqueue('call-1')
      const wrapper = mountConfirm()
      await wrapper.find('.btn-explain').trigger('click')
      await flushPromises()

      expect(wrapper.find('.ai-explanation').text()).toContain('无法获取 AI 解释')
      // 转圈要停：不停的话按钮永远禁用，用户连重试都点不了
      expect(wrapper.find('.btn-explain').attributes('disabled')).toBeUndefined()
    } finally {
      errors.mockRestore()
    }
  })
})

/**
 * 卡片落在哪儿。
 *
 * 组件挂在 `MainLayout` 上（助手页没 keepAlive，挂那儿切页就没了），
 * 位置却要跟着对话走 —— 靠 `<Teleport>` 到助手页登记的停靠位解决。
 * 这里不打掉 Teleport：要测的正是它把内容送去了哪里。
 */
describe('SensitiveActionConfirm 的落点', () => {
  let setDock: ((el: unknown) => void) | null = null

  beforeEach(() => {
    aiMocks.chatText.mockReset()
    setDock = null
  })

  afterEach(() => {
    // 停靠位是模块级单例，不摘会漏进下一个用例
    setDock?.(null)
    usePendingApprovalsStore().settle('call-1')
  })

  function registerDock(): HTMLElement {
    const dockEl = document.createElement('div')
    dockEl.className = 'approval-dock'
    document.body.appendChild(dockEl)
    setDock = provideApprovalDock()
    setDock(dockEl)
    return dockEl
  }

  it('助手页登记了停靠位：顶在输入框上方，不是浮层', async () => {
    const dock = registerDock()
    enqueue('call-1')
    track(mount(SensitiveActionConfirm))
    await flushPromises()

    const cards = document.body.querySelectorAll('.sensitive-action-confirm')
    expect(cards).toHaveLength(1)
    expect(cards[0].parentElement).toBe(dock)
    // 在停靠位里就是普通内联卡片，不许再定位成浮层
    expect(cards[0].classList.contains('floating')).toBe(false)
  })

  it('没有停靠位：退回 body 上的浮层', async () => {
    enqueue('call-1')
    track(mount(SensitiveActionConfirm))
    await flushPromises()

    const cards = document.body.querySelectorAll('.sensitive-action-confirm')
    expect(cards).toHaveLength(1)
    expect(cards[0].parentElement).toBe(document.body)
    // `.floating` 带着 position: fixed —— 少了它，卡片就是 body 末尾一块谁都看不见的东西
    expect(cards[0].classList.contains('floating')).toBe(true)
  })

  it('停靠位撤掉（切走助手页）时改回浮层，不留在脱离文档的节点上', async () => {
    const dock = registerDock()
    enqueue('call-1')
    track(mount(SensitiveActionConfirm))
    await flushPromises()
    expect(dock.querySelector('.sensitive-action-confirm')).not.toBeNull()

    // 助手页卸载：Vue 会用 null 回调函数 ref
    setDock!(null)
    dock.remove()
    await flushPromises()

    const cards = document.body.querySelectorAll('.sensitive-action-confirm')
    expect(cards).toHaveLength(1)
    expect(cards[0].isConnected).toBe(true)
    expect(cards[0].classList.contains('floating')).toBe(true)
  })
})
