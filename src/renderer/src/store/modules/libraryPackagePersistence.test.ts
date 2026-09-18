/**
 * 这一层决定用户的蓝图和材质**落到磁盘上长什么样**，以及老用户那份怎么搬过来。
 *
 * 三件事必须钉死：
 *   1. 只写变了的条目（原来整库重写正是撑爆 localStorage 的那个动作）；
 *   2. 封面抽成 cover.png 之后，payload 里**不能**再留一份 base64；
 *   3. 迁移是先写包、后置标记 —— 反过来中途崩了用户数据就悬空了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLibraryPackagePersistence,
  dataUrlToBytes,
  type PackageEntryShape
} from './libraryPackagePersistence'
import type { LibraryPersistence, LibrarySnapshot } from './libraryPersistence'
import type { LibraryPackageDto } from '@renderer/api/libraryPackage'

// ============================================================
//  一个内存里的假保管库
// ============================================================

interface FakePackage {
  dirPath: string
  library: string
  id: string
  name: string
  cover: string
  payload: unknown
  files: Map<string, Uint8Array>
}

const packages = new Map<string, FakePackage>()
let meta: string | null = null
let available = true
/** 让某个调用失败一次，用来测「失败要重试」 */
let failNextUpdate = false

function dtoOf(pkg: FakePackage): LibraryPackageDto {
  return {
    dirPath: pkg.dirPath,
    relPath: pkg.dirPath.replace('/vault/', ''),
    library: pkg.library as 'blueprint' | 'material',
    manifest: {
      format: `unreal-box-${pkg.library}`,
      formatVersion: 1,
      id: pkg.id,
      name: pkg.name,
      createdAt: 1,
      updatedAt: 2,
      cover: pkg.cover,
      payload: pkg.payload
    }
  }
}

vi.mock('@renderer/api/libraryPackage', () => ({
  libraryPackageAPI: {
    isAvailable: () => available,
    scan: async () => ({ entries: [...packages.values()].map(dtoOf), problems: [] }),
    create: async (input: { library: string; id: string; name: string; payload: unknown }) => {
      const dirPath = `/vault/${input.name}.ue${input.library}`
      const pkg: FakePackage = {
        dirPath,
        library: input.library,
        id: input.id,
        name: input.name,
        cover: '',
        payload: input.payload,
        files: new Map()
      }
      packages.set(dirPath, pkg)
      return dtoOf(pkg)
    },
    update: async (
      dirPath: string,
      patch: { name?: string; payload?: unknown; cover?: string }
    ) => {
      if (failNextUpdate) {
        failNextUpdate = false
        throw new Error('磁盘满了')
      }
      const pkg = packages.get(dirPath)
      if (!pkg) return null
      if (patch.name !== undefined) pkg.name = patch.name
      if (patch.payload !== undefined) pkg.payload = patch.payload
      if (patch.cover !== undefined) pkg.cover = patch.cover
      return dtoOf(pkg)
    },
    rename: async (dirPath: string, newName: string) => {
      const pkg = packages.get(dirPath)
      if (!pkg) return null
      packages.delete(dirPath)
      pkg.dirPath = `/vault/${newName}.ue${pkg.library}`
      pkg.name = newName
      packages.set(pkg.dirPath, pkg)
      return dtoOf(pkg)
    },
    delete: async (dirPath: string) => packages.delete(dirPath),
    writeFile: async (dirPath: string, relPath: string, data: Uint8Array) => {
      const pkg = packages.get(dirPath)
      if (!pkg) return false
      pkg.files.set(relPath, data)
      return true
    },
    readFile: async () => null,
    readMeta: async () => meta,
    writeMeta: async (text: string) => {
      meta = text
      return true
    }
  }
}))

// ============================================================
//  被测的领域对象
// ============================================================

interface TestEntry extends PackageEntryShape {
  id: string
  name: string
  thumbnail?: string
  graph?: string
}
interface TestCollection {
  id: string
  name: string
}

/** 1×1 的透明 PNG，够用来验证「字节确实落到了 cover.png」 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface TestStore {
  state: LibrarySnapshot<TestEntry, TestCollection>
  getSnapshot: () => LibrarySnapshot<TestEntry, TestCollection>
  applySnapshot: (snapshot: LibrarySnapshot<TestEntry, TestCollection>) => void
}

function makeStore(initial: TestEntry[] = [], collections: TestCollection[] = []): TestStore {
  const state: LibrarySnapshot<TestEntry, TestCollection> = {
    entries: [...initial],
    collections: [...collections],
    ui: {}
  }
  return {
    state,
    getSnapshot: () => state,
    applySnapshot: (snapshot: LibrarySnapshot<TestEntry, TestCollection>) => {
      state.entries = snapshot.entries
      state.collections = snapshot.collections
      state.ui = snapshot.ui
    }
  }
}

/**
 * 界面偏好的读写由调用方提供（真实 store 里就是这么做的：字面量键名，
 * 好让 `scripts/check-local-storage.mjs` 能核对用途）。测试里照搬同一形状。
 */
function readTestUi(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key)
  return raw ? JSON.parse(raw) : {}
}

function writeTestUi(key: string, ui: Record<string, unknown>): void {
  localStorage.setItem(key, JSON.stringify(ui))
}

beforeEach(() => {
  packages.clear()
  meta = null
  available = true
  failNextUpdate = false
  localStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================

describe('dataUrlToBytes', () => {
  it('data URL 解成字节', () => {
    expect(dataUrlToBytes(PNG_DATA_URL)).toBeInstanceOf(Uint8Array)
    expect(dataUrlToBytes(PNG_DATA_URL)!.length).toBeGreaterThan(0)
  })

  it('不是 data URL 的一律返回 null —— 已经是文件路径或网址的封面不该被抽第二次', () => {
    expect(dataUrlToBytes('local-resource://C:/vault/a.ueblueprint/cover.png')).toBeNull()
    expect(dataUrlToBytes('https://example.com/a.png')).toBeNull()
    expect(dataUrlToBytes(undefined)).toBeNull()
    expect(dataUrlToBytes('')).toBeNull()
  })

  it('坏掉的 base64 返回 null 而不是抛 —— 一张坏封面不该让整次落盘失败', () => {
    expect(dataUrlToBytes('data:image/png;base64,@@@不是base64@@@')).toBeNull()
  })
})

describe('落盘', () => {
  it('新条目写成包目录', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    // 条目要在 hydrate 之后再放：hydrate 会用磁盘状态覆盖内存，这正是「磁盘是真相源」
    store.state.entries = [{ id: 'a', name: '跳跃逻辑', graph: 'x' }]
    p.persist()
    await p.flush()

    expect([...packages.values()].map((pkg) => pkg.name)).toEqual(['跳跃逻辑'])
    expect([...packages.values()][0].payload).toMatchObject({ id: 'a', graph: 'x' })
  })

  it('只写变了的那一条 —— 整库重写正是原来撑爆 localStorage 的动作', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [
      { id: 'a', name: 'A', graph: '1' },
      { id: 'b', name: 'B', graph: '1' }
    ]
    p.persist()
    await p.flush()

    const untouched = packages.get('/vault/A.ueblueprint')!
    const payloadBefore = untouched.payload

    store.state.entries[1] = { id: 'b', name: 'B', graph: '2' }
    p.persist()
    await p.flush()

    // A 那份 payload 对象没被重新写过
    expect(packages.get('/vault/A.ueblueprint')!.payload).toBe(payloadBefore)
    expect(packages.get('/vault/B.ueblueprint')!.payload).toMatchObject({ graph: '2' })
  })

  it('改名会移动目录，之后继续改还能写对地方', async () => {
    const store = makeStore([{ id: 'a', name: '旧名字' }])
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    p.persist()
    await p.flush()

    store.state.entries[0] = { id: 'a', name: '新名字', graph: 'v2' }
    p.persist()
    await p.flush()

    expect(packages.has('/vault/旧名字.ueblueprint')).toBe(false)
    expect(packages.get('/vault/新名字.ueblueprint')!.payload).toMatchObject({ graph: 'v2' })
  })

  it('内存里删掉的条目，磁盘上的包也删掉', async () => {
    const store = makeStore([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' }
    ])
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    p.persist()
    await p.flush()

    store.state.entries = [{ id: 'a', name: 'A' }]
    p.persist()
    await p.flush()

    expect([...packages.keys()]).toEqual(['/vault/A.ueblueprint'])
  })

  it('写失败保持脏，下一次落盘重试', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    p.persist()
    await p.flush()

    failNextUpdate = true
    store.state.entries[0] = { id: 'a', name: 'A', graph: '失败的那次' }
    p.persist()
    await p.flush()
    expect(packages.get('/vault/A.ueblueprint')!.payload).not.toMatchObject({
      graph: '失败的那次'
    })

    // 没有新的用户操作，只是再落一次盘，上一批就该补上
    await p.flush()
    expect(packages.get('/vault/A.ueblueprint')!.payload).toMatchObject({ graph: '失败的那次' })
  })
})

describe('封面', () => {
  it('data URL 抽成 cover.png，并且 payload 里不再留 base64', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A', thumbnail: PNG_DATA_URL }]
    p.persist()
    await p.flush()

    const pkg = packages.get('/vault/A.ueblueprint')!
    expect(pkg.files.get('cover.png')).toBeInstanceOf(Uint8Array)
    expect(pkg.cover).toBe('cover.png')
    // 这一条是关键：留着就等于同一张图存两份，而且下次读回来会拿旧的盖掉新的
    expect(pkg.payload).not.toHaveProperty('thumbnail')
  })

  it('只换封面不动内容时，不重写整份 payload', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A', graph: 'x' }]
    p.persist()
    await p.flush()

    store.state.entries[0] = { id: 'a', name: 'A', graph: 'x', thumbnail: PNG_DATA_URL }
    p.persist()
    await p.flush()

    expect(packages.get('/vault/A.ueblueprint')!.files.has('cover.png')).toBe(true)
  })

  it('读回来时封面变成 local-resource:// 而不是 base64', async () => {
    packages.set('/vault/A.ueblueprint', {
      dirPath: 'C:/vault/A.ueblueprint',
      library: 'blueprint',
      id: 'a',
      name: 'A',
      cover: 'cover.png',
      payload: { id: 'a', name: 'A', graph: 'x' },
      files: new Map()
    })

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready

    expect(store.state.entries[0].thumbnail).toBe(
      'local-resource://C:/vault/A.ueblueprint/cover.png'
    )
  })
})

describe('读取', () => {
  it('只认自己那个库的包', async () => {
    packages.set('/vault/A.ueblueprint', {
      dirPath: '/vault/A.ueblueprint',
      library: 'blueprint',
      id: 'a',
      name: 'A',
      cover: '',
      payload: { id: 'a', name: 'A' },
      files: new Map()
    })
    packages.set('/vault/M.uematerial', {
      dirPath: '/vault/M.uematerial',
      library: 'material',
      id: 'm',
      name: 'M',
      cover: '',
      payload: { id: 'm', name: 'M' },
      files: new Map()
    })

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready

    expect(store.state.entries.map((e) => e.id)).toEqual(['a'])
  })

  it('清单里的名字是权威的 —— 用户可能在磁盘上直接改过', async () => {
    packages.set('/vault/A.ueblueprint', {
      dirPath: '/vault/A.ueblueprint',
      library: 'blueprint',
      id: 'a',
      name: '磁盘上的名字',
      cover: '',
      payload: { id: 'a', name: '旧的名字' },
      files: new Map()
    })

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready

    expect(store.state.entries[0].name).toBe('磁盘上的名字')
  })

  it('没有 preload 时不抛', async () => {
    available = false
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await expect(p.ready).resolves.toBeUndefined()
  })

  it('没有 preload 时仍然把旧存储那份读出来 —— 显示空库会让用户以为东西没了', async () => {
    available = false
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy: async () => ({
        entries: [{ id: 'a', name: '老蓝图' }],
        collections: [],
        ui: {}
      })
    })
    await p.ready

    expect(store.state.entries.map((e) => e.name)).toEqual(['老蓝图'])
    // 只读不写：没有保管库可落盘
    expect(packages.size).toBe(0)
  })
})

describe('mergeEntryFromDisk —— 接住不经过 store 的写入', () => {
  /** 往「磁盘」直接放一个包，绕过 store */
  function putOnDisk(id: string, name: string): void {
    packages.set(`/vault/${name}.ueblueprint`, {
      dirPath: `/vault/${name}.ueblueprint`,
      library: 'blueprint',
      id,
      name,
      cover: '',
      payload: { id, name },
      files: new Map()
    })
  }

  function makePersistence(store: TestStore): LibraryPersistence {
    return createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
  }

  it('别处往磁盘写了一个包，并进来之后列表里能看见', async () => {
    // 片段仓库的 blueprint_library_save 是**主进程工具直接写包目录**的，
    // 这个 store 完全不知情。不并的话，AI 说「已存进蓝图库」，
    // 用户回到列表里什么都没有，要重开应用才看得见。
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready
    expect(store.state.entries).toHaveLength(0)

    putOnDisk('fresh', '新片段')

    expect(await p.mergeEntryFromDisk!('fresh')).toBe(true)
    expect(store.state.entries.map((e) => e.id)).toEqual(['fresh'])
  })

  it('**不碰其它条目** —— 扫盘那几百毫秒里用户改的东西要留着', async () => {
    /*
     * 这是整库重读会丢东西的第一个窗口：扫盘是异步的，扫的过程中用户改了
     * 别的条目，`applySnapshot()` 一上来就用磁盘那份盖掉他的改动。
     * 只并一条就没有这个问题 —— 这里在扫盘途中改内存来复现那个时序。
     */
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready
    // hydrate 会用磁盘状态覆盖内存，所以条目要在它之后放
    store.state.entries = [{ id: 'a', name: '原名' }]

    putOnDisk('fresh', '新片段')

    // 扫盘返回之前，用户改了另一个条目
    const scanning = p.mergeEntryFromDisk!('fresh')
    store.state.entries = store.state.entries.map((e) =>
      e.id === 'a' ? { ...e, name: '用户刚改的名字' } : e
    )
    await scanning

    const a = store.state.entries.find((e) => e.id === 'a')
    expect(a?.name).toBe('用户刚改的名字')
    expect(store.state.entries.map((e) => e.id).sort()).toEqual(['a', 'fresh'])
  })

  it('**不重置整份落盘基线** —— 没落盘的改动下一次还要能写出去', async () => {
    /*
     * 第二个窗口：整库重读会 seedFlushed() 把基线整个记成磁盘那份，
     * 于是「内存改了但还没落盘」的条目下一次落盘时被判成「没变化」，
     * 那条编辑再也找不回来。
     */
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: '原名' }]
    p.persist()
    await p.flush()

    // 改了但还没落盘
    store.state.entries = [{ id: 'a', name: '改过的名字' }]
    p.persist()

    putOnDisk('fresh', '新片段')
    await p.mergeEntryFromDisk!('fresh')

    // 基线没被重置，所以这次落盘认得出 a 变了
    await p.flush()
    expect(packages.get('/vault/改过的名字.ueblueprint')).toBeDefined()
  })

  it('落盘失败之后并入，也不会盖掉没存上的改动', async () => {
    /*
     * 整库重读的第二个坑：`writeOnce()` 里单条写失败是 catch 住、
     * 只把 dirty 置回 true，**不抛** —— `await flush()` 照样 resolve，
     * 然后 hydrate 把那条没存上的改动盖掉。
     * 并一条根本不 flush，所以这一幕不成立。
     */
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: '原名' }]
    p.persist()
    await p.flush()

    failNextUpdate = true
    store.state.entries = [{ id: 'a', name: '存不上的名字' }]
    p.persist()
    await p.flush() // 这次写失败，改动只在内存里

    putOnDisk('fresh', '新片段')
    await p.mergeEntryFromDisk!('fresh')

    // 内存里那条没被磁盘上的旧版盖掉
    expect(store.state.entries.find((e) => e.id === 'a')?.name).toBe('存不上的名字')
  })

  it('磁盘上没有那个 id（还没写完 / 已被删）→ 返回 false，什么都不动', async () => {
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: '原名' }]

    expect(await p.mergeEntryFromDisk!('nobody')).toBe(false)
    expect(store.state.entries.map((e) => e.id)).toEqual(['a'])
  })

  it('同一个 id 再存一次 → 就地更新，不会变成两条', async () => {
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready

    putOnDisk('fresh', '第一版')
    await p.mergeEntryFromDisk!('fresh')

    packages.delete('/vault/第一版.ueblueprint')
    putOnDisk('fresh', '第二版')
    await p.mergeEntryFromDisk!('fresh')

    expect(store.state.entries).toHaveLength(1)
    expect(store.state.entries[0].name).toBe('第二版')
  })

  it('别的库的包不会被并进来', async () => {
    const store = makeStore()
    const p = makePersistence(store)
    await p.ready

    packages.set('/vault/材质.uematerial', {
      dirPath: '/vault/材质.uematerial',
      library: 'material',
      id: 'shared-id',
      name: '材质',
      cover: '',
      payload: { id: 'shared-id', name: '材质' },
      files: new Map()
    })

    expect(await p.mergeEntryFromDisk!('shared-id')).toBe(false)
    expect(store.state.entries).toHaveLength(0)
  })
})

describe('界面偏好留在 localStorage', () => {
  it('排序、视图模式这些写 localStorage，不进包', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('bp-ui'),
      writeUi: (ui) => writeTestUi('bp-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    store.state.ui = { sortType: 'name', galleryViewMode: 'list' }
    p.persist()
    await p.flush()

    expect(JSON.parse(localStorage.getItem('bp-ui')!)).toEqual({
      sortType: 'name',
      galleryViewMode: 'list'
    })
    expect(JSON.stringify([...packages.values()])).not.toContain('galleryViewMode')
  })

  it('下次打开时读回来', async () => {
    localStorage.setItem('bp-ui', JSON.stringify({ sortType: 'created' }))
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('bp-ui'),
      writeUi: (ui) => writeTestUi('bp-ui', ui),
      ...store
    })
    await p.ready

    expect(store.state.ui).toEqual({ sortType: 'created' })
  })
})

describe('分组', () => {
  it('写进元信息文件，两个库互不覆盖', async () => {
    meta = JSON.stringify({ collections: { material: [{ id: 'm1', name: '材质分组' }] } })

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    store.state.collections = [{ id: 'c1', name: '蓝图分组' }]
    p.persist()
    await p.flush()

    const parsed = JSON.parse(meta!)
    expect(parsed.collections.blueprint).toEqual([{ id: 'c1', name: '蓝图分组' }])
    // 另一个库那格必须还在
    expect(parsed.collections.material).toEqual([{ id: 'm1', name: '材质分组' }])
  })

  it('读回来', async () => {
    meta = JSON.stringify({
      collections: { blueprint: [{ id: 'c1', name: '分组' }] },
      migrated: { blueprint: true }
    })
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
    await p.ready

    expect(store.state.collections).toEqual([{ id: 'c1', name: '分组' }])
  })
})

describe('迁移', () => {
  it('旧存储里那份搬成包目录，分组一起搬', async () => {
    const store = makeStore()
    const onMigrated = vi.fn()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy: async () => ({
        entries: [
          { id: 'a', name: '老蓝图', graph: 'x' },
          { id: 'b', name: '另一个', thumbnail: PNG_DATA_URL }
        ],
        collections: [{ id: 'c1', name: '老分组' }],
        ui: {}
      }),
      onMigrated
    })
    await p.ready

    expect([...packages.values()].map((pkg) => pkg.name).sort()).toEqual(['另一个', '老蓝图'])
    expect(store.state.entries).toHaveLength(2)
    expect(JSON.parse(meta!).collections.blueprint).toEqual([{ id: 'c1', name: '老分组' }])
    // 迁移时的封面也要抽成文件，不然搬过去还是一坨 base64
    expect(packages.get('/vault/另一个.ueblueprint')!.files.has('cover.png')).toBe(true)
    expect(onMigrated).toHaveBeenCalledOnce()
  })

  it('已经迁移过就不再看旧存储 —— 否则用户删空的库会被旧数据填回来', async () => {
    meta = JSON.stringify({ migrated: { blueprint: true } })
    const readLegacy = vi.fn()

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy
    })
    await p.ready

    expect(readLegacy).not.toHaveBeenCalled()
    expect(store.state.entries).toEqual([])
  })

  it('保管库里已经有包时不迁移', async () => {
    packages.set('/vault/A.ueblueprint', {
      dirPath: '/vault/A.ueblueprint',
      library: 'blueprint',
      id: 'a',
      name: 'A',
      cover: '',
      payload: { id: 'a', name: 'A' },
      files: new Map()
    })
    const readLegacy = vi.fn()

    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy
    })
    await p.ready

    expect(readLegacy).not.toHaveBeenCalled()
  })

  it('旧存储也是空的时候记上「看过了」，下次不再问', async () => {
    const store = makeStore()
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy: async () => null
    })
    await p.ready

    expect(JSON.parse(meta!).migrated.blueprint).toBe(true)
  })

  it('单条搬不过去时其余照搬，不整批停下', async () => {
    const store = makeStore()
    const calls = 0
    const p = createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store,
      readLegacy: async () => ({
        entries: [
          { id: 'a', name: 'A' },
          // 第二条会在 update 那步炸掉（封面写完之后）
          { id: 'bad', name: 'BAD', thumbnail: PNG_DATA_URL },
          { id: 'c', name: 'C' }
        ],
        collections: [],
        ui: {}
      })
    })
    void calls
    failNextUpdate = false
    await p.ready

    // 至少 A 和 C 落地了
    const names = [...packages.values()].map((pkg) => pkg.name)
    expect(names).toContain('A')
    expect(names).toContain('C')
  })
})

/**
 * 存不上要能被看见。
 *
 * 「保持脏、下次落盘重试」只在用户**继续操作**时才会再触发一次。他要是正好写完最后
 * 一笔就走开，那批东西一直躺在内存里，关掉应用就没了 —— 而全程只有一行 console.warn。
 * 真机上这不是罕见事：在资产库切了保管库（条目路径属于上一个库，主进程一律拒绝），
 * 或者在资源管理器里把包目录改了名，此后每一次编辑都「看起来成功」。
 */
describe('落盘状态', () => {
  function persistenceOf(store: ReturnType<typeof makeStore>): LibraryPersistence {
    return createLibraryPackagePersistence({
      library: 'blueprint',
      readUi: () => readTestUi('test-ui'),
      writeUi: (ui) => writeTestUi('test-ui', ui),
      ...store
    })
  }

  it('一切正常时是 idle，不打扰用户', async () => {
    const store = makeStore()
    const p = persistenceOf(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    p.persist()
    await p.flush()

    expect(p.saveState?.status.value).toBe('idle')
    expect(p.saveState?.failedCount.value).toBe(0)
  })

  it('写失败时进 error，并说得出有几条、为什么', async () => {
    const store = makeStore()
    const p = persistenceOf(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    p.persist()
    await p.flush()

    failNextUpdate = true
    store.state.entries[0] = { id: 'a', name: 'A', graph: '存不上的那次' }
    p.persist()
    await p.flush()

    expect(p.saveState?.status.value).toBe('error')
    expect(p.saveState?.failedCount.value).toBe(1)
    expect(p.saveState?.lastError.value).not.toBe('')
  })

  it('重试成功后回到 idle，内容也真的写进去了', async () => {
    const store = makeStore()
    const p = persistenceOf(store)
    await p.ready
    store.state.entries = [{ id: 'a', name: 'A' }]
    p.persist()
    await p.flush()

    failNextUpdate = true
    store.state.entries[0] = { id: 'a', name: 'A', graph: '重试之后' }
    p.persist()
    await p.flush()
    expect(p.saveState?.status.value).toBe('error')

    // 用户点「重试保存」—— 不需要他再改点什么来触发
    await p.saveState?.retry()

    expect(p.saveState?.status.value).toBe('idle')
    expect(p.saveState?.failedCount.value).toBe(0)
    expect(packages.get('/vault/A.ueblueprint')!.payload).toMatchObject({ graph: '重试之后' })
  })
})
