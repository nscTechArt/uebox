import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineTool, effectiveRisk, toToolSchema, type UnrealAgentTool } from './defineTool'

describe('toToolSchema', () => {
  it('把 Zod schema 转成 JSON Schema', () => {
    const schema = toToolSchema(
      z.object({
        name: z.string().describe('材质名'),
        count: z.number().int().optional()
      })
    ) as {
      type?: string
      properties?: Record<string, { description?: string }>
      required?: string[]
    }

    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties ?? {})).toEqual(['name', 'count'])
    expect(schema.properties?.name.description).toBe('材质名')
    // optional 字段不能进 required，否则模型会以为必填
    expect(schema.required).toEqual(['name'])
  })

  it('带 default 的字段在输入侧是可选的', () => {
    // io:'input' 的关键作用。取输出侧会把 default 字段标成必填，
    // 模型于是每次都得填一遍本可以省略的参数。
    const schema = toToolSchema(
      z.object({
        path: z.string(),
        force: z.boolean().optional().default(false)
      })
    ) as { required?: string[] }

    expect(schema.required).toEqual(['path'])
  })
})

describe('defineTool', () => {
  const makeTool = (
    execute: Parameters<
      typeof defineTool<z.ZodObject<{ name: z.ZodString }>, unknown>
    >[0]['execute']
  ): UnrealAgentTool<unknown> =>
    defineTool({
      name: 'demo',
      namespace: 'test',
      description: 'demo tool',
      input: z.object({ name: z.string() }),
      execute
    })

  it('把 ToolOutcome 转成 pi 的 AgentToolResult', async () => {
    const tool = makeTool(async (args) => ({
      text: `hello ${args.name}`,
      details: { echoed: args.name }
    }))

    const result = await tool.execute('call-1', { name: 'M_Test' })

    expect(result.content).toEqual([{ type: 'text', text: 'hello M_Test' }])
    expect(result.details).toEqual({ echoed: 'M_Test' })
  })

  it('图片进 content —— 取代 V2 的回灌 hack', async () => {
    const tool = makeTool(async () => ({
      text: '视口截图',
      images: [{ data: Buffer.from('fake-png'), mimeType: 'image/png' }]
    }))

    const result = await tool.execute('call-1', { name: 'x' })

    expect(result.content).toHaveLength(2)
    expect(result.content[1]).toEqual({
      type: 'image',
      data: Buffer.from('fake-png').toString('base64'),
      mimeType: 'image/png'
    })
  })

  it('只返 details 时补占位文本（pi 要求 content 非空）', async () => {
    const tool = makeTool(async () => ({ details: { rows: 3 } }))
    const result = await tool.execute('call-1', { name: 'x' })

    expect(result.content).toEqual([{ type: 'text', text: '(无文本输出)' }])
    expect(result.details).toEqual({ rows: 3 })
  })

  // pi 判定工具失败的**唯一**依据是 execute 抛异常（agent-loop.js 成功路径里
  // isError 硬编码为 false，AgentToolResult 上也没有 isError 字段）。
  // 在这里吞掉异常返回一个结果，会让失败被当成成功报给模型。
  it('execute 的异常原样抛出，交给 pi 标记 isError', async () => {
    const tool = makeTool(async () => {
      throw new Error('引擎没连上')
    })

    await expect(tool.execute('call-1', { name: 'x' })).rejects.toThrow('引擎没连上')
  })

  it('outcome.isError 也转成异常，而不是返回一个"看起来成功"的结果', async () => {
    const tool = makeTool(async () => ({ text: '路径不存在', isError: true }))

    await expect(tool.execute('call-1', { name: 'x' })).rejects.toThrow('路径不存在')
  })

  it('参数校验失败同样抛出，不会静默传给业务逻辑', async () => {
    const tool = makeTool(async () => ({ text: 'ok' }))

    await expect(tool.execute('call-1', { name: 123 })).rejects.toThrow()
  })

  it('report() 把局部结果推给 onUpdate', async () => {
    const tool = makeTool(async (_args, ctx) => {
      ctx.report({ text: '进度 50%' })
      return { text: '完成' }
    })

    const onUpdate = vi.fn()
    const result = await tool.execute('call-1', { name: 'x' }, undefined, onUpdate)

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].content).toEqual([{ type: 'text', text: '进度 50%' }])
    expect(result.content).toEqual([{ type: 'text', text: '完成' }])
  })

  it('带上 V3 元数据供注册表和审批门读取', () => {
    const tool = defineTool({
      name: 'danger',
      namespace: 'ue.material',
      description: 'x',
      input: z.object({}),
      risk: 'destructive',
      execute: async () => ({ text: 'ok' })
    })

    expect(tool.unrealBox).toEqual({ namespace: 'ue.material', risk: 'destructive' })
  })

  it('risk 缺省是 mutating —— 不声明的工具默认要审批', () => {
    const tool = defineTool({
      name: 'x',
      namespace: 'n',
      description: 'x',
      input: z.object({}),
      execute: async () => ({ text: 'ok' })
    })

    expect(tool.unrealBox.risk).toBe('mutating')
  })

  it('riskFor 跟着挂到 unrealBox 上，effectiveRisk 只降不升', () => {
    const tool = defineTool({
      name: 'move',
      namespace: 'ue.content',
      description: 'x',
      input: z.object({ dry_run: z.boolean().optional(), force: z.boolean().optional() }),
      risk: 'mutating',
      riskFor: (args) => (args.dry_run ? 'safe' : args.force ? 'destructive' : 'mutating'),
      execute: async () => ({ text: 'ok' })
    })

    expect(effectiveRisk(tool.unrealBox, { dry_run: true })).toBe('safe')
    expect(effectiveRisk(tool.unrealBox, {})).toBe('mutating')
    // 抬不上去：声明的 risk 就是最坏情况
    expect(effectiveRisk(tool.unrealBox, { force: true })).toBe('mutating')
    // 查不到元数据的按最危险算
    expect(effectiveRisk(undefined, {})).toBe('destructive')
    // riskFor 自己炸了（参数没配上，是 undefined）就按声明的算，不往外抛
    expect(effectiveRisk(tool.unrealBox, undefined)).toBe('mutating')
  })

  /**
   * 用户按停止之后，pi 要等**这次 execute 返回**才看得见中止意图
   * （agent-loop.js：先 await tool.execute，再 `if (signal?.aborted) break`）。
   * 工具体里读 signal 的只有个位数，所以兜底放在这一层。
   */
  describe('停止不必等工具跑完', () => {
    it('工具不理会 signal 时，execute 照样当场返回', async () => {
      const controller = new AbortController()
      const tool = defineTool({
        name: 'ue_screenshot',
        namespace: 'ue.editor',
        description: 'x',
        input: z.object({}),
        // 存量工具的典型样子：拿到了 ctx 却不看 signal，一直等引擎
        execute: () => new Promise<never>(() => {})
      })

      const pending = tool.execute('call-1', {}, controller.signal)
      controller.abort()

      await expect(pending).rejects.toThrow(/ue_screenshot/)
    })

    it('工具正常跑完时不受影响', async () => {
      const controller = new AbortController()
      const tool = defineTool({
        name: 'ok',
        namespace: 'n',
        description: 'x',
        input: z.object({}),
        execute: async () => ({ text: '完成' })
      })

      const result = await tool.execute('call-1', {}, controller.signal)
      expect(result.content).toEqual([{ type: 'text', text: '完成' }])
    })
  })
})
