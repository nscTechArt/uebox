import { describe, expect, it, vi } from 'vitest'
import { estimateContextTokens, type AgentMessage } from '@earendil-works/pi-agent-core'

// vi.mock 会被提升到文件顶部，工厂里不能引用普通的顶层变量。
// vi.hoisted 让这个 mock 函数跟着一起提升。
const { generateSummary } = vi.hoisted(() => ({ generateSummary: vi.fn() }))
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return { ...actual, generateSummary }
})

import {
  compactionThreshold,
  compactMessages,
  createAutoCompact,
  estimateMessagesTokens,
  measureCompaction,
  splitAtRecentBudget,
  UNREAL_BOX_COMPACTION
} from './compaction'

/**
 * pi 的消息形态：assistant / toolResult 的 content 必须是**块数组**。
 * 写成字符串的话 estimateTokens 一律返回 0，测试就测不出真实的切分行为。
 */
const msg = (role: string, text: string): AgentMessage =>
  ({
    role,
    content: role === 'user' ? text : [{ type: 'text', text }],
    timestamp: 0,
    ...(role === 'toolResult' ? { toolCallId: 'c1', toolName: 't' } : {})
  }) as unknown as AgentMessage

/** 造一条足够长的消息，用来撑爆 token 预算。pi 的启发式是 4 字符 ≈ 1 token */
const bigMsg = (role: string, n: number): AgentMessage => msg(role, 'x'.repeat(n))

/**
 * 给 assistant 消息挂上厂商回报的用量 —— 真实 transcript 落盘时就带着这个。
 * `estimateContextTokens` 会优先采信它，这正是「压缩前后数字纹丝不动」的来源。
 */
const withUsage = (message: AgentMessage, totalTokens: number): AgentMessage =>
  ({ ...message, stopReason: 'endTurn', usage: { totalTokens } }) as unknown as AgentMessage

/**
 * 造一段确定会触发压缩的历史。
 *
 * 必须超过 keepRecentTokens（24000），否则 splitAtRecentBudget 会把所有消息
 * 都算进"最近"，head 为空 → 直接原样返回。用小量数据写的测试会**假绿**：
 * 断言通过只是因为压缩根本没跑。
 */
const longHistory = (): AgentMessage[] => [
  ...Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant', 40_000)),
  msg('user', '继续')
]

const deps = (contextWindow: number): Parameters<typeof createAutoCompact>[0] => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  models: {} as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summaryModel: { id: 'm', contextWindow } as any,
  contextWindow
})

describe('splitAtRecentBudget', () => {
  it('尾部留够预算，头部拿去摘要', () => {
    const messages = longHistory()

    const { head, tail } = splitAtRecentBudget(messages, 20_000)

    expect(head.length).toBeGreaterThan(0)
    expect(tail).toContain(messages[messages.length - 1])
    expect(head.length + tail.length).toBe(messages.length)
  })

  it('消息很少时全部保留，不做无谓的摘要', () => {
    const messages = [msg('user', '你好'), msg('assistant', '你好')]

    const { head, tail } = splitAtRecentBudget(messages, 20_000)

    expect(head).toEqual([])
    expect(tail).toEqual(messages)
  })

  it('切点不落在孤儿 toolResult 上（厂商会直接拒绝这种请求）', () => {
    const messages = [
      bigMsg('user', 60_000),
      bigMsg('assistant', 10_000),
      msg('toolResult', '工具结果'),
      msg('assistant', '结论')
    ]

    const { tail } = splitAtRecentBudget(messages, 1_000)

    expect((tail[0] as { role: string }).role).not.toBe('toolResult')
  })
})

describe('compactionThreshold', () => {
  it('大窗口按七成 —— 1M 窗口不该等到 98% 才压', () => {
    expect(compactionThreshold(1_000_000)).toBe(700_000)
    expect(compactionThreshold(200_000)).toBe(140_000)
  })

  it('小窗口退回「窗口 - 保留额度」—— 七成那条线会把摘要 prompt 自己挤掉', () => {
    // 32K 窗口：七成是 22.4K，比 32K-16.4K=15.6K 更晚，取更早的那条
    expect(compactionThreshold(32_000)).toBe(32_000 - UNREAL_BOX_COMPACTION.reserveTokens)
  })
})

describe('createAutoCompact', () => {
  it('没超阈值时原样返回，不调摘要模型', async () => {
    generateSummary.mockReset()
    const compact = createAutoCompact(deps(200_000))

    const messages = [msg('user', '你好')]
    expect(await compact(messages)).toBe(messages)
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('每次都上报用量，供界面画用量条', async () => {
    const onUsage = vi.fn()
    const compact = createAutoCompact({ ...deps(200_000), onUsage })

    await compact([msg('user', '你好')])

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindow: 200_000, tokens: expect.any(Number) })
    )
  })

  it('超阈值时生成摘要并替换头部', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '此前做了 A 和 B' })
    const onCompacting = vi.fn()
    const compact = createAutoCompact({ ...deps(8_000), onCompacting })

    const messages = longHistory()
    const result = await compact(messages)

    expect(onCompacting).toHaveBeenCalled()
    expect(result.length).toBeLessThan(messages.length)
    expect(generateSummary).toHaveBeenCalled()
    expect(String((result[0] as { content: string }).content)).toContain('此前做了 A 和 B')
  })

  it('摘要失败时返回原始消息，不让循环崩掉', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: false, error: new Error('厂商 500') })
    const compact = createAutoCompact(deps(8_000))

    const messages = longHistory()
    expect(await compact(messages)).toBe(messages)
    // 确认真的走到了摘要那一步，而不是因为没触发压缩才"通过"
    expect(generateSummary).toHaveBeenCalled()
  })

  it('摘要模型抛异常时也返回原始消息（transformContext 不能抛）', async () => {
    generateSummary.mockReset().mockRejectedValue(new Error('网络断了'))
    const compact = createAutoCompact(deps(8_000))

    const messages = longHistory()
    await expect(compact(messages)).resolves.toBe(messages)
    expect(generateSummary).toHaveBeenCalled()
  })

  it('窗口用到七成就压，不等到贴着上限才动手', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '摘要' })
    // 8 条 40000 字符 ≈ 80K token，窗口 100K → 已过 70K 线，但远没到 pi 的 83.6K
    const compact = createAutoCompact(deps(100_000))

    const messages = longHistory()
    const result = await compact(messages)

    expect(generateSummary).toHaveBeenCalled()
    expect(result.length).toBeLessThan(messages.length)
  })

  it('七成以下不压 —— 压缩仍是兜底不是常态', async () => {
    generateSummary.mockReset()
    // 同一段历史（≈80K），窗口放到 200K → 只用了四成
    const compact = createAutoCompact(deps(200_000))

    const messages = longHistory()
    expect(await compact(messages)).toBe(messages)
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('保留额度比 pi 默认更大 —— UE 工作流丢不起最近几轮的路径和 node_id', () => {
    expect(UNREAL_BOX_COMPACTION.keepRecentTokens).toBeGreaterThanOrEqual(24_000)
    expect(UNREAL_BOX_COMPACTION.enabled).toBe(true)
  })
})

/**
 * 手动压缩走的是**同一个** `compactMessages`。
 *
 * 自动和手动各写一遍的话，两边生成的摘要会慢慢分叉，而那种差异只会在
 * 用户抱怨「压完之后它就忘事了」时才被发现。这里钉住共用这件事。
 */
describe('compactMessages', () => {
  const summaryDeps = deps(128_000)

  it('把早期对话换成摘要，最近几轮原样保留', async () => {
    generateSummary.mockResolvedValue({ ok: true, value: '这是摘要' })
    const history = longHistory()

    const outcome = await compactMessages(history, summaryDeps)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.summary).toBe('这是摘要')
    expect(outcome.messages.length).toBeLessThan(history.length)
    expect(String((outcome.messages[0] as { content?: unknown }).content)).toContain('这是摘要')
    // 最后一条必须还是原来那条 —— 压缩不该动最近的对话
    expect(outcome.messages.at(-1)).toEqual(history.at(-1))
  })

  // 和自动压缩的唯一区别：不看阈值。用户明说要压就压
  it('不做阈值判断 —— 远没满也照压', async () => {
    generateSummary.mockResolvedValue({ ok: true, value: 'S' })
    // 窗口给到 1000 万，自动压缩绝不会触发
    const outcome = await compactMessages(longHistory(), deps(10_000_000))
    expect(outcome.ok).toBe(true)
  })

  /**
   * 对话不够长时明确说清楚，而不是假装压过了。
   * 界面据此给出「已经很紧凑了」，用户才不会以为按钮坏了。
   */
  it('最近几轮就占满保留额度时报 too-short', async () => {
    const outcome = await compactMessages([msg('user', '你好')], summaryDeps)
    expect(outcome).toEqual({ ok: false, reason: 'too-short' })
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('摘要生成失败时报 summary-failed', async () => {
    generateSummary.mockResolvedValue({ ok: false, error: new Error('炸了') })
    const outcome = await compactMessages(longHistory(), summaryDeps)
    expect(outcome).toEqual({ ok: false, reason: 'summary-failed' })
  })
})

/**
 * 手动压缩报给用户的数字。
 *
 * 曾经这里用 `estimateContextTokens` 量压缩后的体积，结果永远等于压缩前 ——
 * 界面显示「162K → 162K」，再点一次还被判成「已经压过了」。
 */
describe('measureCompaction', () => {
  it('量得出头部被砍掉 —— 而 estimateContextTokens 量不出', async () => {
    generateSummary.mockResolvedValue({ ok: true, value: '摘要' })
    const history = longHistory()
    // 最后一条 assistant 带着厂商回报的 162K。压缩砍的是头部，它原样留在尾巴里
    history[7] = withUsage(history[7], 162_000)

    const outcome = await compactMessages(history, deps(128_000))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 先确认这一趟真砍掉了东西，否则下面的断言只是在测「什么都没发生」
    expect(outcome.messages.length).toBeLessThan(history.length)

    // 旧量尺：两边一模一样。这条钉住的是「为什么不能用它」
    expect(estimateContextTokens(outcome.messages).tokens).toBe(
      estimateContextTokens(history).tokens
    )

    const { tokensBefore, tokensAfter, saved } = measureCompaction(history, outcome.messages)
    expect(tokensBefore).toBeGreaterThanOrEqual(162_000)
    expect(saved).toBeGreaterThan(0)
    expect(tokensBefore - tokensAfter).toBe(saved)
  })

  it('没砍掉任何东西时 saved 不为正 —— 界面据此说「已经压过了」', () => {
    const history = longHistory()
    expect(measureCompaction(history, history).saved).toBe(0)
  })

  it('真实基数含系统提示词和工具定义，不会掉到字符估算那个量级', () => {
    const history = longHistory()
    history[7] = withUsage(history[7], 162_000)

    // 字符估算只看得见消息本身（约 8 × 10K），厂商报的 162K 才是用户真正用掉的
    expect(estimateMessagesTokens(history)).toBeLessThan(162_000)
    expect(measureCompaction(history, history).tokensAfter).toBeGreaterThanOrEqual(162_000)
  })

  /**
   * `saved` 必须和 `tokensBefore` 同一把尺。
   *
   * 它俩一个来自 `estimateContextTokens`（图片记 1200 token 或直接采信厂商用量），
   * 一个来自逐条求和。混用按字节计价的那把尺之后，一张大图就能让 `saved`
   * 比 `tokensBefore` 大一个数量级，`tokensAfter` 被夹到 0，界面显示「162K → 0」。
   */
  it('saved 和 tokensBefore 同尺，tokensAfter 不会被夹到 0', () => {
    const withImage = (kb: number): AgentMessage =>
      ({
        role: 'user',
        content: [{ type: 'image', data: 'A'.repeat(kb * 1024), mimeType: 'image/jpeg' }],
        timestamp: 0
      }) as unknown as AgentMessage
    const before = [withImage(4700), msg('user', '问题')]

    const { tokensBefore, tokensAfter, saved } = measureCompaction(before, [msg('user', '问题')])

    expect(saved).toBeLessThanOrEqual(tokensBefore)
    expect(tokensBefore - tokensAfter).toBe(saved)
  })
})

/**
 * 图片的字节差额只补给「厂商还没报过账」的那一段。
 *
 * pi 把图片一律按 4800 字符（1200 token）算，不看实际多大 —— 真机上两张原样
 * 发出去的截图把上下文顶到 123 万 token，而按 pi 的算法它们合计只有 2400。
 * 但差额**不能全量补**：厂商已经如实计过价的那一段再补一遍，数字会虚高两三倍，
 * 于是每一轮都判定「该压了」，而按 pi 的尺那些图只值 1200，切头部根本降不下来。
 */
describe('图片字节差额只补未计价的那段', () => {
  const withImage = (kb: number): AgentMessage =>
    ({
      role: 'user',
      content: [{ type: 'image', data: 'A'.repeat(kb * 1024), mimeType: 'image/jpeg' }],
      timestamp: 0
    }) as unknown as AgentMessage

  /**
   * 这把尺**不能**用在切点上：一张正常压过的截图就值 6 万 token，而
   * keepRecentTokens 一共才 24000 —— 用它算，第一轮就把额度耗光，`cut` 停在
   * 末尾，连用户刚发的那条一起被摘要掉。
   */
  it('切点不受图片大小影响，最近那条留得住', () => {
    const messages = [msg('user', '早先'), msg('assistant', '答'), withImage(180)]

    const { tail } = splitAtRecentBudget(messages, UNREAL_BOX_COMPACTION.keepRecentTokens)

    expect(tail.length).toBeGreaterThan(0)
  })

  /**
   * 正常大小的图不该把压缩逼出来。
   *
   * 三张压在预算内（180KB）的截图，全量补差额是 13.8 万 token，在 128k 窗口上
   * 直接越过阈值 —— 而 `splitAtRecentBudget` 按 pi 的尺看它们只值 3600，
   * 切不出头部，于是每个模型请求都宣布一次压缩、什么都没压。
   */
  it('厂商报过账之后，正常大小的图不会反复触发压缩', async () => {
    const base = [msg('user', '你好'), withImage(180), withImage(180), withImage(180)]
    const onCompacting = vi.fn()
    const transform = createAutoCompact({
      models: {} as never,
      summaryModel: {} as never,
      contextWindow: 128_000,
      onCompacting
    } as never)

    const out = await transform(base as never, undefined as never)

    expect(onCompacting).not.toHaveBeenCalled()
    expect(out).toBe(base)
  })
})

/**
 * 摘要检查点。
 *
 * 这一段守的是一个**正在花钱**的缺陷，不是性能优化：pi 的 `transformContext`
 * 只把结果喂给这一次模型请求，**不写回** `agent.state.messages`；而 agent 每条
 * 用户消息重建一次。于是没有检查点时，一轮里调五次工具就重新调五次摘要模型，
 * 每次措辞还都不一样 —— Prompt Cache 也跟着一次都命中不了。
 */
describe('createAutoCompact —— 摘要检查点', () => {
  /** 逐条 JSON 的简易指纹。真实实现在 compactionCheckpoint.hashMessages */
  const hashMessages = (messages: AgentMessage[]): string =>
    `${messages.length}:${JSON.stringify(messages).length}`

  const withCheckpoint = (
    contextWindow: number,
    initial?: Parameters<typeof createAutoCompact>[0]['checkpoint'] extends infer T
      ? T extends { initial?: infer I }
        ? I
        : never
      : never
  ): { deps: Parameters<typeof createAutoCompact>[0]; saved: ReturnType<typeof vi.fn> } => {
    const saved = vi.fn(async () => undefined)
    return {
      deps: {
        ...deps(contextWindow),
        hashMessages,
        checkpoint: { ...(initial ? { initial } : {}), save: saved }
      },
      saved
    }
  }

  it('压过一次之后落一个检查点，带上切点和指纹', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '摘要 A' })
    const { deps: d, saved } = withCheckpoint(8_000)
    const messages = longHistory()

    await createAutoCompact(d)(messages)

    expect(saved).toHaveBeenCalledTimes(1)
    const checkpoint = saved.mock.calls[0][0] as Record<string, unknown>
    expect(checkpoint.summary).toBe('摘要 A')
    expect(checkpoint.cutIndex).toBeGreaterThan(0)
    expect(checkpoint.contextEpoch).toBe(1)
    expect(checkpoint.sourceHash).toBe(
      hashMessages(messages.slice(0, checkpoint.cutIndex as number))
    )
  })

  /**
   * 一轮里模型会请求很多次（每调一次工具就再来一轮）。
   * 这一条是整个改动的要害：第二次请求必须直接复用，不能再调一次摘要模型。
   */
  it('同一轮里的后续请求复用摘要，不再调摘要模型', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '摘要 A' })
    const { deps: d, saved } = withCheckpoint(8_000)
    const compact = createAutoCompact(d)
    const messages = longHistory()

    const first = await compact(messages)
    const second = await compact(messages)

    expect(generateSummary).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
    // 两次拿到的上下文逐字节相同 —— 前缀稳定，缓存才可能命中
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('下一轮带着盘上的检查点起来时，直接投影，一次摘要都不调', async () => {
    generateSummary.mockReset()
    const messages = longHistory()
    const cutIndex = 4
    // 窗口要大到「投影之后就不必再压」—— 否则这一条测的是「又压了一次」，
    // 而不是「复用了检查点」
    const { deps: d } = withCheckpoint(200_000, {
      contextEpoch: 2,
      summary: '上一轮存下来的摘要',
      cutIndex,
      sourceHash: hashMessages(messages.slice(0, cutIndex)),
      createdAt: 0
    })

    const result = await createAutoCompact(d)(messages)

    expect(generateSummary).not.toHaveBeenCalled()
    expect(String((result[0] as { content: string }).content)).toContain('上一轮存下来的摘要')
    expect(result.length).toBe(messages.length - cutIndex + 1)
  })

  /**
   * 用户「重新生成」「编辑消息」「分支」都会改动早期历史。
   * 那时旧摘要描述的是一段已经不存在的对话 —— 拿去喂模型比不压更糟。
   */
  it('历史被改过（指纹对不上）时作废检查点，重新压一次', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '新摘要' })
    const { deps: d } = withCheckpoint(8_000, {
      contextEpoch: 5,
      summary: '一段已经不存在的对话',
      cutIndex: 4,
      sourceHash: '对不上的指纹',
      createdAt: 0
    })

    const result = await createAutoCompact(d)(longHistory())

    expect(generateSummary).toHaveBeenCalledTimes(1)
    expect(String((result[0] as { content: string }).content)).toContain('新摘要')
    expect(String((result[0] as { content: string }).content)).not.toContain('已经不存在')
  })

  it('切点超出当前消息条数时同样作废 —— 会话被截短过', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: '新摘要' })
    const { deps: d } = withCheckpoint(8_000, {
      contextEpoch: 1,
      summary: '旧摘要',
      cutIndex: 9_999,
      sourceHash: 'x',
      createdAt: 0
    })

    await createAutoCompact(d)(longHistory())

    expect(generateSummary).toHaveBeenCalled()
  })

  // 再压一次就是新一代上下文，缓存键要跟着换（见 compactionCheckpoint.promptCacheKey）
  it('再压一次时代数 +1', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: 'S' })
    const messages = longHistory()
    const cutIndex = 2
    const { deps: d, saved } = withCheckpoint(8_000, {
      contextEpoch: 7,
      summary: '旧摘要',
      cutIndex,
      sourceHash: hashMessages(messages.slice(0, cutIndex)),
      createdAt: 0
    })

    // 窗口小到即便投影过也还得再压一次
    await createAutoCompact(d)(messages)

    expect((saved.mock.calls[0]?.[0] as Record<string, unknown>)?.contextEpoch).toBe(8)
  })

  /**
   * 迭代式摘要：再压时把上一份摘要一起喂进去更新，
   * 而不是对着已经压过的历史再概括一层。
   */
  it('再压时把上一份摘要交给摘要模型', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: 'S2' })
    const messages = longHistory()
    const cutIndex = 2
    const { deps: d } = withCheckpoint(8_000, {
      contextEpoch: 1,
      summary: '上一份摘要',
      cutIndex,
      sourceHash: hashMessages(messages.slice(0, cutIndex)),
      createdAt: 0
    })

    await createAutoCompact(d)(messages)

    // 第 7 个参数是 previousSummary（见 pi 的 generateSummary 签名）。
    // 不用 toHaveBeenCalledWith + expect.anything()：signal 那一位是 undefined，
    // anything() 不匹配 undefined，断言会因为一个和本条无关的原因红掉
    expect(generateSummary.mock.calls[0][6]).toBe('上一份摘要')
  })

  // 没有落盘通道的场景（子 agent、调试入口）同样该在这一轮里复用
  it('没有落盘通道时也在内存里复用，不重复摘要', async () => {
    generateSummary.mockReset().mockResolvedValue({ ok: true, value: 'S' })
    const compact = createAutoCompact({ ...deps(8_000), hashMessages })
    const messages = longHistory()

    await compact(messages)
    await compact(messages)

    expect(generateSummary).toHaveBeenCalledTimes(1)
  })
})
