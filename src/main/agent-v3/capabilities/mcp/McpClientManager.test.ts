import { beforeEach, describe, expect, it, vi } from 'vitest'

// 压缩要拉 sharp 并真的解码图片，这里只关心「有没有压、压不动怎么办」
const compressForContext = vi.hoisted(() => vi.fn())
vi.mock('../../tools/contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tools/contextImage')>()),
  compressForContext
}))

import { namespaceFor, runMcpTool, toPiContent, toSafeToolName } from './McpClientManager'

describe('toSafeToolName', () => {
  // MCP server 可以起任意工具名，而厂商要求 ^[a-zA-Z0-9_-]{1,64}$。
  // 不清洗的话整个请求被拒，报错通常只说 "invalid tool name"，不指出是哪个。
  it('清洗掉非法字符', () => {
    expect(toSafeToolName('blender', 'render.scene')).toBe('mcp_blender_render_scene')
    expect(toSafeToolName('my server', 'do/thing')).toBe('mcp_my_server_do_thing')
  })

  it('保留合法字符', () => {
    expect(toSafeToolName('gh', 'create_issue')).toBe('mcp_gh_create_issue')
    expect(toSafeToolName('a-b', 'c-d')).toBe('mcp_a-b_c-d')
  })

  it('超长时截断到 64 —— 厂商上限', () => {
    const name = toSafeToolName('x'.repeat(40), 'y'.repeat(40))
    expect(name.length).toBe(64)
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('64 字符以内的名字原样保留 —— 不该无缘无故加后缀', () => {
    // 正好卡在上限：加后缀就说明边界算错了
    const exact = toSafeToolName('s', 'a'.repeat(58))
    expect(exact.length).toBe(64)
    expect(exact).toBe(`mcp_s_${'a'.repeat(58)}`)
  })

  // UE 5.8 官方 ModelContextProtocol 插件的真实工具名：整棵命名空间都写进名字里，
  // 前 64 个字符完全一样。老实现直接 slice(0, 64)，两个工具会注册成同一个名字 ——
  // 模型调到的是另一个工具，或者厂商直接以「重名」拒掉整份工具列表。
  it('共享超长前缀的两个工具不会撞成同一个名字', () => {
    const a = toSafeToolName(
      'ue',
      'toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.set_scalar_parameter'
    )
    const b = toSafeToolName(
      'ue',
      'toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.set_vector_parameter'
    )

    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(b).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    // 前缀仍然可读，模型靠它认出这是哪个 server 的哪类工具
    expect(a.startsWith('mcp_ue_toolset_registry')).toBe(true)
  })

  it('整个 server 的工具集里两两不重名', () => {
    const tools = [
      'toolset_registry.toolsets.core.actor.ActorTools.get_label',
      'toolset_registry.toolsets.core.actor.ActorTools.set_label',
      'toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.set_scalar_parameter',
      'toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.set_vector_parameter',
      'toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.get_scalar_parameter'
    ]
    const names = tools.map((t) => toSafeToolName('unreal_engine_editor', t))

    expect(new Set(names).size).toBe(tools.length)
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  // 清洗是多对一的：拿洗过的串做哈希等于把碰撞又放回来了
  it('只差被清洗字符的两个超长名字也不撞', () => {
    const tail = 'z'.repeat(70)
    expect(toSafeToolName('s', `a.b_${tail}`)).not.toBe(toSafeToolName('s', `a_b_${tail}`))
  })

  it('同样的输入永远给同样的名字 —— 名字要能跨会话稳定', () => {
    const long = 'q'.repeat(80)
    expect(toSafeToolName('srv', long)).toBe(toSafeToolName('srv', long))
  })

  it('产出的名字一定合法', () => {
    for (const [server, tool] of [
      ['中文服务', '工具名'],
      ['a.b.c', 'x:y:z'],
      ['s', '$$$']
    ]) {
      expect(toSafeToolName(server, tool)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })
})

describe('namespaceFor', () => {
  it('按 server 分命名空间，便于按来源过滤和展示', () => {
    expect(namespaceFor('blender')).toBe('mcp.blender')
  })
})

describe('toPiContent', () => {
  beforeEach(() => {
    compressForContext.mockReset()
    compressForContext.mockResolvedValue({ data: 'Y29tcHJlc3NlZA==', mimeType: 'image/jpeg' })
  })

  it('text 块直接透传', async () => {
    expect(await toPiContent([{ type: 'text', text: '结果' }])).toEqual([
      { type: 'text', text: '结果' }
    ])
  })

  /**
   * 原样转发是一次 413：第三方 server 返回多大的图不由我们决定，而 pi 每次
   * 请求都重发整条 transcript —— 一张几 MB 的 PNG 会把后续每一轮都打死。
   */
  it('image 块先压再进上下文，不原样转发', async () => {
    const out = await toPiContent([{ type: 'image', data: 'b3JpZ2luYWw=', mimeType: 'image/png' }])

    expect(compressForContext).toHaveBeenCalledWith(Buffer.from('b3JpZ2luYWw=', 'base64'))
    expect(out).toEqual([{ type: 'image', data: 'Y29tcHJlc3NlZA==', mimeType: 'image/jpeg' }])
  })

  // 悄悄发一张超大的图比不发更糟：模型不知道自己看的是什么，用户只看到一次失败
  it('压不动时降级成说明文本，而不是发原图', async () => {
    compressForContext.mockResolvedValue(null)

    const out = await toPiContent([{ type: 'image', data: 'aHVnZQ==', mimeType: 'image/png' }])

    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text')
    expect((out[0] as { text: string }).text).toContain('image/png')
  })

  it('resource 块降级成带 uri 的文本', async () => {
    const out = await toPiContent([
      { type: 'resource', resource: { uri: 'file:///a.txt', text: '内容' } }
    ])
    expect((out[0] as { text: string }).text).toContain('file:///a.txt')
    expect((out[0] as { text: string }).text).toContain('内容')
  })

  // 丢掉会让模型看到空结果，以为调用失败并重试
  it('audio 块降级成说明文本而不是丢弃', async () => {
    const out = await toPiContent([{ type: 'audio', data: 'x', mimeType: 'audio/wav' }])
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toContain('audio/wav')
  })

  it('多个块按顺序保留', async () => {
    const out = await toPiContent([
      { type: 'text', text: '一' },
      { type: 'image', data: 'ZA==', mimeType: 'image/png' },
      { type: 'text', text: '二' }
    ])
    expect(out.map((b) => b.type)).toEqual(['text', 'image', 'text'])
  })

  it('空内容补占位 —— pi 要求 content 非空', async () => {
    expect(await toPiContent([])).toEqual([{ type: 'text', text: '(无输出)' }])
  })

  it('全是无法转换的块时也不返回空数组', async () => {
    expect(await toPiContent([{ type: 'unknown-future-type' }])).toEqual([
      { type: 'text', text: '(无输出)' }
    ])
  })
})

describe('runMcpTool', () => {
  const bridgeDown = {
    isError: true,
    content: [
      {
        type: 'text',
        text: 'Cannot connect to Blender at 127.0.0.1:9876. Ensure Blender is running with the MCP addon enabled and the server started.'
      }
    ]
  }

  it('正常调用只调一次，结果转成 pi 的内容块', async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '好了' }] })

    expect(await runMcpTool('t', call)).toMatchObject({ content: [{ type: 'text', text: '好了' }] })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('桥断了：先拉起 Blender，再把这次调用重跑一遍', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(bridgeDown)
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '倒角完成' }] })
    const ensure = vi.fn().mockResolvedValue({ ok: true, launched: true })

    const result = await runMcpTool('mcp_blender_execute_blender_code', call, ensure)

    expect(call).toHaveBeenCalledTimes(2)
    // 自动启动过要说一声，否则用户看不出这中间发生了什么
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('自动启动')
    })
    expect(result.content).toContainEqual({ type: 'text', text: '倒角完成' })
  })

  it('端口本来就通（别的调用刚拉起来）就不重复报自动启动', async () => {
    const call = vi.fn().mockResolvedValueOnce(bridgeDown).mockResolvedValueOnce({ content: [] })
    const ensure = vi.fn().mockResolvedValue({ ok: true, launched: false })

    const result = await runMcpTool('t', call, ensure)
    expect(result.content).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('自动启动') })
    )
  })

  it('拉不起来时把原因一起抛出去 —— 模型要拿它决定下一步', async () => {
    const call = vi.fn().mockResolvedValue(bridgeDown)
    const ensure = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'Blender 已经在运行，但桥没起。请点 Start Server' })

    await expect(runMcpTool('t', call, ensure)).rejects.toThrow(/Start Server/)
    // 失败就不该再打一次
    expect(call).toHaveBeenCalledTimes(1)
  })

  // 重试的前提是「代码没送到 Blender」。超时不满足这个前提，
  // 重跑一次几何修改就等于做了两遍
  it('超时不触发重试', async () => {
    const call = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Blender connection timed out at 127.0.0.1:9876' }]
    })
    const ensure = vi.fn()

    await expect(runMcpTool('t', call, ensure)).rejects.toThrow(/timed out/)
    expect(ensure).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  /**
   * 桥断了、又没挂上自动拉起 —— 只可能是配置里没写 `BLENDER_PATH`
   * （别的 server 报不出插件这两句话，走不到这个分支）。
   *
   * 真机上这一环最难查：设置面板显示「已连接」，技能文档写着「盒子会自动启动
   * Blender」，然后什么都没发生，报出来只有一句 Cannot connect。
   * 「那段代码根本没挂上」从外面完全看不出来，所以必须由这里说出口。
   */
  it('缺 BLENDER_PATH 时明说自动启动为什么没发生', async () => {
    const call = vi.fn().mockResolvedValue(bridgeDown)

    await expect(runMcpTool('t', call)).rejects.toThrow(/BLENDER_PATH/)
    await expect(runMcpTool('t', call)).rejects.toThrow(/Cannot connect to Blender/)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('普通 server 的报错不被当成 Blender 处理', async () => {
    const call = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'ENOENT: no such file' }]
    })

    const error = await runMcpTool('t', call).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/ENOENT/)
    expect((error as Error).message).not.toMatch(/BLENDER_PATH/)
  })

  it('重试后仍然失败就照常抛错，不会无限重试', async () => {
    const call = vi.fn().mockResolvedValue(bridgeDown)
    const ensure = vi.fn().mockResolvedValue({ ok: true, launched: true })

    await expect(runMcpTool('t', call, ensure)).rejects.toThrow(/Cannot connect to Blender/)
    expect(call).toHaveBeenCalledTimes(2)
    expect(ensure).toHaveBeenCalledTimes(1)
  })
})
