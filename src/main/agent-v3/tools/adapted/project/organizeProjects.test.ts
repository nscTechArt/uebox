/**
 * @vitest-environment node
 *
 * 工程库的分组和置顶。
 *
 * 最要紧的四条：一个工程可以同时在多个合集里（加进 B 不会把它从 A 踢出来）、
 * 解散合集不删工程、不回读校验就不许报成功、认不准的工程整批不动。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAllProjects,
  getProjectByKey,
  updateProject,
  assignProjectToCollection,
  clearProjectsOfCollection,
  createProjectCollection,
  deleteProjectCollectionByKey,
  getAllProjectCollections,
  getProjectCollectionByKey,
  getProjectsByCollectionKey,
  getCollectionKeysOfProject,
  isProjectInCollection,
  removeProjectFromCollection,
  updateProjectCollection,
  send
} = vi.hoisted(() => ({
  getAllProjects: vi.fn(),
  getProjectByKey: vi.fn(),
  updateProject: vi.fn(),
  assignProjectToCollection: vi.fn(),
  clearProjectsOfCollection: vi.fn(),
  createProjectCollection: vi.fn(),
  deleteProjectCollectionByKey: vi.fn(),
  getAllProjectCollections: vi.fn(),
  getProjectCollectionByKey: vi.fn(),
  getProjectsByCollectionKey: vi.fn(),
  getCollectionKeysOfProject: vi.fn(),
  isProjectInCollection: vi.fn(),
  removeProjectFromCollection: vi.fn(),
  updateProjectCollection: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../../../../sqliteDataBase/models/project', () => ({
  getAllProjects,
  getProjectByKey,
  updateProject
}))
vi.mock('../../../../sqliteDataBase/models/projectCollection', () => ({
  assignProjectToCollection,
  clearProjectsOfCollection,
  createProjectCollection,
  deleteProjectCollectionByKey,
  getAllProjectCollections,
  getProjectCollectionByKey,
  getProjectsByCollectionKey,
  getCollectionKeysOfProject,
  isProjectInCollection,
  removeProjectFromCollection,
  updateProjectCollection
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))

import { createOrganizeProjectsTool } from './organizeProjects'

const tool = createOrganizeProjectsTool()
const call = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

interface FakeProject {
  projectKey: string
  projectName: string
  EngineAssociation: string
  isPinned: number
}
interface FakeCollection {
  collectionKey: string
  name: string | null
  isPinned: number
}

let projects: FakeProject[]
let collections: FakeCollection[]
/** 成员关系：`${projectKey}|${collectionKey}`，一个工程可以有好几条 */
let members: Set<string>

const memberKey = (projectKey: string, collectionKey: string): string =>
  `${projectKey}|${collectionKey}`
const collectionsOf = (projectKey: string): string[] =>
  [...members].filter((m) => m.startsWith(`${projectKey}|`)).map((m) => m.split('|')[1])

beforeEach(() => {
  projects = [
    {
      projectKey: 'p-a',
      projectName: 'AlphaGame',
      EngineAssociation: '5.5',
      isPinned: 0
    },
    {
      projectKey: 'p-b',
      projectName: 'BetaGame',
      EngineAssociation: '5.5',
      isPinned: 0
    },
    {
      projectKey: 'p-c',
      projectName: 'GammaGame',
      EngineAssociation: '5.4',
      isPinned: 1
    }
  ]
  collections = [{ collectionKey: 'collection_old', name: '旧分组', isPinned: 0 }]
  members = new Set([memberKey('p-b', 'collection_old')])

  getAllProjects.mockReset().mockImplementation(() => projects.map((p) => ({ ...p })))
  getProjectByKey.mockReset().mockImplementation((_db: unknown, key: string) => {
    const hit = projects.find((p) => p.projectKey === key)
    return hit ? { ...hit } : undefined
  })
  updateProject
    .mockReset()
    .mockImplementation((_db: unknown, key: string, updates: { isPinned?: number }) => {
      const hit = projects.find((p) => p.projectKey === key)
      if (!hit) return false
      if (updates.isPinned !== undefined) hit.isPinned = updates.isPinned
      return true
    })

  assignProjectToCollection
    .mockReset()
    .mockImplementation((_db: unknown, projectKey: string, collectionKey: string) => {
      const hit = projects.find((p) => p.projectKey === projectKey)
      if (!hit) return false
      members.add(memberKey(projectKey, collectionKey))
      return true
    })
  isProjectInCollection
    .mockReset()
    .mockImplementation((_db: unknown, projectKey: string, collectionKey: string) =>
      members.has(memberKey(projectKey, collectionKey))
    )
  getCollectionKeysOfProject
    .mockReset()
    .mockImplementation((_db: unknown, projectKey: string) => collectionsOf(projectKey))
  removeProjectFromCollection
    .mockReset()
    .mockImplementation((_db: unknown, projectKey: string, collectionKey?: string | null) => {
      const doomed = collectionKey
        ? [memberKey(projectKey, collectionKey)].filter((m) => members.has(m))
        : [...members].filter((m) => m.startsWith(`${projectKey}|`))
      for (const m of doomed) members.delete(m)
      return doomed.length > 0
    })
  clearProjectsOfCollection.mockReset().mockImplementation((_db: unknown, key: string) => {
    const doomed = [...members].filter((m) => m.endsWith(`|${key}`))
    for (const m of doomed) members.delete(m)
    return doomed.length
  })
  createProjectCollection
    .mockReset()
    .mockImplementation((_db: unknown, record: { collectionKey: string; name?: string | null }) => {
      collections.push({
        collectionKey: record.collectionKey,
        name: record.name ?? null,
        isPinned: 0
      })
      return collections.length
    })
  deleteProjectCollectionByKey.mockReset().mockImplementation((_db: unknown, key: string) => {
    const before = collections.length
    collections = collections.filter((c) => c.collectionKey !== key)
    return collections.length < before
  })
  getAllProjectCollections.mockReset().mockImplementation(() => collections.map((c) => ({ ...c })))
  getProjectCollectionByKey.mockReset().mockImplementation((_db: unknown, key: string) => {
    const hit = collections.find((c) => c.collectionKey === key)
    return hit ? { ...hit } : undefined
  })
  getProjectsByCollectionKey
    .mockReset()
    .mockImplementation((_db: unknown, key: string) =>
      projects.filter((p) => members.has(memberKey(p.projectKey, key))).map((p) => ({ ...p }))
    )
  updateProjectCollection
    .mockReset()
    .mockImplementation(
      (_db: unknown, key: string, updates: { name?: string; isPinned?: number }) => {
        const hit = collections.find((c) => c.collectionKey === key)
        if (!hit) return false
        if (updates.name !== undefined) hit.name = updates.name
        if (updates.isPinned !== undefined) hit.isPinned = updates.isPinned
        return true
      }
    )
  send.mockReset()
})

describe('group_projects', () => {
  it('合集不存在就顺手建，并把工程放进去', async () => {
    const res = await call({
      action: 'group_projects',
      collection: 'UE 5.5',
      projects: ['p-a', 'AlphaGame', 'BetaGame'] // 同一个工程给两种写法，去重
    })

    expect(res.success).toBe(true)
    expect(res.created).toBe(true)
    expect(res.moved_count).toBe(2)

    const created = collections.find((c) => c.name === 'UE 5.5')
    expect(created).toBeDefined()
    expect(created!.collectionKey.startsWith('collection_')).toBe(true)
    expect(collectionsOf('p-a')).toEqual([created!.collectionKey])
    expect(send).toHaveBeenCalledWith('db:project:library-changed')
  })

  it('加进新合集不会把工程从原来的合集里踢出来', async () => {
    const res = await call({ action: 'group_projects', collection: 'UE 5.5', projects: ['p-b'] })

    const results = res.results as Array<Record<string, unknown>>
    expect(results[0].status).toBe('moved')
    const created = collections.find((c) => c.name === 'UE 5.5')!
    expect(collectionsOf('p-b').sort()).toEqual(['collection_old', created.collectionKey].sort())
    expect(String(res.message)).toContain('可以同时属于多个合集')
  })

  it('已经在这个合集里的工程算 unchanged，不重复写', async () => {
    const res = await call({ action: 'group_projects', collection: '旧分组', projects: ['p-b'] })

    expect(res.success).toBe(true)
    expect(res.created).toBe(false)
    expect(res.moved_count).toBe(0)
    expect((res.results as Array<Record<string, unknown>>)[0].status).toBe('unchanged')
    expect(assignProjectToCollection).not.toHaveBeenCalled()
  })

  it('只建一个空合集也行 —— 界面上用户自己就能这么干', async () => {
    const res = await call({ action: 'group_projects', collection: '空的', projects: [] })

    expect(res.success).toBe(true)
    expect(res.created).toBe(true)
    expect(collections.find((c) => c.name === '空的')).toBeDefined()
    expect(assignProjectToCollection).not.toHaveBeenCalled()
  })

  it('有一个工程认不准就整批不动', async () => {
    const res = await call({
      action: 'group_projects',
      collection: 'UE 5.5',
      projects: ['p-a', '不存在的工程']
    })

    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('不存在的工程')
    expect(createProjectCollection).not.toHaveBeenCalled()
    expect(assignProjectToCollection).not.toHaveBeenCalled()
    expect(collectionsOf('p-a')).toEqual([])
  })

  it('给了一个查不到的 collectionKey 就报错，不拿它当新合集的名字', async () => {
    const res = await call({
      action: 'group_projects',
      collection: 'collection_typo',
      projects: ['p-a']
    })

    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('collection_typo')
    expect(createProjectCollection).not.toHaveBeenCalled()
  })

  it('重名合集不自己挑，列出候选让人决定', async () => {
    collections.push({ collectionKey: 'collection_dup', name: '旧分组', isPinned: 0 })

    const res = await call({ action: 'group_projects', collection: '旧分组', projects: ['p-a'] })

    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('collection_dup')
    expect(assignProjectToCollection).not.toHaveBeenCalled()
  })

  it('写完回读发现没进去，就报 unconfirmed 而不是成功', async () => {
    assignProjectToCollection.mockImplementation(() => true) // 假装写成功，实际什么都没改

    const res = await call({ action: 'group_projects', collection: 'UE 5.5', projects: ['p-a'] })

    expect(res.success).toBe(false)
    expect((res.results as Array<Record<string, unknown>>)[0].status).toBe('unconfirmed')
  })
})

describe('ungroup_projects', () => {
  it('不点名合集就是从所有合集里移出去，工程还在库里', async () => {
    members.add(memberKey('p-b', 'collection_other'))
    collections.push({ collectionKey: 'collection_other', name: '另一个', isPinned: 0 })

    const res = await call({ action: 'ungroup_projects', projects: ['BetaGame'] })

    expect(res.success).toBe(true)
    expect(res.removed_count).toBe(1)
    expect(collectionsOf('p-b')).toEqual([])
    expect((res.results as Array<Record<string, unknown>>)[0].left_collections).toEqual([
      '旧分组',
      '另一个'
    ])
    expect(projects).toHaveLength(3)
    expect(send).toHaveBeenCalledWith('db:project:library-changed')
  })

  it('点名了合集就只移出那一个，别的分组留着', async () => {
    members.add(memberKey('p-b', 'collection_other'))
    collections.push({ collectionKey: 'collection_other', name: '另一个', isPinned: 0 })

    const res = await call({
      action: 'ungroup_projects',
      projects: ['BetaGame'],
      collection: '旧分组'
    })

    expect(res.success).toBe(true)
    expect(collectionsOf('p-b')).toEqual(['collection_other'])
  })

  it('点名了一个不存在的合集就报错，不顺手全移了', async () => {
    const res = await call({
      action: 'ungroup_projects',
      projects: ['BetaGame'],
      collection: '没有这个'
    })

    expect(res.success).toBe(false)
    expect(removeProjectFromCollection).not.toHaveBeenCalled()
    expect(collectionsOf('p-b')).toEqual(['collection_old'])
  })

  it('本来就没分组的算 unchanged，不白发通知', async () => {
    const res = await call({ action: 'ungroup_projects', projects: ['p-a'] })

    expect(res.success).toBe(true)
    expect(res.removed_count).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('pin_projects', () => {
  it('默认就是置顶', async () => {
    const res = await call({ action: 'pin_projects', projects: ['AlphaGame'] })

    expect(res.success).toBe(true)
    expect(res.pinned_count).toBe(1)
    expect(projects.find((p) => p.projectKey === 'p-a')!.isPinned).toBe(1)
  })

  it('pinned=false 是取消置顶', async () => {
    const res = await call({ action: 'pin_projects', projects: ['p-c'], pinned: false })

    expect(res.success).toBe(true)
    expect(projects.find((p) => p.projectKey === 'p-c')!.isPinned).toBe(0)
  })

  it('已经是这个状态就不重复写', async () => {
    const res = await call({ action: 'pin_projects', projects: ['p-c'], pinned: true })

    expect(res.pinned_count).toBe(0)
    expect(updateProject).not.toHaveBeenCalled()
  })

  it('写完回读状态没变就不报成功', async () => {
    updateProject.mockImplementation(() => true)

    const res = await call({ action: 'pin_projects', projects: ['p-a'] })

    expect(res.success).toBe(false)
    expect((res.results as Array<Record<string, unknown>>)[0].status).toBe('unconfirmed')
  })
})

describe('update_collection', () => {
  it('改名有回读校验', async () => {
    const res = await call({
      action: 'update_collection',
      collection: 'collection_old',
      newName: 'UE 5.4'
    })

    expect(res.success).toBe(true)
    expect(collections[0].name).toBe('UE 5.4')
    expect(send).toHaveBeenCalledWith('db:project:library-changed')
  })

  it('改名没生效就报出来', async () => {
    updateProjectCollection.mockImplementation(() => true)

    const res = await call({
      action: 'update_collection',
      collection: '旧分组',
      newName: 'UE 5.4'
    })

    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('没有确认改成功')
  })

  it('置顶合集', async () => {
    const res = await call({ action: 'update_collection', collection: '旧分组', pinned: true })

    expect(res.success).toBe(true)
    expect(collections[0].isPinned).toBe(1)
  })

  it('什么都没给就直说', async () => {
    const res = await call({ action: 'update_collection', collection: '旧分组' })

    expect(res.success).toBe(false)
    expect(updateProjectCollection).not.toHaveBeenCalled()
  })

  it('合集不存在时不会顺手建一个', async () => {
    const res = await call({ action: 'update_collection', collection: '没有这个', newName: 'X' })

    expect(res.success).toBe(false)
    expect(createProjectCollection).not.toHaveBeenCalled()
  })
})

describe('delete_collection', () => {
  it('解散合集不删工程，并报出放出来几个', async () => {
    const res = await call({ action: 'delete_collection', collection: '旧分组' })

    expect(res.success).toBe(true)
    expect(res.projects_ungrouped).toBe(1)
    expect(projects).toHaveLength(3)
    expect(collectionsOf('p-b')).toEqual([])
    expect(collections).toHaveLength(0)
    expect(String(res.message)).toContain('一个都没删')
  })

  it('删完回读还在就不报成功', async () => {
    deleteProjectCollectionByKey.mockImplementation(() => true)

    const res = await call({ action: 'delete_collection', collection: '旧分组' })

    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('没有确认删掉')
  })
})
