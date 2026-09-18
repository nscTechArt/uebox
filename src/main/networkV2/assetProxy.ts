import { net } from 'electron'
import { VaultManager } from '../sqliteDataBase/VaultManager'
import { VaultServiceManager } from './VaultServiceManager'
import { findRegisteredRemoteVault } from './registeredRemoteVaults'
import { resolveVaultAccessKey, vaultAccessKeyHeaders } from './vaultAccessKeys'

function serverBase(value: string): string | null {
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
 * 已登记的远端库 → 本地库 id 的运行期快查表。
 *
 * 为什么要缓存：`getAllVaults()` 是一次全表扫描 + 每个网络库额外一次 app_settings
 * 查询，而这个函数是**每张缩略图**都会走的（protocol.handle 每次请求一次）。一屏
 * 50 张图就是 50 轮同步 SQLite，全压在主进程事件循环上，而且恰好发生在「库离线」
 * 这个本来就卡的场景里。登记表几乎不变，变的时候由 `forgetRegisteredVaults()` 清掉。
 */
const registeredVaultCache = new Map<string, string>()

/** 只给测试用 */
export function forgetRegisteredVaults(): void {
  registeredVaultCache.clear()
}

/**
 * 这个「服务器 + 库 id」该不该发凭据，以及发哪一把。
 *
 * 两条来源：
 *  - **活连接**：库正连着 —— 原来只有这一条。
 *  - **本地登记表**：库加过但此刻没连上（体检超时、服务器慢一拍）。只有这一条的
 *    时候缩略图会整片 403，而资产列表照常显示（列表读的是本地镜像库），用户看到
 *    的就是满屏碎图，猜不到是没连上。
 *
 * 认的是「用户登记过这个库」，不是「此刻连得上」。两条都查不到才拒绝，外面随便一个
 * URL 依然拿不到凭据。
 *
 * 返回 null = 不认识这个目标，**或者认识但手上没有可用的码**。两种都必须在发出任何
 * 请求之前拒掉：没码发出去也是 401，白白让一屏图各开一条挂到系统超时的连接。
 */
function resolveVaultHeaders(
  requestedServer: string,
  remoteVaultId: string
): Record<string, string> | null {
  const manager = VaultServiceManager.getInstance()
  const client = manager
    .getAllStates()
    .map((state) => manager.getClient(state.vaultId))
    .find(
      (candidate) =>
        candidate?.remoteVaultId === remoteVaultId &&
        serverBase(candidate.serverUrl) === requestedServer
    )
  // 活连接的码只在运行期表里，那张表可能被一次不带码的重连清空
  // （rememberVaultAccessKey(url, id, undefined) 是删除），所以取空了不能就此返回，
  // 得继续去查持久化的那把 —— 否则「连着的库」反而比「没连上的库」更拿不到图。
  if (client) {
    const liveHeaders = vaultAccessKeyHeaders(client.serverUrl, client.remoteVaultId)
    if (liveHeaders['X-API-Key']) return liveHeaders
  }

  try {
    // 只缓存命中：新加的库下一张图就能出来，不用等重启。没命中的是打错/外来地址，
    // 本来就少，多查一次无所谓。
    const cacheKey = `${requestedServer}/${remoteVaultId}`
    const vaultManager = VaultManager.getInstance()
    let localVaultId = registeredVaultCache.get(cacheKey)
    if (!localVaultId) {
      localVaultId = findRegisteredRemoteVault(
        vaultManager.getAllVaults(),
        requestedServer,
        remoteVaultId
      )?.localVaultId
      if (localVaultId) registeredVaultCache.set(cacheKey, localVaultId)
    }

    // 手填的配对码存在 app_settings；SMB 发现模式的码只在运行期表里，两条都要查
    const key = localVaultId
      ? resolveVaultAccessKey({
          storedKey: vaultManager.getNetworkVaultApiKey(localVaultId),
          serverUrl: requestedServer,
          remoteVaultId
        })
      : undefined
    if (key) return { 'X-API-Key': key }

    // 连着但一把码都没有：服务器可能本来就没开鉴权，照旧不带码发 —— 这条路一直是通的。
    if (client) return {}
    // 只在登记表里、又没有码：发出去必然 401，不如就地拒掉。一屏图各开一条连接
    // 挂到系统超时，比直接不显示更糟。
    return null
  } catch {
    // 登记表读不出来（数据库还没起来）就当不认识：宁可不显示，也不往不确定的地址发码
    return null
  }
}

/** 图片中的地址只能选择已登记的库，不能决定凭据发往哪里。 */
export async function serveRemoteAsset(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const requestedServer = serverBase(url.searchParams.get('serverUrl') || '')
  const vaultId = url.searchParams.get('vaultId')
  const relativePath = url.searchParams.get('path')
  if (!requestedServer || !vaultId || !relativePath) {
    return new Response('Invalid asset proxy parameters', { status: 400 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }

  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    return new Response('Invalid asset path', { status: 400 })
  }

  const headers = resolveVaultHeaders(requestedServer, vaultId)
  if (!headers) return new Response('Unknown asset server or vault', { status: 403 })

  const range = request.headers.get('range')
  if (range) headers.Range = range
  const target =
    `${requestedServer}/api/vaults/${encodeURIComponent(vaultId)}/files/` +
    segments.map(encodeURIComponent).join('/')
  return net.fetch(target, {
    method: request.method,
    headers,
    credentials: 'omit',
    // 即使可信服务器返回跳转，也不能把访问码或令牌带到另一个目标。
    redirect: 'error'
  })
}
