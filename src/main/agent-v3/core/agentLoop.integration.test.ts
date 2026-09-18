/**
 * @vitest-environment node
 *
 * Agent 循环的端到端集成测试。
 *
 * ## 它证明什么、不证明什么
 *
 * 用 pi 自带的 `fauxProvider` 编排「模型」的多轮响应 —— 模型说什么由脚本决定，
 * 但**从 StreamFn 往下的每一层都是真的**：pi 的 agent 循环、工具执行、
 * 审批钩子、steer 队列、compaction、task 子 agent、事件投影。
 *
 * 所以它证明的是**管道通不通**，不是模型判断得对不对。
 * 后者要接真实 provider 才能验，那是另一回事。
 *
 * 在此之前，V3 的这几条能力从来没有跑完过一整轮 —— 单测只覆盖到各自的纯函数。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'

import { defineTool, type UnrealAgentTool } from '../tools/defineTool'
import { createApprovalGate, type ApprovalVerdict } from './approval'
import { createLoopBreaker, MAX_IDENTICAL_FAILURES } from './loopBreaker'

// ── 测试用工具 ────────────────────────────────────────────────────────────

const calls: Array<{ name: string; args: unknown }> = []

function makeTool(
  name: string,
  risk: 'safe' | 'mutating' | 'destructive',
  result: () => Promise<string> = async () => `${name} 完成`
): UnrealAgentTool<never> {
  return defineTool({
    name,
    namespace: 'test',
    risk,
    description: `测试工具 ${name}`,
    input: z.object({ value: z.string().optional() }),
    execute: async (args) => {
      calls.push({ name, args })
      return { text: await result() }
    }
  }) as unknown as UnrealAgentTool<never>
}

/** 装一个跑在 faux provider 上的 Agent */
function setupAgent(
  tools: UnrealAgentTool<never>[],
  options: Partial<ConstructorParameters<typeof Agent>[0]> = {}
): { agent: Agent; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider({ tokensPerSecond: 100_000 })
  const models = createModels()
  models.setProvider(faux.provider)

  const agent = new Agent({
    streamFn: (model, context, streamOptions) => models.streamSimple(model, context, streamOptions),
    sessionId: 'integration',
    initialState: {
      model: faux.getModel(),
      systemPrompt: '你是测试用的助手。',
      tools: tools as unknown as AgentTool<never>[]
    },
    toolExecution: 'parallel',
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    convertToLlm: (messages: AgentMessage[]) => messages as never[],
    ...options
  })

  return { agent, faux }
}

beforeEach(() => {
  calls.length = 0
})

// ── 1. 基础循环：模型 → 工具 → 模型 ───────────────────────────────────────

describe('agent 循环', () => {
  it('模型请求工具 → 工具执行 → 结果回给模型 → 模型收尾', async () => {
    const { agent, faux } = setupAgent([makeTool('do_thing', 'safe')])

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('do_thing', { value: 'x' }, { id: 'c1' })]),
      fauxAssistantMessage('已经做完了')
    ])

    await agent.prompt('帮我做那件事')

    expect(calls).toEqual([{ name: 'do_thing', args: { value: 'x' } }])
    // 两轮：一轮出工具调用，一轮出结论
    expect(faux.state.callCount).toBe(2)
  })

  it('一轮里的多个工具并发执行', async () => {
    const { agent, faux } = setupAgent([makeTool('tool_a', 'safe'), makeTool('tool_b', 'safe')])

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('tool_a', {}, { id: 'c1' }),
        fauxToolCall('tool_b', {}, { id: 'c2' })
      ]),
      fauxAssistantMessage('都做完了')
    ])

    await agent.prompt('并行做两件事')

    expect(calls.map((c) => c.name).sort()).toEqual(['tool_a', 'tool_b'])
  })

  // V2 的硬上限是 12/10 步。V3 没有上限，这里跑 20 轮确认不会被截断。
  it('长链路不被步数上限截断', async () => {
    const { agent, faux } = setupAgent([makeTool('step', 'safe')])

    const rounds = 20
    faux.setResponses([
      ...Array.from({ length: rounds }, (_, i) =>
        fauxAssistantMessage([fauxToolCall('step', { value: String(i) }, { id: `c${i}` })])
      ),
      fauxAssistantMessage('全部完成')
    ])

    await agent.prompt('跑一条长链路')

    expect(calls).toHaveLength(rounds)
  }, 30_000)

  // 这是 defineTool 里那条契约的端到端验证：pi 只认异常
  it('工具抛异常时循环不中断，错误回给模型让它换路子', async () => {
    const { agent, faux } = setupAgent([
      makeTool('flaky', 'safe', async () => {
        throw new Error('引擎没连上')
      }),
      makeTool('fallback', 'safe')
    ])

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('flaky', {}, { id: 'c1' })]),
      fauxAssistantMessage([fauxToolCall('fallback', {}, { id: 'c2' })]),
      fauxAssistantMessage('换了个方式做完了')
    ])

    await agent.prompt('做那件事')

    expect(calls.map((c) => c.name)).toEqual(['flaky', 'fallback'])
    const text = JSON.stringify(agent.state.messages)
    expect(text).toContain('引擎没连上')
  })

  /**
   * 停止按钮的端到端验证 —— 这条量的是**用户感觉到的那个延迟**。
   *
   * 现象：点了停止，界面转十几秒才停。原因不在按钮，也不在 IPC，而在
   * `agent.abort()` 只是递了个意图：pi 检查它的时机在当前工具返回**之后**
   * （`agent-loop.js` 先 await tool.execute，再 `if (signal?.aborted) break`）。
   * 于是工具等引擎等多久，停止就僵多久 —— 截图那条路最长将近 40 秒。
   *
   * 断言写成「不到一秒就收尾」而不是「最终会收尾」：后者在修复前也是绿的，
   * 它等的就是那 40 秒。
   */
  it('工具还没返回时按停止，整轮当场收尾而不是等工具跑完', async () => {
    let released: (value: string) => void = () => {}
    const { agent, faux } = setupAgent([
      // 存量工具的典型样子：不读 signal，一直等引擎回话
      makeTool(
        'slow_engine_call',
        'safe',
        () => new Promise<string>((resolve) => (released = resolve))
      )
    ])

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('slow_engine_call', {}, { id: 'c1' })]),
      fauxAssistantMessage('不该走到这一步')
    ])

    const startedAt = Date.now()
    const run = agent.prompt('拍一张截图')
    // 等工具真的开始跑，否则测的是「还没派发就停了」，那条路本来就不卡
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    agent.abort()
    await run

    expect(Date.now() - startedAt).toBeLessThan(1000)
    // 工具那边还挂着 —— 引擎已经在做的事撤不回来，这是有意的
    expect(faux.state.callCount).toBe(1)
    released('迟到的结果')
  })

  /**
   * 撞墙熔断的端到端验证。
   *
   * 这条**只能这么测**。接真实模型时我换了三种写法都造不出这个失败 ——
   * DeepSeek 每次都自己推理出「资产不存在 / 参数不合法」然后拒绝调用。
   * 模型足够聪明是好事，但护栏是给坏情况准备的，判定线不能建立在那上面。
   * 用 faux 编排一个**铁了心一直重发同一组参数**的模型，才量得到上限。
   */
  it('模型反复用同一组参数调失败的工具时，被熔断而不是无限撞墙', async () => {
    const loopBreaker = createLoopBreaker()
    const { agent, faux } = setupAgent(
      [
        makeTool('stuck', 'safe', async () => {
          throw new Error('资产不存在')
        })
      ],
      {
        beforeToolCall: async (hookCtx) => loopBreaker.before(hookCtx),
        afterToolCall: async (hookCtx) => {
          loopBreaker.after(hookCtx)
          return undefined
        }
      }
    )

    // 模型死心眼：连着 10 轮原样重发
    faux.setResponses([
      ...Array.from({ length: 10 }, (_, i) =>
        fauxAssistantMessage([fauxToolCall('stuck', { assetKey: 'ZZZ' }, { id: `c${i}` })])
      ),
      fauxAssistantMessage('好吧，我换个思路')
    ])

    await agent.prompt('给 ZZZ 打标签')

    // 工具真正被执行的次数停在阈值上，后面几轮全被 before 钩子拦掉
    expect(calls).toHaveLength(MAX_IDENTICAL_FAILURES)

    // 而且拦截理由要真的进了模型上下文 —— 拦了不告诉模型，它还是会继续重发
    expect(JSON.stringify(agent.state.messages)).toContain('不要再用这组参数重试')
  }, 30_000)

  // 反面：换参数是正常排查行为，不能被熔断误伤
  it('换了参数重试不受熔断影响', async () => {
    const loopBreaker = createLoopBreaker()
    const { agent, faux } = setupAgent(
      [
        makeTool('search', 'safe', async () => {
          throw new Error('没搜到')
        })
      ],
      {
        beforeToolCall: async (hookCtx) => loopBreaker.before(hookCtx),
        afterToolCall: async (hookCtx) => {
          loopBreaker.after(hookCtx)
          return undefined
        }
      }
    )

    faux.setResponses([
      ...['tree', '树', 'foliage', 'plant', 'bush'].map((q, i) =>
        fauxAssistantMessage([fauxToolCall('search', { q }, { id: `c${i}` })])
      ),
      fauxAssistantMessage('都没搜到')
    ])

    await agent.prompt('找找树')

    // 五次都是不同参数，一次都不该被拦
    expect(calls).toHaveLength(5)
  }, 30_000)
})

// ── 2. 审批门 ─────────────────────────────────────────────────────────────

describe('审批门', () => {
  function setupWithApproval(verdict: ApprovalVerdict): ReturnType<typeof setupAgent> & {
    asked: string[]
  } {
    const tools = [makeTool('safe_read', 'safe'), makeTool('danger_delete', 'destructive')]
    const byName = new Map(tools.map((t) => [t.name, t]))
    const asked: string[] = []

    const result = setupAgent(tools, {
      beforeToolCall: createApprovalGate({
        sessionId: 's',
        mode: 'ask',
        lookup: (name) => byName.get(name),
        request: async (req) => {
          asked.push(req.toolName)
          return verdict
        }
      })
    })
    return { ...result, asked }
  }

  it('只读工具不触发审批', async () => {
    const { agent, faux, asked } = setupWithApproval('approve')
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('safe_read', {}, { id: 'c1' })]),
      fauxAssistantMessage('读完了')
    ])

    await agent.prompt('读一下')

    expect(asked).toEqual([])
    expect(calls.map((c) => c.name)).toEqual(['safe_read'])
  })

  it('批准后工具真的执行', async () => {
    const { agent, faux, asked } = setupWithApproval('approve')
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('danger_delete', {}, { id: 'c1' })]),
      fauxAssistantMessage('删完了')
    ])

    await agent.prompt('删掉它')

    expect(asked).toEqual(['danger_delete'])
    expect(calls.map((c) => c.name)).toEqual(['danger_delete'])
  })

  // 这是审批门最关键的一条：拒绝必须真的拦住，而不是只在界面上显示一下
  it('拒绝后工具不执行，且模型收到「不要重试」的指示', async () => {
    const { agent, faux, asked } = setupWithApproval('reject')
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('danger_delete', {}, { id: 'c1' })]),
      fauxAssistantMessage('好的，我不删了')
    ])

    await agent.prompt('删掉它')

    expect(asked).toEqual(['danger_delete'])
    expect(calls).toEqual([])
    expect(JSON.stringify(agent.state.messages)).toContain('不要重试')
  })
})

// ── 3. steer：运行中插话 ──────────────────────────────────────────────────

describe('steer 插话', () => {
  it('插入的消息在下一轮进入模型上下文', async () => {
    const { agent, faux } = setupAgent([makeTool('work', 'safe')])

    let steered = false
    faux.setResponses([
      // 第一轮：调工具。趁这轮还没结束时插话
      (context) => {
        if (!steered) {
          steered = true
          agent.steer({ role: 'user', content: '改成红色', timestamp: 0 } as never)
        }
        void context
        return fauxAssistantMessage([fauxToolCall('work', {}, { id: 'c1' })])
      },
      // 第二轮：这时上下文里应该已经有插话了
      (context) => {
        const seen = JSON.stringify(context.messages ?? [])
        return fauxAssistantMessage(seen.includes('改成红色') ? '收到，已改成红色' : '没看到插话')
      }
    ])

    await agent.prompt('做点什么')

    expect(JSON.stringify(agent.state.messages)).toContain('已改成红色')
  })
})

// ── 4. transformContext（compaction 挂载点）───────────────────────────────

describe('transformContext', () => {
  it('每轮请求前都会被调用，且替换后的上下文真的送给模型', async () => {
    const seenByModel: string[] = []
    const { agent, faux } = setupAgent([makeTool('noop', 'safe')], {
      transformContext: async (messages: AgentMessage[]) => [
        { role: 'user', content: '【压缩后的摘要】', timestamp: 0 } as never,
        ...messages.slice(-1)
      ]
    })

    faux.setResponses([
      (context) => {
        seenByModel.push(JSON.stringify(context.messages ?? []))
        return fauxAssistantMessage([fauxToolCall('noop', {}, { id: 'c1' })])
      },
      (context) => {
        seenByModel.push(JSON.stringify(context.messages ?? []))
        return fauxAssistantMessage('好')
      }
    ])

    await agent.prompt('第一句')

    expect(seenByModel).toHaveLength(2)
    // 两轮都经过了 transformContext
    for (const seen of seenByModel) expect(seen).toContain('压缩后的摘要')
  })
})

// ── 5. 工具流式进度与图片 ─────────────────────────────────────────────────

describe('工具的增量能力', () => {
  it('report() 的局部结果通过事件流出来', async () => {
    const progress: string[] = []
    const tool = defineTool({
      name: 'long_task',
      namespace: 'test',
      risk: 'safe',
      description: '长任务',
      input: z.object({}),
      execute: async (_args, ctx) => {
        ctx.report({ text: '进度 50%' })
        return { text: '完成' }
      }
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = setupAgent([tool])
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_update') {
        progress.push(JSON.stringify(event.partialResult))
      }
    })

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('long_task', {}, { id: 'c1' })]),
      fauxAssistantMessage('好')
    ])

    await agent.prompt('跑长任务')

    expect(progress).toHaveLength(1)
    expect(progress[0]).toContain('进度 50%')
  })

  // V2 要把图片存盘再回灌；V3 直接进工具结果
  it('工具返回的图片直接进上下文', async () => {
    const tool = defineTool({
      name: 'screenshot',
      namespace: 'test',
      risk: 'safe',
      description: '截图',
      input: z.object({}),
      execute: async () => ({
        text: '截图完成',
        images: [{ data: Buffer.from('fake-png'), mimeType: 'image/png' }]
      })
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = setupAgent([tool])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('screenshot', {}, { id: 'c1' })]),
      fauxAssistantMessage('我看到了')
    ])

    await agent.prompt('截个图')

    const transcript = JSON.stringify(agent.state.messages)
    expect(transcript).toContain('image')
    expect(transcript).toContain(Buffer.from('fake-png').toString('base64'))
  })
})

// ── 6. 事件投影 ───────────────────────────────────────────────────────────

describe('事件投影', () => {
  it('一整轮产生的事件序列符合界面预期', async () => {
    const { agent, faux } = setupAgent([makeTool('act', 'safe')])
    const types: string[] = []
    agent.subscribe((event) => {
      types.push(event.type)
    })

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('act', {}, { id: 'c1' })]),
      fauxAssistantMessage([fauxText('做完了')])
    ])

    await agent.prompt('做一件事')

    expect(types).toContain('agent_start')
    expect(types).toContain('tool_execution_start')
    expect(types).toContain('tool_execution_end')
    expect(types).toContain('turn_end')
    // agent_end 必须是最后一个 —— 界面靠它收尾
    expect(types[types.length - 1]).toBe('agent_end')
  })
})

// ── 7. 轮内换工具清单 ─────────────────────────────────────────────────────

/**
 * 一轮之内把工具清单换掉。
 *
 * ## 为什么要有这条
 *
 * 引擎工具是一轮开始时按当时的连接状态决定注册不注册的。而这一轮里模型完全
 * 可能**自己把工程打开**（`project_manage` 的 `open_project`）——编辑器起来了、
 * 插件连上了，模型手上却还是没有引擎工具。真机上它只能对用户说「请你在界面上
 * 把当前工程切过去」或者「请再发一条消息」。用户一个字的信息都补不了。
 *
 * 修法的前提是「工具清单可以中途换」。这一条钉死那个前提：它是 pi 的
 * `prepareNextTurn` 契约，不是我们能自己保证的东西 —— 升级 pi 打掉了这条，
 * `createAgent.ts` 那段 `prepareNextTurnWithContext` 会静默失效，而表现是
 * 模型又开始请用户帮忙切工程。这里失败得比那早得多。
 */
describe('轮内换工具清单', () => {
  it('prepareNextTurnWithContext 换进来的工具，下一轮就能调', async () => {
    const engineTool = makeTool('engine_do', 'safe')
    let unlocked = false

    const { agent, faux } = setupAgent([makeTool('open_project', 'safe')], {
      prepareNextTurnWithContext: (turn) => {
        if (!unlocked) return undefined
        return { context: { ...turn.context, tools: [...(turn.context.tools ?? []), engineTool] } }
      }
    })

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('open_project', {}, { id: 'c1' })]),
      fauxAssistantMessage([fauxToolCall('engine_do', {}, { id: 'c2' })]),
      fauxAssistantMessage('工程开好了，活也干完了')
    ])

    // 第一个工具跑完就等于「工程连上了」
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_end') unlocked = true
    })

    await agent.prompt('把工程打开，然后干活')

    // 关键：engine_do 在这一轮开始时**不在清单里**，照样调到了
    expect(calls.map((c) => c.name)).toEqual(['open_project', 'engine_do'])
  })

  // 换的是数组本身，不能连带把这一轮已经跑出来的对话丢掉
  it('换工具不影响已经积累的对话', async () => {
    const { agent, faux } = setupAgent([makeTool('step', 'safe')], {
      prepareNextTurnWithContext: (turn) => ({
        context: { ...turn.context, tools: turn.context.tools ?? [] }
      })
    })

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('step', { value: '1' }, { id: 'c1' })]),
      fauxAssistantMessage([fauxToolCall('step', { value: '2' }, { id: 'c2' })]),
      fauxAssistantMessage('两步都做完了')
    ])

    await agent.prompt('分两步做')

    expect(calls.map((c) => c.args)).toEqual([{ value: '1' }, { value: '2' }])
    // user + (assistant + toolResult) × 2 + assistant
    expect(agent.state.messages.filter((m) => m.role === 'toolResult')).toHaveLength(2)
  })
})

// 本文件不打桩，全部走真实实现
void vi
