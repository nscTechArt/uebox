/**
 * 工程分组的成员关系。
 *
 * 分组在界面上是一排筛选按钮（「UE 5.5」「教学用」），同一个工程完全可能
 * 两边都算 —— 这个文件盯的就是「加进 B 不会把它从 A 里踢出来」，
 * 以及老库里那一列单值 `projects.collectionKey` 搬家时一条归属都不能丢。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { createProject, deleteProjectByKey, initProjectModel } from './project'
import {
  assignProjectToCollection,
  clearProjectsOfCollection,
  createProjectCollection,
  getAllProjectCollectionsWithItems,
  getCollectionKeysOfProject,
  getProjectsByCollectionKey,
  initProjectCollectionModel,
  isProjectInCollection,
  removeProjectFromCollection
} from './projectCollection'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  initProjectCollectionModel(db)
  initProjectModel(db)
  createProjectCollection(db, { collectionKey: 'c-55', name: 'UE 5.5' })
  createProjectCollection(db, { collectionKey: 'c-teach', name: '教学用' })
  createProject(db, { projectKey: 'p-a', projectName: 'AlphaGame', projectPath: 'D:/P/Alpha' })
  createProject(db, { projectKey: 'p-b', projectName: 'BetaGame', projectPath: 'D:/P/Beta' })
  return db
}

describe('一个工程可以同时在多个分组里', () => {
  it('加进第二个分组不会把它从第一个里踢出来', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')
    assignProjectToCollection(db, 'p-a', 'c-teach')

    expect(getCollectionKeysOfProject(db, 'p-a').sort()).toEqual(['c-55', 'c-teach'])
    expect(getProjectsByCollectionKey(db, 'c-55').map((p) => p.projectKey)).toEqual(['p-a'])
    expect(getProjectsByCollectionKey(db, 'c-teach').map((p) => p.projectKey)).toEqual(['p-a'])
  })

  it('重复加不会加出第二条', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')
    expect(assignProjectToCollection(db, 'p-a', 'c-55')).toBe(true)
    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual(['c-55'])
  })

  it('点名分组就只移出那一个，不点名就全移出去', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')
    assignProjectToCollection(db, 'p-a', 'c-teach')

    removeProjectFromCollection(db, 'p-a', 'c-55')
    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual(['c-teach'])

    removeProjectFromCollection(db, 'p-a')
    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual([])
  })

  it('解散分组只清成员关系，工程和别的分组都还在', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')
    assignProjectToCollection(db, 'p-a', 'c-teach')
    assignProjectToCollection(db, 'p-b', 'c-55')

    expect(clearProjectsOfCollection(db, 'c-55')).toBe(2)
    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual(['c-teach'])
    expect(isProjectInCollection(db, 'p-b', 'c-55')).toBe(false)
  })

  it('工程被删掉时，它的分组归属跟着走 —— 不留孤儿', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')
    deleteProjectByKey(db, 'p-a')

    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual([])
    expect(getProjectsByCollectionKey(db, 'c-55')).toEqual([])
  })

  it('列分组时带上各自的成员，空分组也要在', () => {
    const db = createTestDb()
    assignProjectToCollection(db, 'p-a', 'c-55')

    const list = getAllProjectCollectionsWithItems(db)
    const byKey = new Map(list.map((c) => [c.collectionKey, c]))
    expect(byKey.get('c-55')!.items.map((p) => p.projectKey)).toEqual(['p-a'])
    expect(byKey.get('c-teach')!.items).toEqual([])
  })
})

describe('老库里那一列单值 collectionKey', () => {
  it('搬进关联表之后，列就删掉 —— 不留两处成员关系', () => {
    const db = new Database(':memory:')
    // 老版本的 projects 表：成员关系是工程行上的一列
    db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectKey TEXT NOT NULL UNIQUE,
        projectName TEXT,
        collectionKey TEXT,
        isPinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
      CREATE INDEX idx_projects_collectionKey ON projects(collectionKey);
      INSERT INTO projects (projectKey, projectName, collectionKey)
      VALUES ('p-a', 'AlphaGame', 'c-55'), ('p-b', 'BetaGame', NULL);
    `)

    initProjectCollectionModel(db)

    expect(getCollectionKeysOfProject(db, 'p-a')).toEqual(['c-55'])
    expect(getCollectionKeysOfProject(db, 'p-b')).toEqual([])
    const columns = db.pragma('table_info(projects)') as Array<{ name: string }>
    expect(columns.some((col) => col.name === 'collectionKey')).toBe(false)
  })
})
