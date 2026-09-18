/**
 * scanResurrection.test.ts — 扫描复活 bug 回归测试
 *
 * 覆盖场景：
 *  1. 删除文件夹后执行扫描，子树资产不会重新出现在 ALL
 *  2. 已软删除资产的 originPath/filePath 再次被扫描时，不会被重新创建
 *  3. 同名目录/同路径文件在软删除后扫描，不会生成新的 folderKey/assetKey 脏数据
 *
 * 测试方法：
 *  直接在内存 SQLite 上模拟 performServerScan 的阶段 2（去重）和阶段 4（入库）
 *  的核心逻辑，不依赖文件系统 I/O。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import {
  initAssetFolderModel,
  deleteAssetFolder,
  getAssetFolderByNameAndParent
} from '../sqliteDataBase/models/assetFolder'
import { ScannerFilter } from '../utils/vaultPathNormalize'

// ─────────────────────── helpers ───────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  // 二次调用触发 ALTER TABLE 迁移
  initAssetDataModel(db)
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)
  `
  ).run()
  return db
}

function insertFolder(
  db: Database.Database,
  folderKey: string,
  fatherKey: string,
  folderName: string,
  depth: number
): void {
  db.prepare(
    `
    INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
    VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', 0)
  `
  ).run(folderKey, fatherKey, folderName, `/${folderName}`, depth)
}

function insertAsset(
  db: Database.Database,
  assetKey: string,
  folderKey: string,
  opts?: { originPath?: string; filePath?: string }
): void {
  db.prepare(
    `
    INSERT INTO assetData (assetKey, folderKey, assetName, originPath, filePath, isDelete)
    VALUES (?, ?, ?, ?, ?, 0)
  `
  ).run(
    assetKey,
    folderKey,
    `${assetKey}.uasset`,
    opts?.originPath ?? `/nas/vault/${folderKey}/${assetKey}.uasset`, // Fallback uses /nas/vault as prefix
    opts?.filePath ?? `${folderKey}/${assetKey}.uasset`
  )
}

function countActiveAssets(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM assetData WHERE isDelete = 0').get() as { c: number }
  ).c
}

function countActiveFolders(db: Database.Database): number {
  // 排除 ALL 根文件夹
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM assetFolder WHERE isDelete = 0 AND folderKey != 'ALL'")
      .get() as { c: number }
  ).c
}

function countAllAssets(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM assetData').get() as { c: number }).c
}

/**
 * 获取真实的 ScannerFilter 实例
 */
function createScannerFilter(
  db: Database.Database,
  networkPath: string = '/nas/vault'
): ScannerFilter {
  const rows = db.prepare(`SELECT filePath, originPath, isDelete FROM assetData`).all() as any[]
  return new ScannerFilter(rows, networkPath)
}

// ─────────────────────── 阶段 2 去重测试 ───────────────────────

describe('performServerScan — 阶段 2 去重修复', () => {
  it('已软删除资产的 originPath 不会通过去重（修复后）', () => {
    const db = createTestDb()
    insertFolder(db, 'folderA', 'ALL', 'FolderA', 1)
    insertAsset(db, 'asset1', 'folderA', {
      originPath: '/nas/vault/FolderA/model1.uasset',
      filePath: 'FolderA/model1.uasset'
    })
    insertAsset(db, 'asset2', 'folderA', {
      originPath: '/nas/vault/FolderA/model2.uasset',
      filePath: 'FolderA/model2.uasset'
    })
    insertAsset(db, 'asset3', 'folderA', {
      originPath: '/nas/vault/FolderA/model3.uasset',
      filePath: 'FolderA/model3.uasset'
    })

    // 删除文件夹 A（连同子资产一起软删除）
    deleteAssetFolder(db, 'folderA')

    // 模拟磁盘上仍然存在这些文件
    const scannedFiles = [
      { fullPath: '/nas/vault/FolderA/model1.uasset', relativePath: 'FolderA/model1.uasset' },
      { fullPath: '/nas/vault/FolderA/model2.uasset', relativePath: 'FolderA/model2.uasset' },
      { fullPath: '/nas/vault/FolderA/model3.uasset', relativePath: 'FolderA/model3.uasset' }
    ]

    // 调用真正的 ScannerFilter：被软删的记录及其对应物理文件必须精准拦截被当作“新文件”
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)

    // 修复后，这 3 个文件都会被当成“已存在的物理文件”，不应该进入入库阶段
    expect(newFiles).toHaveLength(0)
  })

  it('已软删除资产由于 originPath 与 scanned path 大小写不同，BUG 会复活它，修复后则抛弃', () => {
    const db = createTestDb()
    insertFolder(db, 'folderA', 'ALL', 'FolderA', 1)
    insertAsset(db, 'asset1', 'folderA', {
      originPath: '/nas/vault/FolderA/mOdEl.uasset',
      filePath: 'FolderA/mOdEl.uasset'
    })

    deleteAssetFolder(db, 'folderA')

    const scannedFiles = [
      { fullPath: '/nas/vault/FolderA/model.uasset', relativePath: 'FolderA/model.uasset' }
    ]

    const filter = createScannerFilter(db)
    const fixedResult = filter.filterNewFiles(scannedFiles)
    expect(fixedResult).toHaveLength(0)
  })

  it('活跃资产仍被正确去重（不影响正常逻辑）', () => {
    const db = createTestDb()
    insertFolder(db, 'folderB', 'ALL', 'FolderB', 1)
    insertAsset(db, 'assetB1', 'folderB', {
      originPath: '/nas/vault/FolderB/tex1.uasset',
      filePath: 'FolderB/tex1.uasset'
    })

    const scannedFiles = [
      { fullPath: '/nas/vault/FolderB/tex1.uasset', relativePath: 'FolderB/tex1.uasset' },
      { fullPath: '/nas/vault/FolderB/tex2.uasset', relativePath: 'FolderB/tex2.uasset' } // 真正的新文件
    ]

    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)
    expect(newFiles).toHaveLength(1)
    expect(newFiles[0].relativePath).toBe('FolderB/tex2.uasset')
  })
})

// ─────────────────────── 阶段 4 软删除防复活测试 ───────────────────────

describe('performServerScan — 阶段 4 软删除防复活', () => {
  it('Case 1: filePath 为相对路径时，删除后扫描不复活', () => {
    const db = createTestDb()
    insertFolder(db, 'c1', 'ALL', 'C1', 1)
    insertAsset(db, 'a1', 'c1', { originPath: undefined, filePath: 'C1/model.uasset' })
    deleteAssetFolder(db, 'c1')

    const filter = createScannerFilter(db)
    expect(filter.isSoftDeleted('C1/model.uasset')).toBe(true)
  })

  it('Case 2: filePath 为 vault 下绝对路径时，删除后扫描不复活', () => {
    const db = createTestDb()
    insertFolder(db, 'c2', 'ALL', 'C2', 1)
    // 假设脏数据把 filePath 错误存成了绝对路径
    insertAsset(db, 'a2', 'c2', { originPath: undefined, filePath: '/nas/vault/C2/model.uasset' })
    deleteAssetFolder(db, 'c2')

    // 阶段4 判断
    const filter = createScannerFilter(db)
    expect(filter.isSoftDeleted('C2/model.uasset')).toBe(true)
  })

  it('Case 3: originPath 为客户端本地绝对路径、filePath 为相对路径时，删除后扫描不复活', () => {
    const db = createTestDb()
    insertFolder(db, 'c3', 'ALL', 'C3', 1)
    insertAsset(db, 'a3', 'c3', {
      originPath: 'D:\\Projects\\Game\\Content\\C3\\model.uasset',
      filePath: 'C3/model.uasset'
    })
    deleteAssetFolder(db, 'c3')

    const filter = createScannerFilter(db)
    expect(filter.isSoftDeleted('C3/model.uasset')).toBe(true)
  })

  it('Case 4: 路径大小写、斜杠风格不同，仍然不复活', () => {
    const db = createTestDb()
    insertFolder(db, 'c4', 'ALL', 'C4', 1)
    insertAsset(db, 'a4', 'c4', {
      originPath: '/NAS/Vault/C4/Model.uasset',
      filePath: 'c4\\model.uasset'
    })
    deleteAssetFolder(db, 'c4')
    // 阶段4 判断（无惧大小写，因为 scanRelNormed 统一 toLowerCase() 掉了）
    const filter = createScannerFilter(db)
    expect(filter.isSoftDeleted('C4/Model.uasset')).toBe(true)
  })

  it('Case 5: 无法映射到当前 vault 的旧脏数据不会误伤真正新文件', () => {
    const db = createTestDb()
    insertFolder(db, 'c5', 'ALL', 'C5', 1)
    // 只有 originPath，而且是完全不相干的绝对路径，无法映射出 vault-relative
    insertAsset(db, 'a5', 'c5', {
      originPath: '/some/other/path/C5/model.uasset',
      filePath: undefined
    })
    deleteAssetFolder(db, 'c5')

    // 这种已经彻底由于格式丢弃而成为孤儿老记录，确实防复活识别不出来（只能重新纳入新兵库）
    const filter = createScannerFilter(db)
    expect(filter.isSoftDeleted('C5/model.uasset')).toBe(false)
  })
})

// ─────────────────────── 完整场景端到端测试 ───────────────────────

describe('删除文件夹后扫描 — 端到端回归', () => {
  it('删除文件夹后扫描，子树资产不会在 ALL 下重新出现', () => {
    const db = createTestDb()

    // 创建文件夹 A 含 5 个 uasset
    insertFolder(db, 'folderA', 'ALL', 'FolderA', 1)
    for (let i = 1; i <= 5; i++) {
      insertAsset(db, `asset_${i}`, 'folderA', {
        originPath: `/nas/vault/FolderA/model_${i}.uasset`,
        filePath: `FolderA/model_${i}.uasset`
      })
    }
    expect(countActiveAssets(db)).toBe(5)
    expect(countActiveFolders(db)).toBe(1)

    // 用户通过 UI 删除文件夹 A
    deleteAssetFolder(db, 'folderA')
    expect(countActiveAssets(db)).toBe(0)
    expect(countActiveFolders(db)).toBe(0)

    // 模拟扫描：物理文件仍在磁盘上
    const scannedFiles = Array.from({ length: 5 }, (_, i) => ({
      fullPath: `/nas/vault/FolderA/model_${i + 1}.uasset`,
      relativePath: `FolderA/model_${i + 1}.uasset`
    }))

    // 阶段 2 去重：全部应被排除
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)
    expect(newFiles).toHaveLength(0)

    for (const file of scannedFiles) {
      expect(filter.isSoftDeleted(file.relativePath)).toBe(true)
    }

    // 数据库状态不变：仍然 0 个活跃资产
    expect(countActiveAssets(db)).toBe(0)
    // 总记录数仍然是 5（软删除但不物理删除）
    expect(countAllAssets(db)).toBe(5)
  })

  it('同名目录在软删除后扫描，不会生成新的 folderKey 脏数据', () => {
    const db = createTestDb()

    // 创建 FolderA 并删除
    insertFolder(db, 'folderA_v1', 'ALL', 'FolderA', 1)
    insertAsset(db, 'asset_v1', 'folderA_v1', {
      originPath: '/nas/vault/FolderA/file.uasset',
      filePath: 'FolderA/file.uasset'
    })
    deleteAssetFolder(db, 'folderA_v1')

    // getAssetFolderByNameAndParent 只查 isDelete=0 → 找不到已删除的 FolderA
    const found = getAssetFolderByNameAndParent(db, 'FolderA', null)
    expect(found).toBeUndefined()

    // 但去重应该阻止资产被重新创建
    const scannedFiles = [
      { fullPath: '/nas/vault/FolderA/file.uasset', relativePath: 'FolderA/file.uasset' }
    ]
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)

    // 返回 0 表示完美去重
    expect(newFiles).toHaveLength(0)
    // 但阶段 4 的防复活检查会拦截
    expect(filter.isSoftDeleted('FolderA/file.uasset')).toBe(true)
  })

  it('混合场景：部分文件已删除，部分是新文件', () => {
    const db = createTestDb()

    insertFolder(db, 'mix_folder', 'ALL', 'MixFolder', 1)
    insertAsset(db, 'old_asset', 'mix_folder', {
      originPath: '/nas/vault/MixFolder/old.uasset',
      filePath: 'MixFolder/old.uasset'
    })
    deleteAssetFolder(db, 'mix_folder')

    const scannedFiles = [
      { fullPath: '/nas/vault/MixFolder/old.uasset', relativePath: 'MixFolder/old.uasset' }, // 已删除
      { fullPath: '/nas/vault/MixFolder/new.uasset', relativePath: 'MixFolder/new.uasset' } // 真正的新文件
    ]

    // 去重应放行新文件、拦截已有文件
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)

    expect(newFiles).toHaveLength(1)
    expect(newFiles[0].relativePath).toBe('MixFolder/new.uasset')

    expect(filter.isSoftDeleted('MixFolder/old.uasset')).toBe(true)
    expect(filter.isSoftDeleted('MixFolder/new.uasset')).toBe(false)
  })

  it('大小写差异的 originPath 仍能正确去重', () => {
    const db = createTestDb()

    insertFolder(db, 'case_f', 'ALL', 'CaseFolder', 1)
    insertAsset(db, 'case_asset', 'case_f', {
      originPath: '/NAS/Vault/CaseFolder/Model.uasset',
      filePath: 'CaseFolder/Model.uasset'
    })
    deleteAssetFolder(db, 'case_f')

    // 扫描时路径大小写不同
    const scannedFiles = [
      { fullPath: '/nas/vault/casefolder/model.uasset', relativePath: 'CaseFolder/Model.uasset' }
    ]

    // originPath 大小写不同但去重使用 toLowerCase() → 仍然匹配
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)
    expect(newFiles).toHaveLength(0)
  })

  it('Windows 反斜杠路径与 Linux 正斜杠路径正确去重', () => {
    const db = createTestDb()

    insertFolder(db, 'slash_f', 'ALL', 'SlashFolder', 1)
    // 客户端上传时存储的是 Windows 路径
    insertAsset(db, 'slash_asset', 'slash_f', {
      originPath: 'D:\\Assets\\SlashFolder\\texture.uasset',
      filePath: 'SlashFolder/texture.uasset'
    })
    deleteAssetFolder(db, 'slash_f')

    // 服务端扫描使用 Linux 路径 → originPath 不匹配
    // 但基于 normalized relative path，这里能匹配
    const scannedFiles = [
      {
        fullPath: '/nas/vault/SlashFolder/texture.uasset',
        relativePath: 'SlashFolder/texture.uasset'
      }
    ]

    // 去重能命中（因为 normalize 助手把 D:\Assets... 转成了相对于 /nas/vault/ 的路径吗？
    // 等等！"D:\Assets..." 并不是 networkPath ("/nas/vault") 下的！
    // 这种情况 normalizeVaultRelativePath 返回 null。但该记录的 filePath 是 "SlashFolder/texture.uasset"。
    // 此时 normalize 会提取出该 filePath 并放入集合。所以扫描产生的 relativePath 是匹配的。
    const filter = createScannerFilter(db)
    const newFiles = filter.filterNewFiles(scannedFiles)

    expect(newFiles).toHaveLength(0)

    // 但阶段 4 的 filePath 防复活检查会拦截
    expect(filter.isSoftDeleted('SlashFolder/texture.uasset')).toBe(true)
  })

  it('Option B 语义：逻辑目录与物理目录解耦，删除逻辑目录后扫描不复活、不重新挂载', () => {
    const db = createTestDb()

    // 1. 创建逻辑目录 A，物理上不存在
    insertFolder(db, 'logicFolderA', 'ALL', 'A', 1)

    // 2. 资产被导入到逻辑目录 A，但物理上在 Vault 根目录
    insertAsset(db, 'assetInA', 'logicFolderA', {
      originPath: '/nas/vault/RootFile.uasset',
      filePath: 'RootFile.uasset' // 物理仍只在根目录
    })

    // 此时它在 A 内
    expect(countActiveAssets(db)).toBe(1)

    // 3. 用户在 UI 删除了该逻辑目录 A
    deleteAssetFolder(db, 'logicFolderA')

    // 断言资产已被软删
    expect(countActiveAssets(db)).toBe(0)

    // 4. 用户重新执行服务端物理扫描，物理文件仍遗留在根目录
    const scannedFiles = [
      { fullPath: '/nas/vault/RootFile.uasset', relativePath: 'RootFile.uasset', dirPath: 'ALL' }
    ]

    const filter = createScannerFilter(db)

    // 根据 Option B 语义核心要求：扫描时绝不可根据物理残留把已有（但软删）资产复活到 ALL！
    const newFiles = filter.filterNewFiles(scannedFiles)

    // 完美去重：已被软删的物理遗留将通过 normalized relative path 匹配并拦截
    expect(newFiles).toHaveLength(0)

    // 阶段 4 的防复活后置检查也会将该物理文件识别为需抛弃
    expect(filter.isSoftDeleted('RootFile.uasset')).toBe(true)
  })
})
