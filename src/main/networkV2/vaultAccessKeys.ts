/**
 * 进程内「远端资产服务器 → 访问码」表。
 *
 * 存在的理由：主进程里有一批调用点绕过 SyncClient 直接发 HTTP —— 缩略图存在性
 * 探测/上传、项目导入下载原文件、uebox-asset 协议代理、远程扫描、启动健康检查。
 * 它们手上只有 serverUrl + remoteVaultId，没有 SyncClient 实例，也就没法调
 * SyncClient 的取头方法。服务端加上鉴权之后，这些调用点如果不带码就会全部 401。
 *
 * 持久化仍在 VaultManager 的 app_settings（network_api_key:<localVaultId>），
 * 这里只是运行期的快查表，进程重启后由 VaultServiceManager 重新填充。
 */

const keys = new Map<string, string>()

function indexKey(serverUrl: string, remoteVaultId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}|${remoteVaultId}`
}

export function rememberVaultAccessKey(
  serverUrl: string,
  remoteVaultId: string,
  key?: string
): void {
  const index = indexKey(serverUrl, remoteVaultId)
  const value = key?.trim()
  if (value) keys.set(index, value)
  else keys.delete(index)
}

export function getVaultAccessKey(serverUrl: string, remoteVaultId: string): string | undefined {
  return keys.get(indexKey(serverUrl, remoteVaultId))
}

/** 直接拼进 headers 用 */
export function vaultAccessKeyHeaders(
  serverUrl: string,
  remoteVaultId: string
): Record<string, string> {
  const key = getVaultAccessKey(serverUrl, remoteVaultId)
  return key ? { 'X-API-Key': key } : {}
}

/**
 * 从完整的资产文件 URL 反推访问码请求头。
 *
 * 给那些只拿到一个完整 URL 的辅助函数用（缩略图上传/探测、导入下载），
 * 免得为了传 serverBase + vaultId 去改一长串函数签名。
 * URL 不是我们资产服务器的形状时返回空对象 —— 外部 URL 不该带我们的码。
 */
export function vaultAccessKeyHeadersFromUrl(fullUrl: string): Record<string, string> {
  try {
    const url = new URL(fullUrl)
    // 期望的路径段形如 api / vaults / <vaultId> / ...
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 3 || segments[0] !== 'api' || segments[1] !== 'vaults') return {}
    return vaultAccessKeyHeaders(`${url.protocol}//${url.host}`, decodeURIComponent(segments[2]))
  } catch {
    return {}
  }
}

/**
 * 一个本地网络库当前该用的访问码。
 *
 * 码有两条来源，必须都查：
 *  - **直连模式**：用户手填的配对码，持久化在 app_settings（调用方读出来当 storedKey 传进来）
 *  - **SMB 发现模式**：码来自共享目录里的 `.vault`，只落在本进程的运行期表里
 *
 * 只查其中一条，另一种模式下的调用点就会一律 401 —— 远程扫描、权限探测都踩过这个坑。
 * 手填的码优先：用户刚填的那把才是最新的意图。
 */
export function resolveVaultAccessKey(input: {
  storedKey?: string
  serverUrl?: string
  remoteVaultId?: string
}): string | undefined {
  const stored = input.storedKey?.trim()
  if (stored) return stored
  if (!input.serverUrl || !input.remoteVaultId) return undefined
  return getVaultAccessKey(input.serverUrl, input.remoteVaultId)
}

export function forgetVaultAccessKeys(): void {
  keys.clear()
}
