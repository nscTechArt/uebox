import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApprovalGate } from '../../core/approval'

/**
 * 浏览器工具层。
 *
 * Service 那一层（窗口、CDP、页面脚本）在 `services/agentBrowser` 自己的测试里，
 * 这里锁的是工具契约：风险等级、逐次审批标记、参数校验，以及错误码有没有原样
 * 传给模型 —— 模型是照着错误码决定下一步的。
 */

const service = {
  open: vi.fn(),
  groupState: vi.fn(() => ({ tabs: [], activeTabId: null })),
  selectTab: vi.fn(),
  readContent: vi.fn(),
  readInteractive: vi.fn(),
  navigate: vi.fn(),
  interact: vi.fn(),
  screenshot: vi.fn(),
  close: vi.fn(),
  hasWindow: vi.fn()
}

class FakeBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

vi.mock('../../../services/agentBrowser', () => ({
  getSessionBrowser: vi.fn(() => service),
  AgentBrowserError: FakeBrowserError
}))

const { createBrowserTools } = await import('./browser')
const { BROWSER_TOOL_NAMES } = await import('../toolNames')

const OVERVIEW = {
  title: 'Electron 文档',
  url: 'https://www.electronjs.org/',
  snapshot: '[ref=1] link "快速开始"',
  hasIframe: false
}

function toolNamed(name: string): ReturnType<typeof createBrowserTools>[number] {
  const tool = createBrowserTools().find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`没有这个工具：${name}`)
  return tool
}

function run(name: string, args: unknown): Promise<unknown> {
  return toolNamed(name).execute(`call-${name}`, args)
}

beforeEach(() => {
  vi.clearAllMocks()
  service.open.mockResolvedValue(OVERVIEW)
  service.readInteractive.mockResolvedValue(OVERVIEW)
  service.navigate.mockResolvedValue(OVERVIEW)
  service.interact.mockResolvedValue({ overview: OVERVIEW, label: '下一页' })
  service.hasWindow.mockReturnValue(true)
})

describe('工具契约', () => {
  it('六个工具，名字与零依赖清单一致', () => {
    expect(
      createBrowserTools()
        .map((tool) => tool.name)
        .sort()
    ).toEqual([...BROWSER_TOOL_NAMES].sort())
  })

  /**
   * 只有「动页面」那一步要审批。
   *
   * 打开网页不拦：拦它也拦不住什么 —— `browser_navigate` 的跟随链接本来就不
   * 需要审批，恶意页面放个链接就能把浏览器带到任何地方。那道门只挡正常使用。
   */
  it('只有 interact 逐次审批，打开网页和读取都不打扰用户', () => {
    const meta = Object.fromEntries(createBrowserTools().map((tool) => [tool.name, tool.unrealBox]))

    expect(meta.browser_interact.risk).toBe('mutating')
    expect(meta.browser_interact.requiresExplicitApproval).toBe(true)

    for (const name of [
      'browser_open',
      'browser_read',
      'browser_navigate',
      'browser_screenshot',
      'browser_close'
    ]) {
      expect(meta[name].risk, name).toBe('safe')
      expect(meta[name].requiresExplicitApproval, name).toBeUndefined()
    }
  })

  it('全部声明 sequential —— 一个窗口经不起两个调用同时改', () => {
    for (const tool of createBrowserTools()) {
      expect((tool as unknown as { executionMode: string }).executionMode).toBe('sequential')
    }
  })

  it('描述里写明网页内容不可信', () => {
    expect(toolNamed('browser_open').description).toContain('不可信')
  })
})

describe('browser_open', () => {
  it('把网址交给 Service，并回传快照', async () => {
    const result = (await run('browser_open', { url: 'https://www.electronjs.org/' })) as {
      content: Array<{ text?: string }>
    }

    expect(service.open).toHaveBeenCalledWith('https://www.electronjs.org/', {
      resetSession: false,
      newTab: true
    })
    expect(result.content[0].text).toContain('快速开始')
  })

  it('resetSession 透传 —— 这是唯一的登录态清理入口', async () => {
    await run('browser_open', { url: 'https://example.com/', resetSession: true })

    expect(service.open).toHaveBeenCalledWith('https://example.com/', {
      resetSession: true,
      newTab: true
    })
  })

  it('Service 拒绝时把错误码原样带给模型', async () => {
    service.open.mockRejectedValue(
      new FakeBrowserError('NAVIGATION_BLOCKED', '不允许访问本机或内网地址：localhost')
    )

    await expect(run('browser_open', { url: 'http://localhost:5173/' })).rejects.toThrow(
      '[NAVIGATION_BLOCKED]'
    )
  })
})

describe('browser_read', () => {
  it('正文分页：读不完时给出下一段的位置', async () => {
    service.readContent.mockResolvedValue({
      title: 'A',
      url: 'https://example.com/',
      content: '正文',
      offset: 0,
      nextOffset: 12_000,
      totalChars: 30_000
    })

    const result = (await run('browser_read', { mode: 'content' })) as {
      content: Array<{ text?: string }>
    }

    expect(service.readContent).toHaveBeenCalledWith({ offset: 0, maxChars: 12_000 })
    expect(result.content[0].text).toContain('offset=12000')
  })

  it('读完了就说读完了，不留一个假的 nextOffset', async () => {
    service.readContent.mockResolvedValue({
      title: 'A',
      url: 'https://example.com/',
      content: '正文',
      offset: 0,
      nextOffset: null,
      totalChars: 2
    })

    const result = (await run('browser_read', { mode: 'content' })) as {
      content: Array<{ text?: string }>
    }

    expect(result.content[0].text).toContain('已读完')
  })

  it('单次读取上限卡死在 12000，模型要不来更多', async () => {
    await expect(run('browser_read', { mode: 'content', maxChars: 100_000 })).rejects.toThrow()
  })
})

describe('browser_navigate', () => {
  it('follow 需要 ref', async () => {
    await expect(run('browser_navigate', { action: 'follow' })).rejects.toThrow('ref')
  })

  it('scroll 需要方向', async () => {
    await expect(run('browser_navigate', { action: 'scroll' })).rejects.toThrow('direction')
  })

  it('后退直接交给 Service', async () => {
    await run('browser_navigate', { action: 'back' })

    expect(service.navigate).toHaveBeenCalledWith({ action: 'back' })
  })
})

describe('browser_interact', () => {
  it.each(['click', 'type', 'select'] as const)(
    '完全访问下 %s 不弹确认，只读仍阻止交互',
    async (action) => {
      const request = vi.fn()
      let readOnly = false
      const gate = createApprovalGate({
        sessionId: 'browser-full-access',
        mode: 'yolo',
        isReadOnly: () => readOnly,
        lookup: toolNamed,
        request
      })
      const context = {
        toolCall: { id: 'browser-call', name: 'browser_interact' },
        args: { action, ref: 13, label: 'Advanced', value: 'test' }
      } as Parameters<typeof gate>[0]

      expect(await gate(context)).toBeUndefined()
      readOnly = true
      expect(await gate(context)).toMatchObject({ block: true })
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('点击带上 label，供 Service 核对操作的确实是那个元素', async () => {
    await run('browser_interact', { action: 'click', ref: 3, label: '下一页' })

    expect(service.interact).toHaveBeenCalledWith({ action: 'click', ref: 3, label: '下一页' })
  })

  it('输入必须给 value', async () => {
    await expect(
      run('browser_interact', { action: 'type', ref: 1, label: '搜索' })
    ).rejects.toThrow('value')
  })

  it('label 是必填 —— 少了它就没法核对，等于闭着眼点', async () => {
    await expect(run('browser_interact', { action: 'click', ref: 1 })).rejects.toThrow()
  })

  it('敏感字段的拒绝原样带给模型', async () => {
    service.interact.mockRejectedValue(
      new FakeBrowserError('SENSITIVE_FIELD', '这是密码字段，请让用户自己填写。')
    )

    await expect(
      run('browser_interact', { action: 'type', ref: 2, label: '密码', value: 'x' })
    ).rejects.toThrow('[SENSITIVE_FIELD]')
  })

  it('返回值里不回显输入内容', async () => {
    service.interact.mockResolvedValue({ overview: OVERVIEW, label: '搜索' })

    const result = (await run('browser_interact', {
      action: 'type',
      ref: 2,
      label: '搜索',
      value: '虚幻引擎 材质'
    })) as { content: Array<{ text?: string }> }

    expect(result.content[0].text).not.toContain('虚幻引擎 材质')
  })
})

describe('browser_screenshot', () => {
  it('图片进上下文，且是压缩过的 JPEG', async () => {
    service.screenshot.mockResolvedValue({
      data: Buffer.from('fake'),
      mimeType: 'image/jpeg',
      bytes: 4
    })

    const result = (await run('browser_screenshot', {})) as {
      content: Array<{ type: string; mimeType?: string }>
    }

    expect(result.content.some((part) => part.type === 'image')).toBe(true)
    expect(result.content.find((part) => part.type === 'image')?.mimeType).toBe('image/jpeg')
  })

  it('压不下去时不发图，理由交给模型', async () => {
    service.screenshot.mockRejectedValue(
      new FakeBrowserError('SCREENSHOT_TOO_LARGE', '这张截图压缩后仍然太大')
    )

    await expect(run('browser_screenshot', {})).rejects.toThrow('[SCREENSHOT_TOO_LARGE]')
  })
})

describe('browser_close', () => {
  it('关掉窗口，并说清登录态还在', async () => {
    const result = (await run('browser_close', {})) as { content: Array<{ text?: string }> }

    expect(service.close).toHaveBeenCalledTimes(1)
    expect(result.content[0].text).toContain('登录态保留')
  })

  /** 没开着还报错的话，模型会以为自己漏了一步，然后去开一个窗口再关掉 */
  it('本来就没开着不算失败', async () => {
    service.hasWindow.mockReturnValue(false)

    const result = (await run('browser_close', {})) as { content: Array<{ text?: string }> }

    expect(result.content[0].text).toContain('本来就没有打开')
  })
})

it('按 Agent 会话 ID 绑定整组浏览器工具', async () => {
  const { getSessionBrowser } = await import('../../../services/agentBrowser')
  createBrowserTools('session-a')
  createBrowserTools('session-b')
  expect(getSessionBrowser).toHaveBeenCalledWith('session-a')
  expect(getSessionBrowser).toHaveBeenCalledWith('session-b')
})

it('Agent 可以列出和切换自己的 Tab，并显式复用当前 Tab', async () => {
  await run('browser_read', { mode: 'tabs' })
  expect(service.groupState).toHaveBeenCalled()
  await run('browser_navigate', { action: 'select', tabId: 'one' })
  expect(service.selectTab).toHaveBeenCalledWith('one')
  await expect(run('browser_navigate', { action: 'select' })).rejects.toThrow()
  await run('browser_open', { url: 'https://example.com/', newTab: false })
  expect(service.open).toHaveBeenLastCalledWith('https://example.com/', {
    resetSession: false,
    newTab: false
  })
})
