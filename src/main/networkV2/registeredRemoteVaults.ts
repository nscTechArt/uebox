/**
 * 「这个资产服务器地址是用户自己登记过的库吗」—— 只按本地登记表回答，不碰网络。
 *
 * 给 uebox-asset 代理用。代理原来只认**当前有活连接**的库：开机体检没过、服务器
 * 慢了一拍、或者用户还没填配对码，库就没有 SyncClient，于是每一张缩略图都被 403
 * 掉，整屏碎图 —— 而资产名字照常显示（那是本地镜像库读出来的），用户完全看不出
 * 是没连上。
 *
 * 连接是活是死，和「这个地址该不该信」是两件事。该不该信只取决于用户有没有把这个
 * 库加进来，那是登记表里的事实，跟此刻连没连上无关。所以代理先问活连接，问不到就
 * 问这里；两边都没有才拒绝 —— 外面随便一个 URL 依然进不来。
 */

export interface RegisteredVaultRow {
  id: string
  vaultType?: string
  networkPath?: string | null
}

export interface RegisteredRemoteVault {
  /** 本地库 id，用来取这个库存着的访问码 */
  localVaultId: string
}

/** 统一成和 `serverBase()` 同一套写法，两边才比得起来 */
function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * 在登记表里找这个「服务器 + 远端库 id」。
 *
 * 比的是拼回去的完整地址，而不是各自拆开再比：图里的地址本来就是渲染层把
 * `networkPath` 从最后一个斜杠劈开得来的，原样拼回去必须和登记的那条一模一样。
 * 这样就没有「怎么拆」的歧义，也不会有哪种拆法多放行一个库进来。
 *
 * 两处容易踩空，都必须照顾：
 *
 * **一、`remoteVaultId` 只能是一段。** 它来自图片地址里的查询参数，调用方说了算。
 * 允许它带斜杠，就等于允许「换一种拆法」去凑一条登记记录：库登记在
 * `https://host/team/vault_1` 时，`serverUrl=https://host` + `vaultId=team/vault_1`
 * 也能拼出同一个串，于是这个库的访问码会被发到 `https://host/api/...` —— 不是
 * `/team` 那个租户。旧写法拿服务端签发的 `remoteVaultId` 比对，天然没有这个口子。
 *
 * **二、两边得用同一套转义。** `networkPath` 过 `new URL().href` 会被百分号编码，
 * 而 `vaultId` 是 `searchParams.get()` 解出来的原文。库名带空格或中文时，一边是
 * `%E6%88%91`，一边是 `我`，永远对不上 —— 结果就是每张缩略图 403，正是这个文件
 * 要消灭的症状。所以拼之前先 `encodeURIComponent`，和 assetProxy 拼目标地址时
 * 用的那套对齐。
 */
export function findRegisteredRemoteVault(
  vaults: readonly RegisteredVaultRow[],
  requestedServer: string,
  remoteVaultId: string
): RegisteredRemoteVault | null {
  if (!requestedServer || !remoteVaultId) return null
  if (remoteVaultId.includes('/') || remoteVaultId.includes('\\')) return null

  const wanted = `${requestedServer}/${encodeURIComponent(remoteVaultId)}`

  for (const vault of vaults) {
    if (vault.vaultType !== 'network') continue
    if (normalizeHttpUrl(vault.networkPath) !== wanted) continue
    return { localVaultId: vault.id }
  }

  return null
}
