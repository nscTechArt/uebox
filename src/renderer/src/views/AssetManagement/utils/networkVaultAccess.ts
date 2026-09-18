export const ENABLE_NETWORK_VAULT_KEY = 'assetManagement.enableNetworkVault'

export function readStoredNetworkVaultPreference(
  storage: Pick<Storage, 'getItem'>
): boolean | null {
  const raw = storage.getItem(ENABLE_NETWORK_VAULT_KEY)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

export function resolveNetworkVaultEnabled(options: { storedPreference: boolean | null }): boolean {
  return options.storedPreference !== false
}
