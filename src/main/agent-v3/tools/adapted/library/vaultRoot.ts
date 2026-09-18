/**
 * 库工具共用的保管库根目录解析。
 *
 * 和 `ipc/libraryPackage.ts` 里那份是同一条规则：网络协作库的内容在
 * `networkPath` 上，本地库在 `path` 上 —— 取错了要么找不到包，
 * 要么把包写进本地缓存目录再也同步不出去。
 */

import { VaultManager, VaultType } from '../../../../sqliteDataBase/VaultManager'

export function getVaultRoot(): string | null {
  const vault = VaultManager.getInstance().getCurrentVault()
  if (!vault) return null
  if (vault.vaultType === VaultType.NETWORK) return vault.networkPath || null
  return vault.path || null
}

export function requireVaultRoot(): { vaultRoot: string } | { error: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) {
    return { error: '当前没有打开的保管库。先在资产库里选一个保管库再试。' }
  }
  return { vaultRoot }
}
