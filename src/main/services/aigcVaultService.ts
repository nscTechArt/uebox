import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'
import { createAssetFolder, getAssetFolderByKey } from '../sqliteDataBase/models/assetFolder'
import {
  SYSTEM_VAULT_KEYS,
  VaultManager,
  VaultType,
  type VaultInfo
} from '../sqliteDataBase/VaultManager'

export type AIGCAssetType = 'image' | 'model' | 'video' | 'music'

const AIGC_SUBDIRS: Record<AIGCAssetType, string> = {
  image: '图片',
  model: '模型',
  video: '视频',
  music: '音乐'
}

export function getAIGCVaultInfoOrThrow(): VaultInfo {
  const vaultInfo = VaultManager.getInstance().getVaultBySystemKey(SYSTEM_VAULT_KEYS.AIGC)
  if (!vaultInfo) {
    throw new Error('AIGC 资产库未初始化')
  }
  return vaultInfo
}

export function getAIGCVaultPath(): string {
  return getAIGCVaultInfoOrThrow().path
}

export function assertAIGCVaultLocalWritesAllowed(): void {
  const vaultInfo = getAIGCVaultInfoOrThrow()
  const networkPath = String(vaultInfo.networkPath || '').trim()
  if (vaultInfo.vaultType === VaultType.NETWORK && /^https?:\/\//i.test(networkPath)) {
    throw new Error('平台网络 AIGC 资产库不允许本地直写，请通过平台导入流程')
  }
}

export async function withAIGCVaultDatabase<T>(
  operation: (vaultDb: Database.Database, vaultInfo: VaultInfo) => Promise<T> | T
): Promise<T> {
  const vaultManager = VaultManager.getInstance()
  const vaultInfo = getAIGCVaultInfoOrThrow()
  return await vaultManager.withVaultDatabase(vaultInfo.id, operation)
}

export function openAIGCVaultDatabase(): {
  db: Database.Database
  vaultInfo: VaultInfo
  close: () => void
} {
  const vaultInfo = getAIGCVaultInfoOrThrow()
  const dbPath = join(vaultInfo.path, 'vault-data.db')
  if (!existsSync(dbPath)) {
    throw new Error(`AIGC 资产库数据库不存在: ${dbPath}`)
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  return {
    db,
    vaultInfo,
    close: () => db.close()
  }
}

export async function ensureAIGCDirectory(...relativeParts: string[]): Promise<string> {
  const dirPath = join(getAIGCVaultPath(), ...relativeParts)
  await fs.mkdir(dirPath, { recursive: true })
  return dirPath
}

export function getAIGCSubdirName(assetType: AIGCAssetType): string {
  return AIGC_SUBDIRS[assetType]
}

export function ensureFolderRecord(
  db: Database.Database,
  folderKey: string,
  fatherKey: string | null,
  type: string,
  folderName: string
): void {
  if (getAssetFolderByKey(db, folderKey)) return

  const existingRow = db
    .prepare(
      'SELECT folderKey, isDelete FROM assetFolder WHERE folderKey = ? ORDER BY id DESC LIMIT 1'
    )
    .get(folderKey) as { folderKey: string; isDelete?: number } | undefined

  if (existingRow) {
    db.prepare(
      `UPDATE assetFolder
       SET fatherKey = ?, type = ?, folderName = ?, img = '', isDelete = 0,
           updated_at = datetime('now', 'localtime')
       WHERE folderKey = ?`
    ).run(fatherKey, type, folderName, folderKey)
    return
  }

  createAssetFolder(db, {
    folderKey,
    fatherKey,
    type,
    folderName,
    img: ''
  })
}
