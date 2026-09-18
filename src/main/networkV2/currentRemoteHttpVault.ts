import { getDatabaseManager } from '../sqliteDataBase'
import { VaultType, type VaultInfo } from '../sqliteDataBase/VaultManager'
import { VaultServiceManager } from './VaultServiceManager'
import type { SyncClient } from './SyncClient'

export interface CurrentRemoteHttpVaultContext {
  client: SyncClient
  currentVault: VaultInfo
  localVaultId: string
  remoteVaultId: string
  serverUrl: string
}

export function getCurrentRemoteHttpVaultContext(): CurrentRemoteHttpVaultContext | null {
  try {
    const databaseManager = getDatabaseManager()
    const currentVault = databaseManager.getCurrentVault()
    if (
      !currentVault ||
      currentVault.vaultType !== VaultType.NETWORK ||
      !currentVault.networkPath ||
      (!currentVault.networkPath.startsWith('http://') &&
        !currentVault.networkPath.startsWith('https://'))
    ) {
      return null
    }

    const vsm = VaultServiceManager.getInstance()
    if (vsm.getRole(currentVault.id) !== 'client') {
      return null
    }

    const client = vsm.getClient(currentVault.id)
    if (!client) {
      return null
    }

    return {
      client,
      currentVault,
      localVaultId: currentVault.id,
      remoteVaultId: client.remoteVaultId,
      serverUrl: client.serverUrl
    }
  } catch {
    return null
  }
}
