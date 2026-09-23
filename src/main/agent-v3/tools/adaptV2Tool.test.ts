import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { adaptV2Tool, describeV2Failure } from './adaptV2Tool'
/**
 * 编译失败时引擎会逐条给出「哪个节点、哪个引脚、什么错」，
 * 插件源码里那段的注释写着「用于 Agent 自修复」。
 * 这些以前停在工具的返回值里，没有并进给模型的错误正文 ——
 * 模型只看到一句 "No response or ok=false"，除了原样重试无路可走，
 * 重试两次就撞熔断。整条「连线 → 编译 → 修错」的闭环断在这里。
 */
describe('describeV2Failure 的 diagnostics', () => {
  const diagnostics = [
    {
      type: 'Error',
      message: 'Branch 的 Condition 引脚未连接',
      node_id: 'ABC-123',
      pin: 'Condition'
    },
    { type: 'Warning', message: '变量 bIsOpen 从未被读取' }
  ]

  it('把每条诊断连同 node_id / pin 一起给模型', () => {
    const text = describeV2Failure(
      { success: false, error: '蓝图编译未通过', diagnostics },
      'blueprint_compile'
    )

    expect(text).toContain('Branch 的 Condition 引脚未连接')
    expect(text).toContain('ABC-123')
    expect(text).toContain('Condition')
    expect(text).toContain('变量 bIsOpen 从未被读取')
  })

  it('没有 diagnostics 时不留空章节', () => {
    expect(describeV2Failure({ success: false, error: '炸了' }, 't')).not.toContain('诊断')
    expect(
      describeV2Failure({ success: false, error: '炸了', diagnostics: [] }, 't')
    ).not.toContain('诊断')
  })

  // 一个连错的图能刷出几十条同源报错，全塞进去会挤爆上下文；
  // 模型修完第一条重新编译就会拿到新的清单
  it('超过上限时截断并说明还剩多少条', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ type: 'Error', message: `错误 ${i}` }))
    const text = describeV2Failure({ success: false, error: 'x', diagnostics: many }, 't')

    expect(text).toContain('错误 0')
    expect(text).not.toContain('错误 20')
    expect(text).toContain('另有 15 条')
  })

  it('诊断项缺字段时不印 undefined', () => {
    const text = describeV2Failure(
      { success: false, error: 'x', diagnostics: [{ message: '只有消息' }] },
      't'
    )
    expect(text).toContain('只有消息')
    expect(text).not.toContain('undefined')
  })

  // 非数组的 diagnostics 是坏数据，不该把整个错误信息一起带崩
  it('diagnostics 不是数组时安全跳过', () => {
    expect(() =>
      describeV2Failure({ success: false, error: 'x', diagnostics: 'oops' }, 't')
    ).not.toThrow()
  })
})

/**
 * 截图 / 预览类工具把 base64 图片放在返回值的 `images` 里。
 * 那是**图片通道**，一旦漏进文本或 details 就要付两笔账：
 * 文本那笔是模型的 token（一张图 24 万个 base64 字符），
 * details 那笔是 localStorage 配额（它随聊天记录写进磁盘，几 MB 就满）。
 */
describe('适配层怎么处理返回值里的 images', () => {
  /** 冒充一张压缩过的截图；长度不重要，能被搜出来就行 */
  const BASE64 = 'ZmFrZS1qcGVn'.repeat(50)

  function screenshotTool(): ReturnType<typeof adaptV2Tool> {
    return adaptV2Tool(
      {
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({
          ok: true,
          screenshot_path: 'I:/UE/Saved/Screenshots/UAL/WBP_Battery.png',
          width: 1920,
          height: 1080,
          images: [{ data: BASE64, mimeType: 'image/jpeg' }],
          message: 'Widget 预览已渲染（1920x1080）'
        })
      },
      { name: 'widget_preview', namespace: 'ue.widget', risk: 'safe' }
    )
  }

  async function run(): Promise<{ content: unknown[]; details: unknown }> {
    const result = await screenshotTool().execute('call-1', { path: '/Game/UI/WBP_Battery' })
    return result as { content: unknown[]; details: unknown }
  }

  it('图片只走图片块，不跟着 JSON 混进文本', async () => {
    const { content } = await run()
    const text = content.find((b) => (b as { type: string }).type === 'text') as { text: string }

    expect(text.text).not.toContain(BASE64)
    // 正文该有的东西一样不少
    expect(text.text).toContain('WBP_Battery.png')
    expect(text.text).toContain('Widget 预览已渲染')
  })

  it('模型仍然看得到图', async () => {
    const { content } = await run()
    const image = content.find((b) => (b as { type: string }).type === 'image') as {
      data: string
      mimeType: string
    }

    expect(image.data).toBe(BASE64)
    expect(image.mimeType).toBe('image/jpeg')
  })

  it('details 不带 base64 —— 它会随聊天记录写进 localStorage', async () => {
    const { details } = await run()

    expect(JSON.stringify(details)).not.toContain(BASE64)
    // 但路径要留着：界面靠它读盘显示原图
    expect((details as { screenshot_path: string }).screenshot_path).toContain('WBP_Battery.png')
  })

  it('没有 images 的普通工具原样通过', async () => {
    const tool = adaptV2Tool(
      {
        inputSchema: z.object({}),
        execute: async () => ({ ok: true, count: 3 })
      },
      { name: 'ue_list', namespace: 'ue.actor', risk: 'safe' }
    )

    const result = (await tool.execute('call-1', {})) as { details: unknown }
    expect(result.details).toEqual({ ok: true, count: 3 })
  })
})

/**
 * 适配层原来两件事都没做：signal 既没往下传，也没和工具赛跑，直接 await
 * 存量实现跑完。于是用户按下停止，界面要僵到这次调用自己结束 ——
 * `ue_screenshot` 带界面截图那条路最长将近 40 秒。
 */
describe('停止不必等工具跑完', () => {
  it('工具不理会中止信号时，execute 照样当场返回', async () => {
    const controller = new AbortController()
    const tool = adaptV2Tool(
      {
        inputSchema: z.object({}),
        execute: () => new Promise(() => {})
      },
      { name: 'ue_screenshot', namespace: 'ue.editor', risk: 'safe' }
    )

    const pending = tool.execute('call-1', {}, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(/ue_screenshot/)
  })

  it('把信号递给 V2 工具，肯接的能把活也停了', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const tool = adaptV2Tool(
      {
        inputSchema: z.object({}),
        execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) => {
          received = options.abortSignal
          return { success: true }
        }
      },
      { name: 'ue_save', namespace: 'ue.editor', risk: 'safe' }
    )

    await tool.execute('call-1', {}, controller.signal)
    expect(received).toBe(controller.signal)
  })
})

/**
 * 审批门读的是 `unrealBox.riskFor`，V2 工具把它写在自己身上 —— 适配这一步
 * 漏抄，预演就又按最坏情况问，「本次会话都允许」也又记回光秃秃的工具名。
 */
describe('riskFor 跟着适配过去', () => {
  it('V2 工具声明的 riskFor 原样落到 unrealBox 上', () => {
    const riskFor = (args: unknown): 'safe' | 'destructive' =>
      (args as { dry_run?: unknown } | null)?.dry_run === true ? 'safe' : 'destructive'
    const tool = adaptV2Tool(
      { inputSchema: z.object({}), execute: async () => ({ success: true }), riskFor },
      { name: 'ue_fixup_redirectors', namespace: 'ue.content', risk: 'destructive' }
    )
    expect(tool.unrealBox.riskFor?.({ dry_run: true })).toBe('safe')
    expect(tool.unrealBox.riskFor?.({})).toBe('destructive')
  })

  it('没声明就不挂', () => {
    const tool = adaptV2Tool(
      { inputSchema: z.object({}), execute: async () => ({ success: true }) },
      { name: 'ue_save', namespace: 'ue.editor', risk: 'safe' }
    )
    expect(tool.unrealBox.riskFor).toBeUndefined()
  })
})
