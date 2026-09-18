import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  promises as fs
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-transcript-'))

vi.mock('electron', () => ({ app: { getPath: (): string => root } }))

import {
  TranscriptStore,
  deleteTranscript,
  forkTranscript,
  listTranscripts,
  loadTranscript,
  sliceToUserTurns,
  truncateTranscript
} from './transcriptStore'

const DIR = join(root, 'agent-v3-sessions')

const msg = (role: string, text: string): AgentMessage =>
  ({
    role,
    content: role === 'user' ? text : [{ type: 'text', text }],
    timestamp: 0
  }) as unknown as AgentMessage

afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

/**
 * 复刻 pi-ai `utils/estimate.js` 里那个**没判空**的 usage 读取。
 *
 * 抄一遍而不是 import：`utils/*` 不在 pi-ai 的 exports 里，深路径导入进不来。
 * 但这段逻辑每次请求都要跑（`clampMaxTokensToContext`），所以必须钉住 ——
 * 它一抛异常，整条会话就再也起不来了。
 */
function piWouldThrowOn(messages: AgentMessage[]): boolean {
  try {
    for (const message of messages) {
      const assistant = message as { role?: string; stopReason?: string; usage?: unknown }
      if (assistant.role !== 'assistant') continue
      if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') continue
      const usage = assistant.usage as { totalTokens: number }
      void usage.totalTokens
    }
    return false
  } catch {
    return true
  }
}

describe('TranscriptStore', () => {
  it.each(['writeFile', 'rename'] as const)(
    '压缩 %s 失败保留旧文件，严格调用能收到错误并重试',
    async (operation) => {
      const store = new TranscriptStore('s1')
      const original = [msg('user', 'first'), msg('user', 'second')]
      await store.append(original)
      const before = readFileSync(join(DIR, 's1.jsonl'), 'utf8')
      const failure = vi.spyOn(fs, operation).mockRejectedValueOnce(new Error('disk failure'))
      await expect(store.append([msg('user', 'summary')], { strict: true })).rejects.toThrow(
        'disk failure'
      )
      expect(readFileSync(join(DIR, 's1.jsonl'), 'utf8')).toBe(before)
      failure.mockRestore()
      await store.append([msg('user', 'summary')], { strict: true })
      expect(await loadTranscript('s1')).toEqual([msg('user', 'summary')])
    }
  )

  it('压缩成功保留会话创建时间', async () => {
    const store = new TranscriptStore('s1')
    await store.append([msg('user', 'a'), msg('user', 'b')])
    const before = (await listTranscripts())[0].createdAt
    await store.append([msg('user', 'summary')], { strict: true })
    expect((await listTranscripts())[0].createdAt).toBe(before)
  })
  it('落盘后能原样读回，助手消息补上全零用量', async () => {
    const store = new TranscriptStore('s1')
    const messages = [msg('user', '你好'), msg('assistant', '你好，有什么可以帮你')]

    await store.append(messages)

    expect(await loadTranscript('s1')).toEqual([
      messages[0],
      { ...messages[1], stopReason: 'endTurn', usage: expect.objectContaining({ totalTokens: 0 }) }
    ])
  })

  it('盘上已经写坏的老会话，读的时候补回来', async () => {
    // 修了写入侧不等于修了用户手上那些会话。不补的话他只能删掉对话重开，
    // 而他并不知道该删哪一条
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      join(DIR, 'legacy.jsonl'),
      [
        JSON.stringify({ kind: 'header', version: 1, sessionId: 'legacy', createdAt: 0 }),
        JSON.stringify({ kind: 'message', message: msg('user', '你好') }),
        JSON.stringify({ kind: 'message', message: msg('assistant', '没有 usage 的老消息') })
      ].join('\n')
    )

    expect(piWouldThrowOn(await loadTranscript('legacy'))).toBe(false)
  })

  it('厂商真报的用量不许被覆盖 —— 覆盖了上下文水位就永远算不对', async () => {
    const real = {
      ...msg('assistant', '真回答'),
      stopReason: 'endTurn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 }
    } as unknown as AgentMessage
    await new TranscriptStore('real-usage').append([msg('user', '问'), real])

    expect((await loadTranscript('real-usage'))[1]).toMatchObject({
      usage: { totalTokens: 120 }
    })
  })

  it('新会话第一次落盘就写合法 header —— 少了它整个文件读不回来', async () => {
    await new TranscriptStore('fresh').append([msg('user', '第一句')])

    const raw = readFileSync(join(DIR, 'fresh.jsonl'), 'utf8')
    expect(JSON.parse(raw.trim().split('\n')[0])).toMatchObject({
      kind: 'header',
      sessionId: 'fresh'
    })
  })

  it('增量追加，不重复写已落盘的部分', async () => {
    const store = new TranscriptStore('s1')
    await store.append([msg('user', '第一句')])
    await store.append([msg('user', '第一句'), msg('assistant', '第二句')])

    const loaded = await loadTranscript('s1')
    expect(loaded).toHaveLength(2)
    // 第一句只应该出现一次
    const raw = readFileSync(join(DIR, 's1.jsonl'), 'utf8')
    expect(raw.split('第一句').length - 1).toBe(1)
  })

  it('消息变短时（压缩换掉整个数组）重写整个文件', async () => {
    const store = new TranscriptStore('s1')
    await store.append([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')])

    // 压缩后 messages 被整体替换成更短的数组
    await store.append([msg('user', '【摘要】a b c'), msg('user', 'c')])

    const loaded = await loadTranscript('s1')
    expect(loaded).toHaveLength(2)
    expect(String((loaded[0] as { content: string }).content)).toContain('摘要')
  })

  it('markPersisted 后不会把恢复出来的历史再写一遍', async () => {
    const first = new TranscriptStore('s1')
    const history = [msg('user', '旧对话'), msg('assistant', '旧回复')]
    await first.append(history)

    // 模拟重启：读回历史，标记已落盘，再追加新消息
    const restored = await loadTranscript('s1')
    const second = new TranscriptStore('s1')
    second.markPersisted(restored.length)
    await second.append([...restored, msg('user', '新消息')])

    const loaded = await loadTranscript('s1')
    expect(loaded).toHaveLength(3)
    expect(readFileSync(join(DIR, 's1.jsonl'), 'utf8').split('旧对话').length - 1).toBe(1)
  })

  it('并发 append 不会写出交错的半行 JSON', async () => {
    const store = new TranscriptStore('s1')
    const batches = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: i + 1 }, (_, j) => msg('user', `m${j}`))
    )

    await Promise.all(batches.map((b) => store.append(b)))

    // 每一行都必须是合法 JSON
    const lines = readFileSync(join(DIR, 's1.jsonl'), 'utf8').trim().split('\n')
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  /**
   * 用户删一个**正在跑**的会话时，abort 之后 agent 还会发一次 agent_end，
   * 那条 append 会用 appendFile 把刚删掉的文件重新建出来 —— 而且没有 header，
   * listTranscripts 看不见它，loadTranscript 却读得回来。
   */
  it('discard 之后的 append 不再落盘', async () => {
    const store = new TranscriptStore('s1')
    await store.append([msg('user', '删之前')])

    await store.discard()
    await deleteTranscript('s1')
    await store.append([msg('user', '删之前'), msg('assistant', '收尾时冒出来的')])

    expect(await loadTranscript('s1')).toEqual([])
    expect(await listTranscripts()).toEqual([])
  })

  /**
   * 用户按下删除时，上一轮的 append 可能还排在队列里没执行。
   * discard 要连这些一起挡掉，否则删完文件又被它写回来。
   */
  it('排队中还没执行的 append 也一并作废', async () => {
    const store = new TranscriptStore('s1')
    const pending = store.append([msg('user', '还没落盘的')])

    await store.discard()
    await deleteTranscript('s1')
    await pending

    expect(await listTranscripts()).toEqual([])
    expect(await loadTranscript('s1')).toEqual([])
  })

  it('磁盘写失败不抛出 —— 持久化是增强功能，不能拖垮对话', async () => {
    const store = new TranscriptStore('s1')
    // 用一个目录占住文件名，让写入必然失败
    mkdirSync(DIR, { recursive: true })
    mkdirSync(join(DIR, 's1.jsonl'), { recursive: true })

    await expect(store.append([msg('user', 'x')])).resolves.toBeUndefined()
  })
})

describe('loadTranscript', () => {
  it('没有文件时返回空数组', async () => {
    expect(await loadTranscript('不存在的会话')).toEqual([])
  })

  it('跳过损坏的行，不让整个会话读不出来', async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      join(DIR, 's1.jsonl'),
      [
        JSON.stringify({ kind: 'header', version: 1, sessionId: 's1', createdAt: 0 }),
        JSON.stringify({ kind: 'message', message: msg('user', '好的那条') }),
        '{"kind":"message","message":{"role":"use', // 上次写到一半断电
        JSON.stringify({ kind: 'message', message: msg('assistant', '后面还能读') })
      ].join('\n') + '\n',
      'utf8'
    )

    const loaded = await loadTranscript('s1')
    expect(loaded).toHaveLength(2)
  })
})

describe('sessionId 安全性', () => {
  it('路径穿越的 sessionId 不会写到 userData 之外', async () => {
    // sessionId 来自渲染层，直接当文件名会有穿越风险
    const store = new TranscriptStore('../../../evil')
    await store.append([msg('user', 'x')])

    const metas = await listTranscripts()
    expect(metas).toHaveLength(1)
    // 文件必须落在 sessions 目录内
    expect(() => readFileSync(join(DIR, '_________evil.jsonl'), 'utf8')).not.toThrow()
  })
})

describe('listTranscripts / deleteTranscript', () => {
  it('列出会话，按最近修改排序', async () => {
    await new TranscriptStore('a').append([msg('user', '1')])
    await new TranscriptStore('b').append([msg('user', '1'), msg('assistant', '2')])

    const metas = await listTranscripts()
    expect(metas.map((m) => m.sessionId).sort()).toEqual(['a', 'b'])
    expect(metas.find((m) => m.sessionId === 'b')?.messageCount).toBe(2)
  })

  it('删除后不再出现在列表里', async () => {
    await new TranscriptStore('a').append([msg('user', '1')])
    await deleteTranscript('a')

    expect(await listTranscripts()).toEqual([])
  })

  it('目录不存在时返回空列表而不是抛错', async () => {
    expect(await listTranscripts()).toEqual([])
  })
})

describe('forkTranscript', () => {
  it('把全部消息复制到新 sessionId 名下，header 也换成新的', async () => {
    const messages = [msg('user', '问一下'), msg('assistant', '答一下')]
    await new TranscriptStore('source').append(messages)

    const result = await forkTranscript('source', 'branch')

    expect(result).toEqual({ ok: true, sessionId: 'branch', messageCount: 2 })
    // 新会话读回的消息和源一模一样（助手那条读的时候会补上全零用量）
    expect(await loadTranscript('branch')).toEqual(await loadTranscript('source'))
    // listTranscripts 靠 header 认会话 —— 分支必须以自己的身份被列出来
    const metas = await listTranscripts()
    expect(metas.map((m) => m.sessionId).sort()).toEqual(['branch', 'source'])
    expect(metas.find((m) => m.sessionId === 'branch')?.messageCount).toBe(2)
  })

  it('分支后两边各自追加，互不影响', async () => {
    const messages = [msg('user', '共同的起点')]
    const sourceStore = new TranscriptStore('source')
    await sourceStore.append(messages)
    await forkTranscript('source', 'branch')

    await sourceStore.append([...messages, msg('user', '源会话继续')])

    // 恢复现有会话的正确姿势：读回历史、markPersisted、再追加
    // （execute 就是这么干的，见 ipc/agentV3.ts）
    const branchExisting = await loadTranscript('branch')
    const branchStore = new TranscriptStore('branch')
    branchStore.markPersisted(branchExisting.length)
    await branchStore.append([...branchExisting, msg('user', '分支走另一边')])

    expect((await loadTranscript('source')).map((m) => (m as { content: string }).content)).toEqual(
      ['共同的起点', '源会话继续']
    )
    expect((await loadTranscript('branch')).map((m) => (m as { content: string }).content)).toEqual(
      ['共同的起点', '分支走另一边']
    )
  })

  it('源会话没有 transcript 时拒绝分支', async () => {
    const result = await forkTranscript('不存在的会话', 'branch')

    expect(result).toEqual({ ok: false, reason: 'missing' })
    expect(await listTranscripts()).toEqual([])
  })

  it('分支不改动源文件', async () => {
    const messages = [msg('user', '原话')]
    await new TranscriptStore('source').append(messages)
    const before = readFileSync(join(DIR, 'source.jsonl'), 'utf8')

    await forkTranscript('source', 'branch')

    expect(readFileSync(join(DIR, 'source.jsonl'), 'utf8')).toBe(before)
  })

  it('给了 keepUserTurns 就只复制到那一轮为止', async () => {
    await new TranscriptStore('source').append([
      msg('user', '第一问'),
      msg('assistant', '第一答'),
      msg('user', '第二问'),
      msg('assistant', '第二答')
    ])

    const result = await forkTranscript('source', 'branch', { keepUserTurns: 1 })

    expect(result).toEqual({ ok: true, sessionId: 'branch', messageCount: 2 })
    expect(
      (await loadTranscript('branch')).map((m) => (m as { content: unknown }).content)
    ).toEqual(['第一问', [{ type: 'text', text: '第一答' }]])
  })

  it('截完是空的（keepUserTurns 为 0）时拒绝分支，不留空文件', async () => {
    await new TranscriptStore('source').append([msg('user', '问'), msg('assistant', '答')])

    expect(await forkTranscript('source', 'branch', { keepUserTurns: 0 })).toEqual({
      ok: false,
      reason: 'missing'
    })
    expect((await listTranscripts()).map((m) => m.sessionId)).toEqual(['source'])
  })

  /**
   * 会话跑着的时候 IPC 层把内存里那份传进来 —— 盘上落后于内存（turn_end 才
   * 落盘），照盘上切会切出一份和用户看到的对不上的历史。
   */
  it('给了 sourceMessages 就照它切，不读盘', async () => {
    await new TranscriptStore('source').append([msg('user', '已落盘的一问')])

    const result = await forkTranscript('source', 'branch', {
      keepUserTurns: 1,
      sourceMessages: [
        msg('user', '内存里的第一问'),
        msg('assistant', '内存里的第一答'),
        msg('user', '还没说完的第二问')
      ]
    })

    expect(result).toEqual({ ok: true, sessionId: 'branch', messageCount: 2 })
    expect(
      (await loadTranscript('branch')).map((m) => (m as { content: unknown }).content)
    ).toEqual(['内存里的第一问', [{ type: 'text', text: '内存里的第一答' }]])
  })
})

/**
 * 分叉点的对齐规则。界面数的是「第几个用户回合」，内核这边按它下刀 ——
 * 一轮在内核里可能是 1 条 user + 若干 assistant/toolResult，下标对不上。
 */
describe('sliceToUserTurns', () => {
  const toolCall = (id: string): AgentMessage =>
    ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'ue.bp.get' }],
      timestamp: 0
    }) as unknown as AgentMessage
  const toolResult = (id: string): AgentMessage =>
    ({ role: 'toolResult', toolCallId: id, content: [], timestamp: 0 }) as unknown as AgentMessage

  it('留下前 N 个用户回合，连同它们中间的工具消息', () => {
    const messages = [
      msg('user', '问一'),
      toolCall('t1'),
      toolResult('t1'),
      msg('assistant', '答一'),
      msg('user', '问二'),
      msg('assistant', '答二')
    ]

    expect(sliceToUserTurns(messages, 1)).toEqual(messages.slice(0, 4))
  })

  it('回合数够或超出时原样返回', () => {
    const messages = [msg('user', '问'), msg('assistant', '答')]

    expect(sliceToUserTurns(messages, 1)).toBe(messages)
    expect(sliceToUserTurns(messages, 9)).toBe(messages)
  })

  it('0 个回合就是空', () => {
    expect(sliceToUserTurns([msg('user', '问')], 0)).toEqual([])
  })

  it('刀落在半截工具调用上时连那条一起截掉', () => {
    // 上一轮停在「发出了 toolCall、结果还没回来」——照原样切给分支，
    // 分支的第一次请求会因为 toolCall 没有配对的 toolResult 被厂商拒
    const messages = [msg('user', '问一'), toolCall('t1'), msg('user', '问二')]

    expect(sliceToUserTurns(messages, 1)).toEqual([msg('user', '问一')])
  })
})

/**
 * 「重新生成」「编辑消息」要把内核这份历史一起倒回去，否则模型看着自己
 * 刚被丢掉的答案再答一遍同一个问题 —— 用户以为重来，对它而言是追问。
 */
describe('truncateTranscript', () => {
  it('原地截回指定的用户回合数，后面的消息不再读得回来', async () => {
    await new TranscriptStore('s1').append([
      msg('user', '第一问'),
      msg('assistant', '第一答'),
      msg('user', '第二问'),
      msg('assistant', '第二答')
    ])

    expect(await truncateTranscript('s1', 1)).toEqual({ ok: true, messageCount: 2, dropped: 2 })
    expect((await loadTranscript('s1')).map((m) => (m as { content: unknown }).content)).toEqual([
      '第一问',
      [{ type: 'text', text: '第一答' }]
    ])
  })

  it('保留原来的 header —— 换掉的话这条会话在列表里会变成刚创建的', async () => {
    await new TranscriptStore('s1').append([msg('user', '问'), msg('assistant', '答')])
    const createdAt = (await listTranscripts()).find((m) => m.sessionId === 's1')?.createdAt

    await truncateTranscript('s1', 0)

    const meta = (await listTranscripts()).find((m) => m.sessionId === 's1')
    expect(meta?.sessionId).toBe('s1')
    expect(meta?.createdAt).toBe(createdAt)
    expect(meta?.messageCount).toBe(0)
  })

  it('截回 0 个回合就是清空，会话本身还在', async () => {
    await new TranscriptStore('s1').append([msg('user', '问'), msg('assistant', '答')])

    expect(await truncateTranscript('s1', 0)).toEqual({ ok: true, messageCount: 0, dropped: 2 })
    expect(await loadTranscript('s1')).toEqual([])
  })

  it('没什么可截时不碰文件', async () => {
    await new TranscriptStore('s1').append([msg('user', '问'), msg('assistant', '答')])
    const before = readFileSync(join(DIR, 's1.jsonl'), 'utf8')

    expect(await truncateTranscript('s1', 5)).toEqual({ ok: true, messageCount: 2, dropped: 0 })
    expect(readFileSync(join(DIR, 's1.jsonl'), 'utf8')).toBe(before)
  })

  it('没有 transcript 的会话报 missing，不凭空建文件', async () => {
    expect(await truncateTranscript('还没落过盘', 1)).toEqual({ ok: false, reason: 'missing' })
    expect(await listTranscripts()).toEqual([])
  })

  it('截完之后接着 append，新一轮接在截断处后面', async () => {
    await new TranscriptStore('s1').append([
      msg('user', '第一问'),
      msg('assistant', '被丢掉的答案')
    ])
    await truncateTranscript('s1', 0)

    // execute 恢复会话的姿势：读回、markPersisted、再 append
    const restored = await loadTranscript('s1')
    const store = new TranscriptStore('s1')
    store.markPersisted(restored.length)
    await store.append([...restored, msg('user', '第一问'), msg('assistant', '重新生成的答案')])

    expect((await loadTranscript('s1')).map((m) => (m as { content: unknown }).content)).toEqual([
      '第一问',
      [{ type: 'text', text: '重新生成的答案' }]
    ])
  })
})
