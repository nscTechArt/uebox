/**
 * @vitest-environment node
 *
 * 搬迁账本。守四件事：
 *   1. 写读一致 —— 落盘的 JSON 原样读回，路径规范化过，不留 .tmp
 *   2. 工程 key 稳定且不撞 —— 大小写 / 斜杠不同的同一个工程一个目录；相近的两个工程两个目录
 *   3. 保留期 —— 按份数、按天数裁，时间解析不了退回文件 mtime
 *   4. id 不能穿越 —— `../` 之类的 id 读不到账本目录之外的东西
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'organize-ledger-'))

vi.mock('electron', () => ({ app: { getPath: (): string => root } }))

import {
  entriesFromItems,
  ledgerDir,
  ledgerRoot,
  listLedgers,
  projectKey,
  pruneLedgers,
  readLedger,
  recordMoveLedger,
  type LedgerEntry
} from './ledger'

const PROJECT = 'D:\\Projects\\Demo\\Demo.uproject'
const DAY = 24 * 60 * 60 * 1000

const entry = (from: string, to: string, fingerprint = true): LedgerEntry => ({
  from,
  to,
  status: 'moved',
  auto_renamed: false,
  ...(fingerprint
    ? { fingerprint: { file: `C:/x/${to}.uasset`, bytes: 100, mtime: '2026-09-03T06:00:00.000Z' } }
    : {})
})

/** 直接往目录里放一份账本文件，绕开 recordMoveLedger 的裁剪 */
async function seedFile(dir: string, id: string, createdAt: string | undefined): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.json`)
  const body =
    createdAt === undefined
      ? '{not json'
      : JSON.stringify({
          version: 1,
          id,
          created_at: createdAt,
          project: 'p',
          project_key: 'k',
          tool: 'ue_content_move',
          args_summary: {},
          saved: true,
          entries: [],
          irreversible: [],
          reversible: false,
          notes: []
        })
  await fs.writeFile(path, body, 'utf8')
  return path
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(join(root, 'organize-ledger'), { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectKey', () => {
  it('同一个工程不同写法 → 同一个 key', () => {
    expect(projectKey('D:\\Projects\\Demo\\Demo.uproject')).toBe(
      projectKey('d:/projects/demo/demo.uproject/')
    )
  })

  it('只差一个会被替换成 _ 的字符的两个工程 → 不同 key', () => {
    expect(projectKey('d:/projects/demo/demo.uproject')).not.toBe(
      projectKey('d:/projects/demo/demo_uproject')
    )
  })

  it('前 80 个字符相同的两个工程 → 不同 key，且 key 是文件名安全的', () => {
    const prefix = 'd:/' + 'a'.repeat(90)
    const a = projectKey(`${prefix}/one.uproject`)
    const b = projectKey(`${prefix}/two.uproject`)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z0-9_-]+$/)
    expect(a.length).toBeLessThanOrEqual(80 + 1 + 8)
  })
})

describe('recordMoveLedger / readLedger', () => {
  it('写完能原样读回，工程路径规范化，不留 .tmp', async () => {
    const ledger = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_move',
      args_summary: { on_conflict: 'fail', fixup_redirectors: true, save: true },
      saved: true,
      entries: [entry('/Game/Temp/rock', '/Game/Props/SM_Rock')]
    })

    expect(ledger.version).toBe(1)
    expect(ledger.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-move-[0-9a-f]{4}$/)
    expect(ledger.project).toBe('d:/projects/demo/demo.uproject')
    expect(ledger.project_key).toBe(projectKey(PROJECT))
    expect(ledger.reversible).toBe(true)
    expect(ledger.irreversible).toEqual([])
    expect(ledger.notes).toEqual([])

    expect(ledgerRoot()).toBe(join(root, 'organize-ledger'))
    const dir = ledgerDir(ledger.project_key)
    const files = await fs.readdir(dir)
    expect(files).toEqual([`${ledger.id}.json`])

    expect(await readLedger(PROJECT, ledger.id)).toEqual(ledger)
    // 换一种写法的同一个工程也读得到
    expect(await readLedger('d:/projects/demo/demo.uproject', ledger.id)).toEqual(ledger)
  })

  it('回滚工具写的账本 id 带 rollback，不和搬迁账本混', async () => {
    const ledger = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_rollback',
      args_summary: { rollback_of: 'x' },
      saved: true,
      entries: [entry('/Game/A', '/Game/B')]
    })
    expect(ledger.id).toContain('-rollback-')
  })

  it('save=false → reversible=false；有 irreversible → false；没有条目 → false', async () => {
    const unsaved = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_move',
      args_summary: { save: false },
      saved: false,
      entries: [entry('/Game/A', '/Game/B', false)]
    })
    expect(unsaved.reversible).toBe(false)

    const irreversible = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      entries: [entry('/Game/A', '/Game/B')],
      irreversible: [{ kind: 'redirector_deleted', path: '/Game/Old', note: '删了' }]
    })
    expect(irreversible.reversible).toBe(false)

    const empty = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      entries: []
    })
    expect(empty.reversible).toBe(false)
  })

  it('id 带 ../ 读不到账本目录之外的文件', async () => {
    await seedFile(join(root, 'organize-ledger'), 'outside', '2026-09-01T00:00:00.000Z')
    expect(await readLedger(PROJECT, '../outside')).toBeUndefined()
    expect(await readLedger(PROJECT, '..\\outside')).toBeUndefined()
    expect(await readLedger(PROJECT, 'outside/../../outside')).toBeUndefined()
    expect(await readLedger(PROJECT, 'does-not-exist')).toBeUndefined()
  })

  it('写坏的文件读成 undefined，不炸', async () => {
    const dir = ledgerDir(projectKey(PROJECT))
    await seedFile(dir, 'broken', undefined)
    expect(await readLedger(PROJECT, 'broken')).toBeUndefined()
    expect(await listLedgers(PROJECT)).toEqual([])
  })
})

describe('listLedgers', () => {
  it('新的在前，带条数，limit 生效', async () => {
    vi.useFakeTimers()
    const ids: string[] = []
    for (const [i, at] of [
      '2026-09-01T01:00:00Z',
      '2026-09-02T01:00:00Z',
      '2026-09-03T01:00:00Z'
    ].entries()) {
      vi.setSystemTime(new Date(at))
      const ledger = await recordMoveLedger({
        projectPath: PROJECT,
        tool: 'ue_content_move',
        args_summary: {},
        saved: i !== 1,
        entries: Array.from({ length: i + 1 }, (_, k) =>
          entry(`/Game/A${k}`, `/Game/B${k}`, i !== 1)
        )
      })
      ids.push(ledger.id)
    }

    const all = await listLedgers(PROJECT)
    expect(all.map((l) => l.id)).toEqual([ids[2], ids[1], ids[0]])
    expect(all.map((l) => l.count)).toEqual([3, 2, 1])
    expect(all.map((l) => l.saved)).toEqual([true, false, true])
    expect(all.map((l) => l.reversible)).toEqual([true, false, true])
    expect(all[0].tool).toBe('ue_content_move')

    expect((await listLedgers(PROJECT, 2)).map((l) => l.id)).toEqual([ids[2], ids[1]])
    expect(await listLedgers('d:/other/other.uproject')).toEqual([])
  })
})

describe('pruneLedgers', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')

  it('按份数裁，留最新的', async () => {
    const dir = join(root, 'organize-ledger', 'prune-count')
    for (let i = 1; i <= 5; i += 1) {
      await seedFile(dir, `l${i}`, new Date(now - i * DAY).toISOString())
    }
    const deleted = await pruneLedgers(dir, { maxCount: 3, maxAgeDays: 365, now })
    expect(deleted.sort()).toEqual(['l4.json', 'l5.json'])
    expect((await fs.readdir(dir)).sort()).toEqual(['l1.json', 'l2.json', 'l3.json'])
  })

  it('按天数裁', async () => {
    const dir = join(root, 'organize-ledger', 'prune-age')
    await seedFile(dir, 'fresh', new Date(now - 1 * DAY).toISOString())
    await seedFile(dir, 'edge', new Date(now - 29 * DAY).toISOString())
    await seedFile(dir, 'old', new Date(now - 40 * DAY).toISOString())
    const deleted = await pruneLedgers(dir, { maxCount: 200, maxAgeDays: 30, now })
    expect(deleted).toEqual(['old.json'])
  })

  it('created_at 解析不了退回文件 mtime', async () => {
    const dir = join(root, 'organize-ledger', 'prune-mtime')
    const broken = await seedFile(dir, 'broken', undefined)
    const old = new Date(now - 60 * DAY)
    await fs.utimes(broken, old, old)
    await seedFile(dir, 'fresh', new Date(now).toISOString())
    const deleted = await pruneLedgers(dir, { maxCount: 200, maxAgeDays: 30, now })
    expect(deleted).toEqual(['broken.json'])
  })

  it('不存在的目录 → 什么都不删也不抛', async () => {
    expect(await pruneLedgers(join(root, 'nope'), { maxCount: 1, maxAgeDays: 1, now })).toEqual([])
  })

  it('recordMoveLedger 写完顺手裁掉过期的', async () => {
    const dir = ledgerDir(projectKey(PROJECT))
    await seedFile(dir, 'ancient', new Date(Date.now() - 45 * DAY).toISOString())
    const ledger = await recordMoveLedger({
      projectPath: PROJECT,
      tool: 'ue_content_move',
      args_summary: {},
      saved: true,
      entries: [entry('/Game/A', '/Game/B')]
    })
    expect((await fs.readdir(dir)).sort()).toEqual([`${ledger.id}.json`])
  })
})

describe('entriesFromItems', () => {
  it('只收 moved；三个指纹字段齐了才记指纹', () => {
    const entries = entriesFromItems([
      {
        source: '/Game/A',
        destination: '/Game/X/A',
        referencers: 0,
        status: 'moved',
        file: 'C:/p/A.uasset',
        bytes: 10,
        mtime: '2026-09-03T00:00:00Z'
      },
      {
        source: '/Game/B',
        destination: '/Game/X/B_1',
        referencers: 2,
        status: 'moved',
        auto_renamed: true,
        file: 'C:/p/B_1.uasset',
        bytes: 20
      },
      { source: '/Game/C', destination: '/Game/X/C', referencers: 0, status: 'failed', error: 'x' },
      { source: '/Game/D', destination: '/Game/X/D', referencers: 0, status: 'planned' },
      { source: '/Game/E', destination: '/Game/X/E', referencers: 0, status: 'skipped' }
    ])
    expect(entries).toEqual([
      {
        from: '/Game/A',
        to: '/Game/X/A',
        status: 'moved',
        auto_renamed: false,
        fingerprint: { file: 'C:/p/A.uasset', bytes: 10, mtime: '2026-09-03T00:00:00Z' }
      },
      { from: '/Game/B', to: '/Game/X/B_1', status: 'moved', auto_renamed: true }
    ])
  })

  it('moved 但没有 destination 的条目不记（没法反向）', () => {
    expect(entriesFromItems([{ source: '/Game/A', referencers: 0, status: 'moved' }])).toEqual([])
  })
})
