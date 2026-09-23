import { describe, expect, it, vi } from 'vitest'

import {
  createApprovalGate,
  needsApproval,
  type ApprovalRequest,
  type ApprovalVerdict
} from './approval'
import type { ToolRisk, UnrealAgentTool } from '../tools/defineTool'

const tool = (risk: ToolRisk, requiresExplicitApproval = false): UnrealAgentTool<never> =>
  ({
    name: 't',
    unrealBox: { namespace: 'ue.material', risk, requiresExplicitApproval }
  }) as unknown as UnrealAgentTool<never>

const callCtx = (
  name = 't',
  args: unknown = {}
): Parameters<ReturnType<typeof createApprovalGate>>[0] =>
  ({
    toolCall: { id: 'c1', name },
    args,
    assistantMessage: {},
    context: {}
  }) as unknown as Parameters<ReturnType<typeof createApprovalGate>>[0]

describe('needsApproval', () => {
  it.each([
    ['safe', 'ask', false],
    ['safe', 'auto-edit', false],
    ['safe', 'yolo', false],
    ['mutating', 'ask', true],
    ['mutating', 'auto-edit', false],
    ['mutating', 'yolo', false],
    ['destructive', 'ask', true],
    // auto-edit 与 yolo 的区别就在这一格：不可逆操作仍然要问
    ['destructive', 'auto-edit', true],
    ['destructive', 'yolo', false]
  ] as const)('risk=%s mode=%s → %s', (risk, mode, expected) => {
    expect(needsApproval(risk, mode)).toBe(expected)
  })

  it.each(['ask', 'auto-edit'] as const)('逐次审批的工具在 %s 档也要问', (mode) => {
    expect(needsApproval('mutating', mode, true)).toBe(true)
    expect(needsApproval('safe', mode, true)).toBe(true)
  })

  it.each(['safe', 'mutating', 'destructive'] as const)('完全访问放行逐次审批工具：%s', (risk) => {
    expect(needsApproval(risk, 'yolo', true)).toBe(false)
  })
})

describe('createApprovalGate', () => {
  const gate = (
    risk: ToolRisk,
    verdict: ApprovalVerdict,
    mode: 'ask' | 'auto-edit' | 'yolo' = 'ask'
  ): {
    request: ReturnType<typeof vi.fn>
    run: ReturnType<typeof createApprovalGate>
  } => {
    const request = vi.fn(async () => verdict)
    return {
      request,
      run: createApprovalGate({
        sessionId: 's',
        mode,
        lookup: () => tool(risk),
        request
      })
    }
  }

  it('只读工具不打扰用户', async () => {
    const { request, run } = gate('safe', 'approve')
    expect(await run(callCtx())).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('批准后放行', async () => {
    const { run } = gate('mutating', 'approve')
    expect(await run(callCtx())).toBeUndefined()
  })

  it('拒绝时返回 block，且提示写给模型而不是用户', async () => {
    const { run } = gate('destructive', 'reject')
    const result = await run(callCtx())

    expect(result?.block).toBe(true)
    // 关键：必须明确告诉模型别重试，否则它会原样再调一次
    expect(result?.reason).toContain('不要重试')
  })

  it('「始终允许」之后同名工具不再询问', async () => {
    const { request, run } = gate('mutating', 'always')

    expect(await run(callCtx())).toBeUndefined()
    expect(await run(callCtx())).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  /**
   * 带 dry_run 的破坏性工具：预演按 riskFor 降成 safe，不问；在预演上点的
   * 「本次会话都允许」不能把真正的那次一起放行 —— 记住的授权按实际风险分开记。
   */
  it('riskFor 把 dry_run 降成 safe；预演上的始终允许放不过真正的那次', async () => {
    const dryRunTool = (): UnrealAgentTool<never> =>
      ({
        name: 't',
        unrealBox: {
          namespace: 'ue.content',
          risk: 'destructive',
          riskFor: (args: unknown) =>
            (args as { dry_run?: unknown })?.dry_run === true ? 'safe' : 'destructive'
        }
      }) as unknown as UnrealAgentTool<never>
    const remembered = new Set<string>()
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'always')
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'ask',
      alwaysAllowed: remembered,
      lookup: () => dryRunTool(),
      request
    })

    // 预演：safe，不问
    expect(await run(callCtx('t', { dry_run: true }))).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(0)

    // 真正执行：问，用户点「始终允许」
    expect(await run(callCtx('t', {}))).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
    expect(remembered.has('t')).toBe(true)
    // 之后同名的真正执行不再问
    expect(await run(callCtx('t', { dry_run: false }))).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('风险被 riskFor 降级的那次点「始终允许」，只记降级后的那一档', async () => {
    const remembered = new Set<string>()
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'always')
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'ask',
      alwaysAllowed: remembered,
      lookup: () =>
        ({
          name: 't',
          unrealBox: {
            namespace: 'ue.content',
            risk: 'destructive',
            riskFor: (args: unknown) =>
              (args as { preview?: unknown })?.preview === true ? 'mutating' : 'destructive'
          }
        }) as unknown as UnrealAgentTool<never>,
      request
    })
    // mutating 在 ask 下要问；点了始终允许，记的是 t#mutating
    expect(await run(callCtx('t', { preview: true }))).toBeUndefined()
    expect(remembered.has('t#mutating')).toBe(true)
    expect(remembered.has('t')).toBe(false)
    // 真正的 destructive 调用仍然要问
    expect(await run(callCtx('t', {}))).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
  })

  /**
   * `risk` 是声明的最坏情况，记在工具名上的「始终允许」覆盖的就是它。
   * riskFor 要是能往上抬，那条记录就会放过一次没人批准过的更危险的调用 —— 所以只降不升。
   */
  it('riskFor 不能把风险抬到声明之上', async () => {
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'approve')
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'ask',
      lookup: () =>
        ({
          name: 't',
          unrealBox: {
            namespace: 'ue.content',
            risk: 'mutating',
            riskFor: (args: unknown) =>
              (args as { force?: unknown })?.force === true ? 'destructive' : 'mutating'
          }
        }) as unknown as UnrealAgentTool<never>,
      request
    })
    await run(callCtx('t', { force: true }))
    expect((request.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      risk: 'mutating'
    })
  })

  it('切到只读后，旧的始终允许与完全访问均不能放行写操作', async () => {
    let readOnly = false
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'always')
    const run = createApprovalGate({
      sessionId: 'live',
      mode: () => (readOnly ? 'yolo' : 'ask'),
      isReadOnly: () => readOnly,
      lookup: () => tool('mutating'),
      request
    })
    expect(await run(callCtx())).toBeUndefined()
    readOnly = true
    expect(await run(callCtx())).toMatchObject({ block: true })
    expect(await run(callCtx('another-write'))).toMatchObject({ block: true })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('审批等待期间改为只读，即使随后批准也不能执行', async () => {
    let readOnly = false
    const remembered = new Set<string>()
    const run = createApprovalGate({
      sessionId: 'waiting',
      mode: 'ask',
      alwaysAllowed: remembered,
      isReadOnly: () => readOnly,
      lookup: () => tool('mutating'),
      request: async () => {
        readOnly = true
        return 'always'
      }
    })
    expect(await run(callCtx())).toMatchObject({ block: true })
    expect(remembered.size).toBe(0)
  })

  it('实时只读继续允许读取，未知工具被拦截', async () => {
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'approve')
    const run = createApprovalGate({
      sessionId: 'safe',
      mode: 'yolo',
      isReadOnly: () => true,
      lookup: (name) => (name === 'read' ? tool('safe') : undefined),
      request
    })
    expect(await run(callCtx('read'))).toBeUndefined()
    expect(await run(callCtx('unknown'))).toMatchObject({ block: true })
    expect(request).not.toHaveBeenCalled()
  })

  // 用户是被确认框拦住的那一刻才去调档位的。写死一份快照的话，
  // 他调完这一轮照样每一步都弹 —— 那个开关在最需要它的时候是坏的
  it('档位给函数时每次现读，跑到一半改档立刻生效', async () => {
    let mode: 'ask' | 'auto-edit' | 'yolo' = 'ask'
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'approve')
    const run = createApprovalGate({
      sessionId: 's',
      mode: () => mode,
      lookup: () => tool('mutating'),
      request
    })

    await run(callCtx())
    expect(request).toHaveBeenCalledTimes(1)

    mode = 'yolo'
    await run(callCtx())
    expect(request).toHaveBeenCalledTimes(1)
  })

  // 按钮上写的是「本次会话都允许」。集合活在审批门里的话它只管到这一轮结束
  //（审批门随 agent 创建，而 agent 每条消息重建一次），下一句话又开始问
  it('「始终允许」记在宿主给的集合里，换一轮也还算数', async () => {
    const alwaysAllowed = new Set<string>()
    const request = vi.fn(async (): Promise<ApprovalVerdict> => 'always')
    const deps = {
      sessionId: 's',
      mode: 'ask' as const,
      alwaysAllowed,
      lookup: () => tool('mutating'),
      request
    }

    await createApprovalGate(deps)(callCtx())
    // 下一条消息：agent 和审批门都是新的，只有这个集合是同一个
    await createApprovalGate(deps)(callCtx())

    expect(request).toHaveBeenCalledTimes(1)
    expect(alwaysAllowed.has('t')).toBe(true)
  })

  it('查不到元数据的工具按最危险处理（MCP 等第三方来源不可信）', async () => {
    const seen: ApprovalRequest[] = []
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'auto-edit',
      lookup: () => undefined,
      request: async (req): Promise<ApprovalVerdict> => {
        seen.push(req)
        return 'approve'
      }
    })

    await run(callCtx('mcp.unknown.doThing'))

    // auto-edit 下 mutating 会放行，但未知工具应按 destructive 处理 → 仍然询问
    expect(seen).toHaveLength(1)
    expect(seen[0].risk).toBe('destructive')
  })

  describe('逐次审批的工具（浏览器）', () => {
    const explicitGate = (
      verdict: ApprovalVerdict,
      mode: 'ask' | 'auto-edit' | 'yolo' = 'ask',
      alwaysAllowed = new Set<string>()
    ): { request: ReturnType<typeof vi.fn>; run: ReturnType<typeof createApprovalGate> } => {
      const request = vi.fn(async () => verdict)
      return {
        request,
        run: createApprovalGate({
          sessionId: 's',
          mode,
          alwaysAllowed,
          lookup: () => tool('mutating', true),
          request
        })
      }
    }

    it('完全访问下逐次审批工具直接放行', async () => {
      const { request, run } = explicitGate('approve', 'yolo')

      expect(await run(callCtx())).toBeUndefined()

      expect(request).not.toHaveBeenCalled()
    })

    it('每一次都问，不会因为上一次批准过就跳过', async () => {
      const { request, run } = explicitGate('approve')

      await run(callCtx())
      await run(callCtx())

      expect(request).toHaveBeenCalledTimes(2)
    })

    it('即使收到 always 也不写进名单 —— 界面藏了按钮，主进程不能只靠界面守', async () => {
      const alwaysAllowed = new Set<string>()
      const { request, run } = explicitGate('always', 'ask', alwaysAllowed)

      await run(callCtx())
      await run(callCtx())

      expect(alwaysAllowed.size).toBe(0)
      expect(request).toHaveBeenCalledTimes(2)
    })

    it('名单里恰好有同名工具时也不放行', async () => {
      const { request, run } = explicitGate('approve', 'ask', new Set(['t']))

      await run(callCtx())

      expect(request).toHaveBeenCalledTimes(1)
    })

    it('请求里带 allowAlways: false，界面据此不显示「本次会话都允许」', async () => {
      const seen: ApprovalRequest[] = []
      const run = createApprovalGate({
        sessionId: 's',
        mode: 'ask',
        lookup: () => tool('mutating', true),
        request: async (req): Promise<ApprovalVerdict> => {
          seen.push(req)
          return 'approve'
        }
      })

      await run(callCtx())

      expect(seen[0].allowAlways).toBe(false)
    })

    it('普通工具仍然带 allowAlways: true', async () => {
      const seen: ApprovalRequest[] = []
      const run = createApprovalGate({
        sessionId: 's',
        mode: 'ask',
        lookup: () => tool('destructive'),
        request: async (req): Promise<ApprovalVerdict> => {
          seen.push(req)
          return 'approve'
        }
      })

      await run(callCtx())

      expect(seen[0].allowAlways).toBe(true)
    })
  })

  it('审批链路自身故障时阻止调用，不把故障当成用户同意', async () => {
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'ask',
      lookup: () => tool('destructive'),
      request: async () => {
        throw new Error('IPC 挂了')
      }
    })

    expect(await run(callCtx())).toMatchObject({
      block: true,
      reason: expect.stringContaining('Approval unavailable')
    })
  })

  it('工具元数据读取失败时同样阻止调用', async () => {
    const run = createApprovalGate({
      sessionId: 's',
      mode: 'yolo',
      lookup: () => {
        throw new Error('registry unavailable')
      },
      request: async () => 'approve'
    })
    expect(await run(callCtx())).toMatchObject({ block: true })
  })
})
