/**
 * 保管库 schema 的守卫。
 *
 * 起因：`models/index.ts` 里有个 `initVaultModels`，看起来就是保管库的建表入口，
 * 实际上**从来没人调用** —— 真正的建表和列迁移全在
 * `VaultManager.initializeVaultDatabase()` 里内联写着。给保管库加了新表和新列、
 * 改进那个假入口、然后在运行时撞上「no such table: assetNote」。
 *
 * 这道检查读的是 VaultManager 的源码，确认新表/新列确实写在**那一处**。
 * 它挡不住所有写错，但能挡住「改了不生效的那个地方」这一类。
 *
 * 运行方式: npx vitest run src/main/sqliteDataBase/vaultSchema.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const source = readFileSync('src/main/sqliteDataBase/VaultManager.ts', 'utf8')

describe('保管库 schema 写在真正会执行的那一处', () => {
  it('assetNote 表由 VaultManager 建，不是挂在没人调的 initVaultModels 上', () => {
    expect(source).toContain('initAssetNoteModel(vaultDb)')
  })

  it('assetData 的 noteId 列在迁移清单里', () => {
    // 老保管库的表早就建好了，CREATE TABLE IF NOT EXISTS 对它们不生效，
    // 只有走 ALTER 这条路才补得上
    expect(source).toMatch(/assetDataMigrations[\s\S]*?name: 'noteId'/)
  })

  it('assetFolder 也有自己的迁移清单，note 和 noteId 都在里面', () => {
    // 以前根本没有 assetFolder 的迁移清单 —— 文件夹备注是这次才加的功能，
    // 光改建表 SQL 对已有保管库一点用都没有
    expect(source).toMatch(/assetFolderMigrations[\s\S]*?name: 'note'/)
    expect(source).toMatch(/assetFolderMigrations[\s\S]*?name: 'noteId'/)
  })

  /**
   * 这条是拿线上事故换来的。
   *
   * `deletedAt` 当初只加进了 models/assetData.ts 和 models/assetFolder.ts 的清单 ——
   * 那两份挂在没人调用的 initVaultModels 上，等于没加。而 SyncClient 的
   * prepareStatements() 无条件 prepare 了一句带 `deletedAt` 的 UPDATE，
   * better-sqlite3 在 prepare 当场编译就抛 `no such column: deletedAt`，
   * 正好落在 startV2NetworkService 的 try 里 —— 用户升级之后**所有网络库全部离线**，
   * 报「资产服务器连接失败：no such column: deletedAt」。
   */
  it('deletedAt 两张表都在迁移清单里 —— 少了会让所有网络库离线', () => {
    expect(source).toMatch(/assetDataMigrations[\s\S]*?name: 'deletedAt'/)
    expect(source).toMatch(/assetFolderMigrations[\s\S]*?name: 'deletedAt'/)
  })

  it('两张表的迁移都真的被执行了', () => {
    expect(source).toContain("migrateColumns('assetData', assetDataMigrations)")
    expect(source).toContain("migrateColumns('assetFolder', assetFolderMigrations)")
  })
})

/**
 * 上面那条只保证「列会被补上」。这条保证「万一没补上也别把整个库拖下水」：
 * 同步用的列一律先和真实表结构取交集（SyncClient.resolveSyncColumns 就是干这个的），
 * 不许再有哪句 SQL 绕过它硬写某个列名。
 */
describe('同步语句不许假设某个列一定存在', () => {
  const syncClient = readFileSync('src/main/networkV2/SyncClient.ts', 'utf8')

  it('软删除语句按真实列拼，不是写死 deletedAt', () => {
    const prepareBody = syncClient.slice(
      syncClient.indexOf('private prepareStatements()'),
      syncClient.indexOf('private prepareStatements()') + 2000
    )
    expect(prepareBody).not.toMatch(/SET isDelete = 1, deletedAt =/)
  })
})

describe('那个会误导人的假入口已经删掉', () => {
  const modelsIndex = readFileSync('src/main/sqliteDataBase/models/index.ts', 'utf8')

  it('models/index.ts 里不再有 initVaultModels', () => {
    // 留着它，下一个加字段的人还会掉进同一个坑
    expect(modelsIndex).not.toMatch(/export const initVaultModels/)
  })

  it('但留了一段说明，指向真正该改的地方', () => {
    expect(modelsIndex).toContain('VaultManager.initializeVaultDatabase()')
  })
})
