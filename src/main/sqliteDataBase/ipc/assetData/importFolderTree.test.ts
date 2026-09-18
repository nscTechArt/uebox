import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createAssetFolder,
  getAllAssetFolders,
  getAssetFolderByKey,
  getAssetFoldersByFatherKey,
  initAssetFolderModel
} from '../../models/assetFolder'
import type { FolderTypeInfo } from './importAssetMedia'
import {
  buildImportFolderTree,
  type ImportFolderBlueprint,
  type ImportFolderTreeInput
} from './importFolderTree'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  createAssetFolder(db, { folderKey: 'ALL', fatherKey: null, folderName: 'ALL', type: 'system' })
})

afterEach(() => {
  db.close()
})

/** 一次「把 D:\\Art\\PhotoR_Backgrounds 收进素材库根目录」的导入 */
const importRun = (
  overrides: Partial<ImportFolderTreeInput> = {}
): ReturnType<typeof buildImportFolderTree> & {
  folderBlueprints: Map<string, ImportFolderBlueprint>
} => {
  const folderBlueprints = new Map<string, ImportFolderBlueprint>()
  const result = buildImportFolderTree(db, {
    rootFolderPath: 'D:\\Art\\PhotoR_Backgrounds',
    rootParentKey: 'ALL',
    isFileImportToAll: false,
    folders: [
      { path: 'D:\\Art\\PhotoR_Backgrounds\\Textures', name: 'Textures' },
      { path: 'D:\\Art\\PhotoR_Backgrounds\\Textures\\HDRI', name: 'HDRI' }
    ],
    folderTypes: new Map<string, FolderTypeInfo>(),
    folderBlueprints,
    ...overrides
  })
  return { ...result, folderBlueprints }
}

const folderNames = (fatherKey: string): string[] =>
  getAssetFoldersByFatherKey(db, fatherKey).map((folder) => folder.folderName)

describe('buildImportFolderTree', () => {
  it('同一个磁盘目录导入两次，库里只长一棵树', () => {
    const first = importRun()
    const second = importRun()

    expect(folderNames('ALL')).toEqual(['PhotoR_Backgrounds'])
    expect(second.rootFolderKey).toBe(first.rootFolderKey)
    expect([...second.pathToKeyMap.entries()]).toEqual([...first.pathToKeyMap.entries()])
    // 第一次建了根 + 两级子目录，第二次一个都不该新建
    expect(first.createdFolderKeys).toHaveLength(3)
    expect(second.createdFolderKeys).toEqual([])
    expect(getAllAssetFolders(db)).toHaveLength(4) // ALL + 3
  })

  it('导入第三次也不会新建，重复导入次数无关', () => {
    importRun()
    importRun()
    importRun()
    expect(folderNames('ALL')).toEqual(['PhotoR_Backgrounds'])
    expect(getAllAssetFolders(db)).toHaveLength(4)
  })

  it('子文件夹按名字认领的是自己父级下那一个，不会被别处的同名文件夹抢走', () => {
    // 两个不同的磁盘根目录，各带一个叫 Textures 的子目录
    importRun()
    const other = importRun({
      rootFolderPath: 'D:\\Art\\Other_Pack',
      folders: [{ path: 'D:\\Art\\Other_Pack\\Textures', name: 'Textures' }]
    })

    expect(folderNames('ALL').sort()).toEqual(['Other_Pack', 'PhotoR_Backgrounds'])
    expect(folderNames(other.rootFolderKey)).toEqual(['Textures'])
    // 两个 Textures 是两条独立的记录，父级各自不同
    const texturesRows = getAllAssetFolders(db).filter((f) => f.folderName === 'Textures')
    expect(texturesRows).toHaveLength(2)
    expect(new Set(texturesRows.map((f) => f.fatherKey)).size).toBe(2)
  })

  it('乱序传入子文件夹，也按父级挂对而不是整层塌到根上', () => {
    const { rootFolderKey, pathToKeyMap } = importRun({
      folders: [
        { path: 'D:\\Art\\PhotoR_Backgrounds\\Textures\\HDRI', name: 'HDRI' },
        { path: 'D:\\Art\\PhotoR_Backgrounds\\Textures', name: 'Textures' }
      ]
    })

    const texturesKey = pathToKeyMap.get('D:/Art/PhotoR_Backgrounds/Textures')!
    const hdriKey = pathToKeyMap.get('D:/Art/PhotoR_Backgrounds/Textures/HDRI')!
    expect(getAssetFolderByKey(db, texturesKey)?.fatherKey).toBe(rootFolderKey)
    expect(getAssetFolderByKey(db, hdriKey)?.fatherKey).toBe(texturesKey)
  })

  it('复用时补上第一次没识别出来的插件图标', () => {
    importRun()
    importRun({
      folderTypes: new Map<string, FolderTypeInfo>([
        ['D:\\Art\\PhotoR_Backgrounds', { type: 'plugin', iconPath: 'icon.png' }]
      ])
    })

    const root = getAssetFoldersByFatherKey(db, 'ALL')[0]
    expect(root.img).toBe('icon.png')
    expect(root.type).toBe('plugin')
  })

  it('蓝图记的是库里那一行的样子，复用时不会被这次的空图标盖掉', () => {
    importRun({
      folderTypes: new Map<string, FolderTypeInfo>([
        ['D:\\Art\\PhotoR_Backgrounds', { type: 'plugin', iconPath: 'icon.png' }]
      ])
    })
    const second = importRun()

    expect(second.folderBlueprints.get(second.rootFolderKey)).toMatchObject({
      fatherKey: 'ALL',
      folderName: 'PhotoR_Backgrounds',
      type: 'plugin',
      img: 'icon.png'
    })
  })

  it('散文件导入：不建根节点，直接落在目标文件夹上', () => {
    const { rootFolderKey, pathToKeyMap, createdFolderKeys } = importRun({
      rootFolderPath: 'ALL',
      isFileImportToAll: true,
      folders: []
    })

    expect(rootFolderKey).toBe('ALL')
    expect(pathToKeyMap.size).toBe(0)
    expect(createdFolderKeys).toEqual([])
    expect(getAllAssetFolders(db)).toHaveLength(1)
  })
})
