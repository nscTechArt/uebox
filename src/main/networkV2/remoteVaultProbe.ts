/**
 * 直连远端资产服务器前的健康探测。
 *
 * 单独成模块的理由：这段逻辑原来内联在 `VaultManager.startV2NetworkService` 里，
 * 而 VaultManager import 了 electron，没法单测 —— 于是「探测请求忘了带资产库
 * 访问码」这个缺陷一直没人发现。服务端从 v3 起连列举资产库的接口都要凭据，
 * 探测拿到 401 就直接判定离线、SyncClient 根本不启动：**用户填对了配对码也没用，
 * 重启一次应用，直连库就永久离线。**
 *
 * 探测地址由调用方拼好传进来（保持在 VaultManager 那一侧），本文件不 import
 * electron，可以直接单测。
 */

/** 探测超时。服务器不可达时不要拖住切库主线程 */
const DEFAULT_PROBE_TIMEOUT_MS = 3000

export interface RemoteVaultProbeInput {
  /** 探测地址：服务器上「列举本码能打开哪些库」的那个接口 */
  probeUrl: string
  /** 报错文案里显示的地址，默认用 probeUrl。传服务器根地址能让提示短一些 */
  displayUrl?: string
  /** 资产库访问码（配对码 / 管理码）。内嵌资产服务器从 v3 起必需 */
  apiKey?: string
  timeoutMs?: number
  /** 注入点，仅测试用 */
  fetchImpl?: typeof fetch
}

export type RemoteVaultProbeResult =
  | { ok: true }
  | { ok: false; error: string; status?: number; authFailed?: boolean }

/** 资产库访问码走 X-API-Key，内嵌资产服务器从 v3 起必需 */
export function buildRemoteVaultProbeHeaders(
  input: Pick<RemoteVaultProbeInput, 'apiKey'>
): Record<string, string> {
  const apiKey = input.apiKey?.trim()
  return apiKey ? { 'X-API-Key': apiKey } : {}
}

/** 读响应体里的 errorCode，读不出来就算了 —— 探测失败的判定不依赖它 */
async function readErrorCode(resp: Response): Promise<string | undefined> {
  try {
    const body = (await resp.json()) as { errorCode?: unknown }
    return typeof body?.errorCode === 'string' ? body.errorCode : undefined
  } catch {
    return undefined
  }
}

function describeAuthFailure(
  status: number,
  errorCode: string | undefined,
  hasApiKey: boolean
): string {
  if (errorCode === 'AUTH_REQUIRED' || (!hasApiKey && status === 401)) {
    return '资产服务器需要访问码：请在资产库设置里填写主机显示的配对码'
  }
  if (errorCode === 'AUTH_INVALID') {
    return '资产库访问码不正确或已被主机轮换，请重新填写配对码'
  }
  if (errorCode === 'AUTH_RATE_LIMITED') {
    return '认证失败次数过多，主机已临时限流，请稍后再试'
  }
  return `资产服务器认证失败 (HTTP ${status})`
}

export async function probeRemoteVault(
  input: RemoteVaultProbeInput
): Promise<RemoteVaultProbeResult> {
  const doFetch = input.fetchImpl ?? fetch
  const headers = buildRemoteVaultProbeHeaders(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)

  try {
    const resp = await doFetch(input.probeUrl, {
      signal: controller.signal,
      headers: Object.keys(headers).length > 0 ? headers : undefined
    })

    if (resp.ok) return { ok: true }

    if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
      const errorCode = await readErrorCode(resp)
      return {
        ok: false,
        status: resp.status,
        authFailed: true,
        error: describeAuthFailure(resp.status, errorCode, Boolean(input.apiKey?.trim()))
      }
    }
    if (resp.status === 404) {
      return {
        ok: false,
        status: 404,
        error: '资产服务器接口不存在 (HTTP 404), 请检查服务器版本'
      }
    }
    return {
      ok: false,
      status: resp.status,
      error: `资产服务器响应异常 (HTTP ${resp.status})`
    }
  } catch (err) {
    const where = input.displayUrl || input.probeUrl
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `资产服务器连接超时 (${where})` }
    }
    return {
      ok: false,
      error: `资产服务器不可达 (${where}): ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    clearTimeout(timeout)
  }
}
