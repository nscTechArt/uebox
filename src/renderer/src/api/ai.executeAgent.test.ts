import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/common/http', () => ({
  default: {}
}))

vi.mock('@renderer/store/modules/aiConfig', () => ({
  useAIConfigStore: vi.fn(() => ({
    getEnabledOpenAICompatibleByok: vi.fn(() => undefined)
  }))
}))

vi.mock('../i18n', () => ({
  default: {
    global: {
      t: (key: string) => key
    }
  }
}))

import { aiAPI, resolveApprovalMode, toAgentV3Prompt } from './ai'

interface AgentV3Mock {
  execute: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function install(executeResult: unknown = { success: true }): {
  agentV3: AgentV3Mock
  rawInvoke: ReturnType<typeof vi.fn>
} {
  const agentV3: AgentV3Mock = {
    execute: vi.fn(async () => executeResult),
    stop: vi.fn(async () => ({ success: true }))
  }
  const rawInvoke = vi.fn()

  window.api = { agentV3 } as unknown as typeof window.api
  window.electron = {
    ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: rawInvoke }
  } as unknown as typeof window.electron

  return { agentV3, rawInvoke }
}

const PARAMS = {
  messages: [{ role: 'user' as const, content: '造一艘船' }],
  chatSid: 'chat-a',
  sessionId: 'session-a'
}

describe('aiAPI.executeAgent', () => {
  beforeEach(() => vi.clearAllMocks())

  /**
   * `agent-v3:execute` 不在 preload 的 `RAW_REQUEST_CHANNELS` 白名单里，
   * 直接 `ipcRenderer.invoke` 会被挡下（「Blocked invoke channel」）——
   * 聊天界面因此**完全用不了 V3**，一发消息就报这个错。
   *
   * 白名单挡的就是渲染层绕过封装直接摸原始通道，所以正确修法是走
   * `window.api.agentV3.*`，而不是把通道加进白名单。
   */
  it('走 window.api.agentV3 封装，不碰原始 IPC 通道', async () => {
    const { agentV3, rawInvoke } = install()

    await aiAPI.executeAgent(PARAMS, {})

    expect(agentV3.execute).toHaveBeenCalledTimes(1)
    expect(rawInvoke).not.toHaveBeenCalled()
  })

  it('按 V3 契约传参', async () => {
    const { agentV3 } = install()

    await aiAPI.executeAgent(PARAMS, {})

    expect(agentV3.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-a', prompt: '造一艘船', mode: 'agent' })
    )
  })

  it('Ask 模式翻译成 mode: ask', async () => {
    const { agentV3 } = install()

    await aiAPI.executeAgent({ ...PARAMS, askMode: true }, {})

    expect(agentV3.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ask' }))
  })

  /**
   * 会话归属的工程只有渲染层知道（戳在会话列表里），主进程手上只有「谁连着」。
   * 这一条断在**必须带下去**：漏了的话，挂在 test222 下的会话问「这是啥项目」，
   * 模型会照着当前连接答成另一个工程 —— 而且不会有任何报错。
   */
  it('把会话归属的工程带给主进程', async () => {
    const { agentV3 } = install()
    const sessionProject = { projectName: 'test222', projectPath: 'H:/UE/test222' }

    await aiAPI.executeAgent({ ...PARAMS, sessionProject }, {})

    expect(agentV3.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionProject }))
  })

  // 「纯会话」（没盖过工程戳）是常态，要显式传 null 而不是漏掉这个字段
  it('会话没有归属工程时传 null', async () => {
    const { agentV3 } = install()

    await aiAPI.executeAgent(PARAMS, {})

    expect(agentV3.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionProject: null }))
  })

  describe('审批模式', () => {
    // 没带档位时用 auto-edit 而不是 ask：ask 会让每一步写操作都弹窗，没法用
    it('默认只对不可逆操作弹窗', async () => {
      const { agentV3 } = install()
      await aiAPI.executeAgent(PARAMS, {})
      expect(agentV3.execute).toHaveBeenCalledWith(
        expect.objectContaining({ approvalMode: 'auto-edit' })
      )
    })

    // 档位是这条会话自己的，调用方算好传进来，这一层原样送下去
    it.each(['ask', 'auto-edit', 'yolo'] as const)('界面选的 %s 原样传下去', async (mode) => {
      const { agentV3 } = install()
      await aiAPI.executeAgent({ ...PARAMS, approvalMode: mode }, {})
      expect(agentV3.execute).toHaveBeenCalledWith(expect.objectContaining({ approvalMode: mode }))
    })
  })

  /**
   * 「允许编辑器截图」那一档。
   *
   * 这个字段以前在这一层被**默默丢掉**：界面上的开关照样能关，主进程从头到尾
   * 没收到过，`ue_screenshot` 也就一直在工具池里。一个什么都不做的隐私开关
   * 比没有开关更糟 —— 用户以为自己关上了。
   */
  describe('编辑器截图权限', () => {
    it('关掉时带下去，主进程据此摘掉截图工具', async () => {
      const { agentV3 } = install()

      await aiAPI.executeAgent({ ...PARAMS, editorScreenshotEnabled: false }, {})

      expect(agentV3.execute).toHaveBeenCalledWith(
        expect.objectContaining({ editorScreenshotEnabled: false })
      )
    })

    // 兜底 true 要和 store 的 `?? true`、主进程的 EDITOR_SCREENSHOT_DEFAULT 一致：
    // 三层各写各的默认，用户一个开关都没动过就会看到两种行为
    it('调用方没给时按默认档（允许）传', async () => {
      const { agentV3 } = install()

      await aiAPI.executeAgent(PARAMS, {})

      expect(agentV3.execute).toHaveBeenCalledWith(
        expect.objectContaining({ editorScreenshotEnabled: true })
      )
    })
  })

  describe('resolveApprovalMode', () => {
    it('给了就用给的', () => {
      expect(resolveApprovalMode({ approvalMode: 'ask' })).toBe('ask')
      expect(resolveApprovalMode({ approvalMode: 'yolo' })).toBe('yolo')
    })

    // 没给 = 调用方漏传，走推荐档而不是最严或最松
    it('什么都没有时给 auto-edit', () => {
      expect(resolveApprovalMode({})).toBe('auto-edit')
    })
  })

  /**
   * 主进程把失败**编码在返回值里**（{ success: false, error }），不是抛异常。
   * 只挂 .catch 的话这里一声不吭，用户看到的就是「点了没反应」。
   */
  it('主进程返回 success:false 时报错，而不是静默', async () => {
    install({ success: false, error: '模型未配置' })

    const onError = vi.fn()
    await aiAPI.executeAgent(PARAMS, { onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith({ message: '模型未配置' }))
  })

  it('主进程没给原因时也要报，附带兜底文案', async () => {
    install({ success: false })

    const onError = vi.fn()
    await aiAPI.executeAgent(PARAMS, { onError })
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith({ message: expect.stringContaining('失败') })
    )
  })

  it('IPC 本身抛异常时同样报错', async () => {
    const { agentV3 } = install()
    agentV3.execute.mockRejectedValueOnce(new Error('IPC 断了'))

    const onError = vi.fn()
    await aiAPI.executeAgent(PARAMS, { onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
  })

  it('成功时不报错', async () => {
    install({ success: true })

    const onError = vi.fn()
    await aiAPI.executeAgent(PARAMS, { onError })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).not.toHaveBeenCalled()
  })

  it('stop() 也走封装', async () => {
    const { agentV3, rawInvoke } = install()

    const controller = await aiAPI.executeAgent(PARAMS, {})
    await controller.stop()

    expect(agentV3.stop).toHaveBeenCalledWith({ sessionId: 'session-a' })
    expect(rawInvoke).not.toHaveBeenCalled()
  })

  // 停止失败不该把调用方一起带崩 —— 用户按停止，最差也就是没停下来
  it('stop() 失败时不向上抛，但如实回一句「没停干净」', async () => {
    const { agentV3 } = install()
    agentV3.stop.mockRejectedValueOnce(new Error('没有正在执行的会话'))

    const controller = await aiAPI.executeAgent(PARAMS, {})
    await expect(controller.stop()).resolves.toBe(false)
  })

  /**
   * 停完接着重发一轮的调用方（编辑消息、重新生成）靠这个布尔判断能不能发。
   * 把「等超时了还没停」当成停下来了，新的一轮就会撞上还占着位置的旧会话，
   * 用户拿到的是一句「会话正在执行中」。
   */
  it('主进程说没排干净时，stop() 返回 false', async () => {
    const { agentV3 } = install()
    agentV3.stop.mockResolvedValueOnce({ success: true, drained: false })

    const controller = await aiAPI.executeAgent(PARAMS, {})
    await expect(controller.stop()).resolves.toBe(false)
  })

  it('主进程说停干净了，stop() 返回 true', async () => {
    const { agentV3 } = install()
    agentV3.stop.mockResolvedValueOnce({ success: true, drained: true })

    const controller = await aiAPI.executeAgent(PARAMS, {})
    await expect(controller.stop()).resolves.toBe(true)
  })
})

/**
 * V3 自己按 sessionId 恢复 transcript，所以历史不用再传一遍。
 * 但界面塞进 `messages` 的**临时上下文**（当前 UE 工程、笔记本 RAG 命中）
 * 是这一轮才有的新信息，丢了模型就看不到。
 */
describe('toAgentV3Prompt', () => {
  it('多条消息按顺序拼进 prompt —— 注入的上下文不能丢', () => {
    const { prompt } = toAgentV3Prompt({
      messages: [
        { role: 'system', content: '当前工程：MyGame' },
        { role: 'user', content: '这个工程里有什么材质' }
      ]
    })
    expect(prompt).toBe('当前工程：MyGame\n\n这个工程里有什么材质')
  })

  it('数组形态的内容也抽得出文本', () => {
    const { prompt } = toAgentV3Prompt({
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    })
    expect(prompt).toBe('你好')
  })

  it('空白消息不产生多余空行', () => {
    const { prompt } = toAgentV3Prompt({
      messages: [
        { role: 'system', content: '   ' },
        { role: 'user', content: '干活' }
      ]
    })
    expect(prompt).toBe('干活')
  })

  it('messages 为空时退回 prompt 字段', () => {
    expect(toAgentV3Prompt({ prompt: '直接给的' }).prompt).toBe('直接给的')
    expect(toAgentV3Prompt({ messages: [], prompt: '兜底' }).prompt).toBe('兜底')
  })

  it('什么都没有时给空串而不是崩', () => {
    expect(toAgentV3Prompt({})).toEqual({ prompt: '', images: [] })
  })

  describe('图片', () => {
    // 不单独抽出来的话 [object Object] 会被拼进正文，
    // 而用户在界面上看到图已经发出去了
    it('data URL 拆成 pi 要的 { data, mimeType }', () => {
      const { prompt, images } = toAgentV3Prompt({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看这张图' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } }
            ]
          }
        ]
      })

      expect(prompt).toBe('看这张图')
      expect(images).toEqual([{ type: 'image', data: 'AAAB', mimeType: 'image/png' }])
    })

    it('多张图都收', () => {
      const { images } = toAgentV3Prompt({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }
            ]
          }
        ]
      })
      expect(images.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg'])
    })

    // 外链没法内联，至少让模型知道有这么个东西，而不是静默消失
    it('非 data URL 退化成一行文本', () => {
      const { prompt, images } = toAgentV3Prompt({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://x.com/a.png' } }]
          }
        ]
      })
      expect(images).toEqual([])
      expect(prompt).toContain('https://x.com/a.png')
    })
  })
})
