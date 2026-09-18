import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLibraryRecords,
  createLibraryPersistence,
  diffLibraryRecords,
  type LibraryPersistence,
  type LibrarySnapshot
} from './libraryPersistence'
import type { LibraryStoreRecord, LibraryStoreSnapshot } from '@renderer/api/libraryStore'

interface TestEntry {
  id: string
  name: string
}
interface TestCollection {
  id: string
  name: string
}

function snapshotOf(
  entries: TestEntry[],
  collections: TestCollection[] = [],
  ui: Record<string, unknown> = {}
): LibrarySnapshot<TestEntry, TestCollection> {
  return { entries, collections, ui }
}

function fingerprints(records: LibraryStoreRecord[]): Map<string, string> {
  return diffLibraryRecords(new Map(), records).next
}

describe('diffLibraryRecords', () => {
  it('第一次落盘把所有行都算成新增', () => {
    const records = buildLibraryRecords(snapshotOf([{ id: 'a', name: 'A' }]))

    const diff = diffLibraryRecords(new Map(), records)

    expect(diff.upserts.map((item) => item.id)).toEqual(['a'])
    expect(diff.deletes).toEqual([])
  })

  // 这是「不再整库重写」的核心：改一条只发一条，而不是把几十兆图表重新序列化一遍
  it('只有变了的那一行被发出去', () => {
    const before = buildLibraryRecords(
      snapshotOf([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ])
    )
    const after = buildLibraryRecords(
      snapshotOf([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B2' }
      ])
    )

    const diff = diffLibraryRecords(fingerprints(before), after)

    expect(diff.upserts.map((item) => item.id)).toEqual(['b'])
    expect(diff.deletes).toEqual([])
  })

  it('内容没变但顺序变了也要重写', () => {
    const before = buildLibraryRecords(
      snapshotOf([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ])
    )
    const after = buildLibraryRecords(
      snapshotOf([
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A' }
      ])
    )

    const diff = diffLibraryRecords(fingerprints(before), after)

    expect(diff.upserts.map((item) => item.id).sort()).toEqual(['a', 'b'])
  })

  it('消失的行变成删除，条目和分组分开算', () => {
    const before = buildLibraryRecords(
      snapshotOf([{ id: 'a', name: 'A' }], [{ id: 'col-1', name: 'C' }])
    )
    const after = buildLibraryRecords(snapshotOf([], []))

    const diff = diffLibraryRecords(fingerprints(before), after)

    expect(diff.upserts).toEqual([])
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { kind: 'entry', id: 'a' },
        { kind: 'collection', id: 'col-1' }
      ])
    )
  })

  // 条目和分组可能撞 id（都是用户数据），键必须带上 kind 才不会互相顶掉
  it('条目和分组同 id 时互不干扰', () => {
    const records = buildLibraryRecords(
      snapshotOf([{ id: 'x', name: '条目' }], [{ id: 'x', name: '分组' }])
    )

    const diff = diffLibraryRecords(new Map(), records)

    expect(diff.upserts).toHaveLength(2)
    expect(diff.next.size).toBe(2)
  })
})

describe('createLibraryPersistence', () => {
  let invoke: ReturnType<typeof vi.fn>
  let stored: LibraryStoreSnapshot

  function stubApi(): void {
    invoke = vi.fn(async (channel: string, _library: string, payload: unknown) => {
      if (channel === 'library-store:load') return stored
      if (channel === 'library-store:save') return undefined
      if (channel === 'library-store:migrate') {
        if (stored.migratedFromLocal) return false
        const migrate = payload as { records: LibraryStoreRecord[]; ui: string }
        stored = { records: migrate.records, ui: migrate.ui, migratedFromLocal: true }
        return true
      }
      return undefined
    })
    vi.stubGlobal('api', { invoke })
  }

  beforeEach(() => {
    localStorage.clear()
    stored = { records: [], ui: null, migratedFromLocal: false }
    stubApi()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function create(state: {
    entries: TestEntry[]
    collections: TestCollection[]
    ui: Record<string, unknown>
  }): LibraryPersistence {
    return createLibraryPersistence<TestEntry, TestCollection>({
      library: 'blueprint',
      legacyKey: 'test-legacy-key',
      parseLegacy: (raw) => ({
        entries: (raw.blueprints as TestEntry[]) || [],
        collections: (raw.collections as TestCollection[]) || [],
        ui: { sortType: raw.sortType }
      }),
      getSnapshot: () => ({
        entries: state.entries,
        collections: state.collections,
        ui: state.ui
      }),
      applySnapshot: (snapshot) => {
        state.entries = snapshot.entries
        state.collections = snapshot.collections
        state.ui = snapshot.ui
      }
    })
  }

  it('从 SQLite 读出已存的条目和界面偏好', async () => {
    stored = {
      records: [{ kind: 'entry', id: 'a', data: '{"id":"a","name":"A"}', sortIndex: 0 }],
      ui: '{"sortType":"name"}',
      migratedFromLocal: true
    }
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    await create(state).ready

    expect(state.entries).toEqual([{ id: 'a', name: 'A' }])
    expect(state.ui).toEqual({ sortType: 'name' })
  })

  it('坏掉的单条记录被跳过，不连累整个库', async () => {
    stored = {
      records: [
        { kind: 'entry', id: 'bad', data: '{不是 JSON', sortIndex: 0 },
        { kind: 'entry', id: 'ok', data: '{"id":"ok","name":"OK"}', sortIndex: 1 }
      ],
      ui: null,
      migratedFromLocal: true
    }
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    await create(state).ready

    expect(state.entries).toEqual([{ id: 'ok', name: 'OK' }])
  })

  // 老用户升级：localStorage 里那份要原样搬进 SQLite，搬完才删
  it('首次启动把 localStorage 里的旧数据迁进来并删掉旧键', async () => {
    localStorage.setItem(
      'test-legacy-key',
      JSON.stringify({ blueprints: [{ id: 'old', name: '老蓝图' }], sortType: 'created' })
    )
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    await create(state).ready

    expect(state.entries).toEqual([{ id: 'old', name: '老蓝图' }])
    expect(state.ui).toEqual({ sortType: 'created' })
    expect(stored.migratedFromLocal).toBe(true)
    expect(localStorage.getItem('test-legacy-key')).toBeNull()
  })

  // 迁移没落库就删 localStorage，等于数据两头都没有
  it('迁移失败时不删 localStorage', async () => {
    localStorage.setItem(
      'test-legacy-key',
      JSON.stringify({ blueprints: [{ id: 'old', name: '老蓝图' }] })
    )
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'library-store:load') return stored
      if (channel === 'library-store:migrate') throw new Error('IPC 挂了')
      return undefined
    })
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    await create(state).ready

    expect(localStorage.getItem('test-legacy-key')).not.toBeNull()
  })

  it('已经迁移过就不再看 localStorage', async () => {
    stored = { records: [], ui: null, migratedFromLocal: true }
    localStorage.setItem(
      'test-legacy-key',
      JSON.stringify({ blueprints: [{ id: 'old', name: '不该出现' }] })
    )
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    await create(state).ready

    expect(state.entries).toEqual([])
    expect(localStorage.getItem('test-legacy-key')).not.toBeNull()
  })

  it('落盘只发变动的行', async () => {
    stored = {
      records: [
        { kind: 'entry', id: 'a', data: '{"id":"a","name":"A"}', sortIndex: 0 },
        { kind: 'entry', id: 'b', data: '{"id":"b","name":"B"}', sortIndex: 1 }
      ],
      ui: '{}',
      migratedFromLocal: true
    }
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }
    const persistence = create(state)
    await persistence.ready

    state.entries[1].name = 'B2'
    persistence.persist()
    await persistence.flush()

    const savePayload = invoke.mock.calls.find((call) => call[0] === 'library-store:save')?.[2] as {
      upserts: LibraryStoreRecord[]
      deletes: unknown[]
    }
    expect(savePayload.upserts.map((item) => item.id)).toEqual(['b'])
    expect(savePayload.deletes).toEqual([])
  })

  // 存盘失败不能把用户的操作带走，但也不能把这次改动悄悄丢掉
  it('落盘失败时下一次会把这批行重试一遍', async () => {
    stored = { records: [], ui: '{}', migratedFromLocal: true }
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }
    const persistence = create(state)
    await persistence.ready

    state.entries.push({ id: 'a', name: 'A' })
    invoke.mockImplementationOnce(async () => {
      throw new Error('IPC 挂了')
    })
    persistence.persist()
    await expect(persistence.flush()).resolves.toBeUndefined()

    await persistence.flush()

    const saves = invoke.mock.calls.filter((call) => call[0] === 'library-store:save')
    expect(saves).toHaveLength(2)
    expect(
      (saves[1][2] as { upserts: LibraryStoreRecord[] }).upserts.map((item) => item.id)
    ).toEqual(['a'])
  })

  it('没有 preload 时退回读 localStorage，且不写库', async () => {
    vi.unstubAllGlobals()
    localStorage.setItem(
      'test-legacy-key',
      JSON.stringify({ blueprints: [{ id: 'old', name: '老蓝图' }] })
    )
    const state = { entries: [] as TestEntry[], collections: [] as TestCollection[], ui: {} }

    const persistence = create(state)
    await persistence.ready

    expect(state.entries).toEqual([{ id: 'old', name: '老蓝图' }])
    // 没落库就不能删旧数据
    expect(localStorage.getItem('test-legacy-key')).not.toBeNull()
    await expect(persistence.flush()).resolves.toBeUndefined()
  })
})
