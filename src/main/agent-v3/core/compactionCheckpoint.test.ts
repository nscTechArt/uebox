/**
 * @vitest-environment node
 *
 * 压缩检查点的持久化契约。
 *
 * 它守的是两件事：一份摘要能跨轮、跨重启复用（不复用就是每次请求重新调一遍
 * 摘要模型 —— 那是在持续烧钱，见 `compactionCheckpoint.ts` 的文件头），
 * 以及历史一变就**必须**作废（不作废就是拿一份描述着已经不存在的对话的摘要
 * 去喂模型，比不压更糟）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-checkpoint-'))

vi.mock('electron', () => ({ app: { getPath: (): string => root } }))

import {
  PROMPT_PROTOCOL_VERSION,
  deleteCheckpoint,
  hashMessages,
  loadCheckpoint,
  promptCacheKey,
  saveCheckpoint,
  type CompactionCheckpoint
} from './compactionCheckpoint'

const DIR = join(root, 'agent-v3-sessions')

const msg = (role: string, text: string): AgentMessage =>
  ({ role, content: text, timestamp: 0 }) as unknown as AgentMessage

const checkpoint = (overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint => ({
  contextEpoch: 1,
  summary: '此前建了 M_GlowBreath',
  cutIndex: 4,
  sourceHash: 'abc',
  createdAt: 1_700_000_000_000,
  ...overrides
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('落盘与读回', () => {
  it('存进去什么就读回什么', async () => {
    await saveCheckpoint('s1', checkpoint())

    expect(await loadCheckpoint('s1')).toEqual(checkpoint())
  })

  it('没有检查点时返回 undefined，而不是抛错', async () => {
    expect(await loadCheckpoint('never-existed')).toBeUndefined()
  })

  it('删掉之后读不回来', async () => {
    await saveCheckpoint('s1', checkpoint())
    await deleteCheckpoint('s1')

    expect(await loadCheckpoint('s1')).toBeUndefined()
  })

  // 会话本来就没有检查点时删一次不该炸 —— 删除是每次删会话都会走的路
  it('删一个不存在的检查点是安全的', async () => {
    await expect(deleteCheckpoint('never-existed')).resolves.toBeUndefined()
  })

  /**
   * 它是个缓存，坏了只意味着下次重压一遍。
   * 在这里抛出去的话，一个写坏的文件会让整条会话再也发不出消息。
   */
  it('文件损坏时按「没有检查点」处理', async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 's1.compaction.json'), '{"contextEpoch": 1, "summ', 'utf8')

    expect(await loadCheckpoint('s1')).toBeUndefined()
  })

  /**
   * 半个 JSON 也能 parse 成功，字段却是 undefined。
   * 不逐字段校验的话，`cutIndex: undefined` 会一路传到切片逻辑里。
   */
  it('字段缺失或不合理的检查点一律作废', async () => {
    mkdirSync(DIR, { recursive: true })
    const write = (body: unknown): void =>
      writeFileSync(join(DIR, 's1.compaction.json'), JSON.stringify(body), 'utf8')

    write({ contextEpoch: 1, summary: 'x', sourceHash: 'a', createdAt: 1 }) // 缺 cutIndex
    expect(await loadCheckpoint('s1')).toBeUndefined()

    write({ ...checkpoint(), summary: '' }) // 空摘要等于没摘要
    expect(await loadCheckpoint('s1')).toBeUndefined()

    write({ ...checkpoint(), cutIndex: 0 }) // 切点为 0 表示什么都没被取代
    expect(await loadCheckpoint('s1')).toBeUndefined()
  })

  /**
   * sessionId 可能来自渲染层。检查点和 transcript 必须落在同一套清洗规则下 ——
   * 两边各写一份的话，一个带特殊字符的 id 会让它们落到两个名字下，谁也找不到谁。
   */
  it('带路径分隔符的 sessionId 不会写到会话目录之外', async () => {
    await saveCheckpoint('../../evil', checkpoint())

    expect(readFileSync(join(DIR, '______evil.compaction.json'), 'utf8')).toContain('contextEpoch')
    expect(await loadCheckpoint('../../evil')).toEqual(checkpoint())
  })
})

describe('hashMessages', () => {
  it('同一段历史得到同一个指纹', () => {
    const history = [msg('user', '你好'), msg('assistant', '你好')]

    expect(hashMessages(history)).toBe(hashMessages([...history]))
  })

  it('内容改了指纹就变 —— 这是「重新生成」之后作废检查点的依据', () => {
    expect(hashMessages([msg('user', '你好')])).not.toBe(hashMessages([msg('user', '你好啊')]))
  })

  /**
   * 长度必须进指纹。
   *
   * 不进的话，「在中间删掉一条、又在末尾补上一条一样的」这类改动会算出同一个
   * 指纹 —— 而那正是「重新生成」会产生的历史形状。
   */
  it('条数改了指纹就变', () => {
    expect(hashMessages([msg('user', 'a')])).not.toBe(
      hashMessages([msg('user', 'a'), msg('user', '')])
    )
  })

  it('空历史也算得出一个稳定的指纹', () => {
    expect(hashMessages([])).toBe(hashMessages([]))
  })
})

describe('promptCacheKey', () => {
  it('Beta 工具前缀变更纳入缓存键，全量模式仍保留原格式', () => {
    expect(promptCacheKey('s1', 0, 'material')).not.toBe(promptCacheKey('s1', 0, 'blueprint'))
    expect(promptCacheKey('s1', 0, 'material')).not.toBe(promptCacheKey('s1', 1, 'material'))
    expect(promptCacheKey('s1', 0, 'material')).not.toBe(promptCacheKey('s1', 0))
  })
  it('带上协议版本、业务会话 id 和上下文代数', () => {
    expect(promptCacheKey('s1', 3)).toBe(`agent-v3:${PROMPT_PROTOCOL_VERSION}:s1:e3`)
  })

  /**
   * 压缩换代 → 前缀变了 → 缓存键必须跟着换。
   * 不换的话等于让厂商拿一段对不上的缓存来比对。
   */
  it('代数变了键就变', () => {
    expect(promptCacheKey('s1', 0)).not.toBe(promptCacheKey('s1', 1))
  })

  /**
   * **不能复用业务 sessionId。**
   *
   * 那个是会话身份，界面、资产锁、审批、transcript 都认它。
   * 直接拿去当缓存键的话，「压缩了一次」就会变成「换了一条会话」。
   */
  it('不等于业务会话 id 本身', () => {
    expect(promptCacheKey('s1', 0)).not.toBe('s1')
    expect(promptCacheKey('s1', 0)).toContain('s1')
  })

  // 不同会话之间不能互相命中缓存
  it('不同会话的键不同', () => {
    expect(promptCacheKey('s1', 0)).not.toBe(promptCacheKey('s2', 0))
  })
})
