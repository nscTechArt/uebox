/**
 * 队员的压缩检查点：存在团队目录里，下次派活重建 agent 时接着用。
 *
 * 队员每次派活都重建 agent。以前检查点只活在闭包里，一清就拿完整原始历史去发 ——
 * 这里走一遍「压缩 → 存记忆和检查点 → 从盘上读回 → 新的一个 agent 直接投影」，
 * 记忆和检查点都经过真实的落盘（JSON 往返），指纹用的是真实的 hashMessages。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { electronMock } from '../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
const { generateSummary } = vi.hoisted(() => ({ generateSummary: vi.fn() }))
vi.mock('../../vendor/pi-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../vendor/pi-harness')>()
  return { ...actual, generateSummary }
})

import { createAutoCompact } from '../compaction'
import { hashMessages, parseCheckpoint } from '../compactionCheckpoint'
import { createTeamStore, type TeamStore } from './teamStore'

const text = (role: 'user' | 'assistant', chars: number): AgentMessage =>
  ({
    role,
    content: role === 'user' ? 'x'.repeat(chars) : [{ type: 'text', text: 'x'.repeat(chars) }],
    timestamp: 0
  }) as unknown as AgentMessage

const history = (): AgentMessage[] =>
  Array.from({ length: 10 }, (_, i) => text(i % 2 ? 'assistant' : 'user', 40_000))

const contextWindow = 100_000
const memberCompact = (
  store: TeamStore,
  initial?: ReturnType<typeof parseCheckpoint>
): ReturnType<typeof createAutoCompact> =>
  createAutoCompact({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    models: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summaryModel: { id: 'm', contextWindow } as any,
    contextWindow,
    hashMessages,
    checkpoint: {
      ...(initial ? { initial } : {}),
      save: (next) => store.saveMemberCheckpoint('美术', next)
    }
  })

let dir: string
let store: TeamStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'member-checkpoint-'))
  store = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
  generateSummary.mockReset().mockResolvedValue({ ok: true, value: '美术那边做完了灰盒' })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('队员检查点', () => {
  it('存在记忆旁边；下次派活读回来直接投影，不再调摘要模型', async () => {
    const messages = history()
    const first = await memberCompact(store)(messages)
    expect(generateSummary).toHaveBeenCalledTimes(1)
    await store.saveHistory('美术', messages)

    expect((await readdir(join(dir, 'state', 'members'))).sort()).toEqual([
      '美术.compaction.json',
      '美术.json'
    ])

    // 重新派活：记忆从盘上读回，再接上这次的新消息
    const reloaded = [...(await store.history('美术')), text('user', 40)]
    const initial = parseCheckpoint(await store.memberCheckpoint('美术'))
    expect(initial).toBeDefined()
    const second = await memberCompact(store, initial)(reloaded)

    expect(generateSummary).toHaveBeenCalledTimes(1)
    // 同一份摘要打头，前缀不变，缓存还能命中
    expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]))
    expect(second.length).toBe(first.length + 1)
  })

  it('记忆被换过（换了人、历史被改）：指纹对不上，检查点作废重压', async () => {
    await memberCompact(store)(history())
    const initial = parseCheckpoint(await store.memberCheckpoint('美术'))

    const rewritten = history().map((m, i) => (i === 0 ? text('user', 39_000) : m))
    await memberCompact(store, initial)(rewritten)

    expect(generateSummary).toHaveBeenCalledTimes(2)
  })

  it('没有检查点、或文件坏了，读回 undefined，不拦着派活', async () => {
    expect(parseCheckpoint(await store.memberCheckpoint('新人'))).toBeUndefined()
    await store.saveMemberCheckpoint('新人', { summary: '' })
    expect(parseCheckpoint(await store.memberCheckpoint('新人'))).toBeUndefined()
  })
})
