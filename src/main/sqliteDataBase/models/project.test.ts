/**
 * 项目库的判重全押在路径规范化上。
 *
 * 判不出重复的代价用户一眼就能看见：同一个工程在首页并排出现两张卡片
 * —— 一张是他自己点导入的（`I:\UE Project\X`），一张是用 UE 打开工程时
 * 插件上报后自动登记的（`I:/UE Project/X`）。两个字符串不相等，老逻辑就
 * 判成两个工程。这个文件盯的就是这条。
 */
import * as path from 'path'

import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

import {
  canonicalizeProjectPaths,
  createProject,
  getAllProjects,
  getProjectByPath,
  initProjectModel,
  mergeDuplicateProjectPaths,
  projectExistsByPath,
  type ProjectRecord
} from './project'
import {
  assignProjectToCollection,
  getCollectionKeysOfProject,
  initProjectCollectionModel
} from './projectCollection'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  // 分组表先建：合并重复记录时要把被删那条的分组归属搬过来，跟正式初始化顺序一致
  initProjectCollectionModel(db)
  initProjectModel(db)
  return db
}

function project(
  key: string,
  projectPath: string,
  extra: Partial<ProjectRecord> = {}
): ProjectRecord {
  return {
    projectKey: key,
    projectName: 'Lecturer_UE_5_6',
    projectPath,
    originPath: `${projectPath}/Lecturer_UE_5_6.uproject`,
    ...extra
  } satisfies ProjectRecord
}

describe('按路径判重', () => {
  it('反斜杠和正斜杠是同一个工程', () => {
    const db = createTestDb()
    createProject(db, project('a', 'I:\\UE Project\\Lecturer_UE_5_6'))

    expect(projectExistsByPath(db, 'I:/UE Project/Lecturer_UE_5_6')).toBe(true)
    expect(getProjectByPath(db, 'I:/UE Project/Lecturer_UE_5_6')?.projectKey).toBe('a')
  })

  it('大小写不同、结尾多个分隔符，都还是同一个工程', () => {
    const db = createTestDb()
    createProject(db, project('a', 'I:\\UE Project\\Lecturer_UE_5_6'))

    expect(projectExistsByPath(db, 'i:/ue project/lecturer_ue_5_6/')).toBe(true)
  })

  it('不同工程不会被判成重复', () => {
    const db = createTestDb()
    createProject(db, project('a', 'I:\\UE Project\\Lecturer_UE_5_6'))

    expect(projectExistsByPath(db, 'I:/UE Project/Lecturer_UE_5_7')).toBe(false)
  })

  it('空路径查不出东西，也不会误命中路径为空的记录', () => {
    const db = createTestDb()
    createProject(db, project('a', ''))

    expect(getProjectByPath(db, '')).toBeUndefined()
    expect(projectExistsByPath(db, '   ')).toBe(false)
  })
})

describe('canonicalizeProjectPaths', () => {
  it('把存着的路径统一成本机写法', () => {
    const db = createTestDb()
    createProject(db, project('a', 'I:/UE Project/Lecturer_UE_5_6'))

    canonicalizeProjectPaths(db)

    const saved = getProjectByPath(db, 'I:/UE Project/Lecturer_UE_5_6')!
    expect(saved.projectPath).toBe(path.normalize('I:/UE Project/Lecturer_UE_5_6'))
    expect(saved.originPath).toBe(
      path.normalize('I:/UE Project/Lecturer_UE_5_6/Lecturer_UE_5_6.uproject')
    )
  })
})

describe('mergeDuplicateProjectPaths', () => {
  it('Mac 判重迁移保留大小写不同的离线工程记录', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const db = createTestDb()
    try {
      createProject(db, project('upper', '/Volumes/OfflineUE/Game'))
      createProject(db, project('lower', '/Volumes/OfflineUE/game'))

      mergeDuplicateProjectPaths(db)

      expect(getAllProjects(db)).toHaveLength(2)
      expect(getProjectByPath(db, '/Volumes/OfflineUE/Game')?.projectKey).toBe('upper')
      expect(getProjectByPath(db, '/Volumes/OfflineUE/game')?.projectKey).toBe('lower')
    } finally {
      db.close()
      platform.mockRestore()
    }
  })

  it('同一个工程的两条记录合并成一条，留最早的那条', () => {
    const db = createTestDb()
    createProject(db, project('auto', 'I:/UE Project/Lecturer_UE_5_6'))
    createProject(db, project('manual', 'I:\\UE Project\\Lecturer_UE_5_6'))

    mergeDuplicateProjectPaths(db)

    const all = getAllProjects(db)
    expect(all).toHaveLength(1)
    expect(all[0].projectKey).toBe('auto')
  })

  it('留下的那条缺封面时，从被删的那条补过来 —— 合并后不能变白板', () => {
    const db = createTestDb()
    createProject(db, project('auto', 'I:/UE Project/Lecturer_UE_5_6', { image: '' }))
    createProject(
      db,
      project('manual', 'I:\\UE Project\\Lecturer_UE_5_6', {
        image: 'thumbnail-x.png',
        note: '主讲人场景'
      })
    )
    assignProjectToCollection(db, 'manual', 'teaching')

    mergeDuplicateProjectPaths(db)

    const [kept] = getAllProjects(db)
    expect(kept.projectKey).toBe('auto')
    expect(kept.image).toBe('thumbnail-x.png')
    expect(kept.note).toBe('主讲人场景')
    // 分组归属也要跟过来，被删的那条上的分组不能凭空消失
    expect(getCollectionKeysOfProject(db, 'auto')).toEqual(['teaching'])
    expect(getCollectionKeysOfProject(db, 'manual')).toEqual([])
  })

  it('留下的那条自己有封面时不会被覆盖', () => {
    const db = createTestDb()
    createProject(db, project('auto', 'I:/UE Project/Lecturer_UE_5_6', { image: 'keep.png' }))
    createProject(db, project('manual', 'I:\\UE Project\\Lecturer_UE_5_6', { image: 'drop.png' }))

    mergeDuplicateProjectPaths(db)

    expect(getAllProjects(db)[0].image).toBe('keep.png')
  })

  it('不同工程一个都不少', () => {
    const db = createTestDb()
    createProject(db, project('a', 'I:/UE Project/Lecturer_UE_5_6'))
    createProject(db, project('b', 'I:/UE Project/SampleProject'))

    mergeDuplicateProjectPaths(db)

    expect(getAllProjects(db)).toHaveLength(2)
  })

  it('没有路径的记录留着不动 —— 无从判重就不该猜', () => {
    const db = createTestDb()
    createProject(db, project('a', ''))
    createProject(db, project('b', ''))

    mergeDuplicateProjectPaths(db)

    expect(getAllProjects(db)).toHaveLength(2)
  })
})

describe('initProjectModel', () => {
  it('启动时自己会收拾老库里的重复记录', () => {
    const db = createTestDb()
    createProject(db, project('auto', 'I:/UE Project/Lecturer_UE_5_6'))
    createProject(db, project('manual', 'I:\\UE Project\\Lecturer_UE_5_6'))

    // 模拟下一次启动：建表是 IF NOT EXISTS，迁移会再跑一遍
    initProjectModel(db)

    expect(getAllProjects(db)).toHaveLength(1)
  })
})
