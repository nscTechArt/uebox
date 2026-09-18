/**
 * 资产库里两件到处都要用的小事。
 *
 * 它们原先长在 `assetPlatformCapabilities.ts` / `assetPlatformRuntimeAccess.ts` 里，
 * 是「资产平台」那套中控客户端的配套。平台整个删掉之后，这两件事本身还在 ——
 * 「当前库是不是一台 HTTP 网络库」和「把异常翻成一句人话」跟平台没有关系。
 */

export type AssetVaultLike = {
  id?: string | null
  vaultType?: string | null
  networkPath?: string | null
}

/** 当前库是不是走 HTTP 的网络库（相对于本地目录库、SMB 库） */
export const isHttpNetworkVault = (vault?: AssetVaultLike | null): boolean => {
  return (
    String(vault?.vaultType || '').toLowerCase() === 'network' &&
    /^https?:\/\//i.test(vault?.networkPath || '')
  )
}

/**
 * 把任意抛出物翻成一句能显示的话，翻不出来就用 fallback。
 *
 * 这里刻意**不做任何错误码到文案的映射**。上一版叫 `formatPlatformOperationError`，
 * 认得 `ASSET_PLATFORM_CAPABILITY_DENIED` 和 401，会把它们改写成
 * 「没有该目录所需的平台权限，请联系管理员调整授权」—— 那两条随平台一起没了。
 * 真要给某个错误配专门的文案，在调用处按 i18n key 写，别再在这里攒一张映射表。
 */
export const resolveErrorText = (error: unknown, fallback: string): string => {
  if (!error) return fallback
  if (typeof error === 'string') return error || fallback
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object') {
    const candidate = error as { error?: unknown; message?: unknown }
    return String(candidate.error || candidate.message || '') || fallback
  }
  return String(error) || fallback
}
