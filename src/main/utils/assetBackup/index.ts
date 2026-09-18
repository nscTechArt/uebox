export { AssetBackupManager } from './AssetBackupManager'

// 导出类型定义
export interface BackupAssetInfo {
  sourcePath: string
  softPath: string
  assetKey: string
  /** 全部引用（强 ∪ 弱），决定要跟着一起拷进保管库的文件 */
  imports?: string[]
  /**
   * 只含硬引用（包的 import 表）。缺了它资产打开就是错的，所以只有这一类才拦截导入。
   *
   * 软引用（SoftPackageReferences）不在这里：UE 允许它指向工程里根本没有的资产
   * （典型的是引用 Epic 默认 Mannequin 的姿势资产），缺了不该把整组资产判死。
   * 没给这个字段时退回用 `imports`，保持老调用方的行为不变。
   */
  importsStrong?: string[]
  name?: string
}

export interface BackupResult {
  assetKey: string
  backupPath: string
  relativePath: string
}
