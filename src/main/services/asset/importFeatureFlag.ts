/**
 * importFeatureFlag.ts — V2 Import Session 切流控制
 *
 * 决策逻辑：
 * 1. 环境变量 USE_V2_IMPORT_SESSION（缺省 'true'）
 * 2. 运行时 preflight：版本能力、服务端可写、空间、权限
 * 3. 旧服务端能力探测结果缓存 5 分钟
 */

import {
  ImportSessionClient,
  type ImportSessionPreflightResult
} from '../../networkV2/ImportSessionClient'

/** 缓存 key = `${serverUrl}|${vaultId}` */
const capabilityCache = new Map<string, { supported: boolean; ts: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

export interface V2ImportReadinessResult {
  supported: boolean
  ready: boolean
  errorCode?: string
  userMessage?: string
  preflight?: ImportSessionPreflightResult
}

export interface V2ImportReadinessOptions {
  bypassCapabilityCache?: boolean
  apiKey?: string
}

function getErrorStatusCode(err: unknown): number | null {
  const value =
    typeof err === 'object' && err && 'statusCode' in err ? Number((err as any).statusCode) : NaN
  return Number.isFinite(value) ? value : null
}

function getErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err && 'errorCode' in err
    ? String((err as any).errorCode || '')
    : undefined
}

function hasRequiredImportProtocol(preflight: ImportSessionPreflightResult): boolean {
  const capabilities = preflight.capabilities || {}
  return Boolean(
    capabilities.importSession &&
      capabilities.manifestRequired &&
      capabilities.manifestPathDigestUpload &&
      capabilities.reconcileBeforeCommit &&
      capabilities.failedRecoverable &&
      capabilities.preflight
  )
}

async function createImportSessionClient(
  serverUrl: string,
  vaultId: string,
  clientId: string,
  apiKey?: string
): Promise<ImportSessionClient> {
  return new ImportSessionClient({
    serverUrl,
    vaultId,
    clientId,
    apiKey
  })
}

export async function checkV2ImportReadiness(
  serverUrl: string,
  vaultId: string,
  clientId: string,
  targetFolderKey?: string | null,
  expectedUploadBytes?: number,
  options: V2ImportReadinessOptions = {}
): Promise<V2ImportReadinessResult> {
  const envFlag = process.env.USE_V2_IMPORT_SESSION
  if (envFlag === 'false' || envFlag === '0') {
    return {
      supported: false,
      ready: false,
      errorCode: 'V2_IMPORT_DISABLED',
      userMessage: '当前客户端已关闭 NAS V2 导入，请联系管理员检查客户端配置'
    }
  }

  const cacheKey = `${serverUrl}|${vaultId}`
  const cached = capabilityCache.get(cacheKey)
  if (
    !options.bypassCapabilityCache &&
    cached &&
    !cached.supported &&
    Date.now() - cached.ts < CACHE_TTL_MS
  ) {
    return {
      supported: false,
      ready: false,
      errorCode: 'SERVER_UPDATE_REQUIRED',
      userMessage: '当前 NAS 服务器版本过旧，请更新 NAS V2 服务端后再导入'
    }
  }

  try {
    const client = await createImportSessionClient(serverUrl, vaultId, clientId, options.apiKey)
    const preflight = await client.getImportPreflight(targetFolderKey || 'ALL', expectedUploadBytes)
    if (!hasRequiredImportProtocol(preflight)) {
      capabilityCache.set(cacheKey, { supported: false, ts: Date.now() })
      return {
        supported: false,
        ready: false,
        errorCode: 'SERVER_UPDATE_REQUIRED',
        userMessage: '当前 NAS 服务器版本过旧，请更新 NAS V2 服务端后再导入',
        preflight
      }
    }
    if (!preflight.ready) {
      return {
        supported: true,
        ready: false,
        errorCode: 'IMPORT_PREFLIGHT_BLOCKED',
        userMessage: preflight.userMessage || preflight.blockers?.[0] || 'NAS V2 导入前体检未通过',
        preflight
      }
    }

    capabilityCache.set(cacheKey, { supported: true, ts: Date.now() })
    console.log('[ImportFeatureFlag] V2 Import Session preflight passed')
    return {
      supported: true,
      ready: true,
      preflight
    }
  } catch (err: unknown) {
    const statusCode = getErrorStatusCode(err)
    const errorCode = getErrorCode(err)
    const msg = err instanceof Error ? err.message : String(err)

    if (errorCode === 'VAULT_NOT_FOUND') {
      return {
        supported: true,
        ready: false,
        errorCode,
        userMessage: '当前 NAS 资产库不存在或已被删除，请重新连接 NAS V2 服务器后再导入'
      }
    }

    if (errorCode === 'TARGET_FOLDER_NOT_FOUND') {
      return {
        supported: true,
        ready: false,
        errorCode,
        userMessage: '目标文件夹不存在或已被删除，请刷新资产库后重试'
      }
    }

    if (statusCode === 401) {
      return {
        supported: true,
        ready: false,
        errorCode: errorCode || 'NAS_AUTH_REQUIRED',
        userMessage: '登录状态已过期，请重新登录后再导入'
      }
    }

    if (statusCode === 403) {
      return {
        supported: true,
        ready: false,
        errorCode: errorCode || 'NAS_UPLOAD_PERMISSION_DENIED',
        userMessage: msg.includes('管理员 KEY')
          ? '当前资产库为只读模式，需要管理员 KEY 才能上传或覆盖'
          : '资产服务器拒绝了这次上传，请检查这个库的访问码是不是只读的那一把'
      }
    }

    if (statusCode === 404) {
      capabilityCache.set(cacheKey, { supported: false, ts: Date.now() })
      return {
        supported: false,
        ready: false,
        errorCode: 'SERVER_UPDATE_REQUIRED',
        userMessage: '当前 NAS 服务器版本过旧，请更新 NAS V2 服务端后再导入'
      }
    }

    if (statusCode === 426 || errorCode === 'CLIENT_UPDATE_REQUIRED') {
      return {
        supported: true,
        ready: false,
        errorCode: 'CLIENT_UPDATE_REQUIRED',
        userMessage: '请更新客户端后再导入'
      }
    }

    console.warn(`[ImportFeatureFlag] V2 导入前体检失败: ${msg}`)
    return {
      supported: false,
      ready: false,
      errorCode: errorCode || 'NAS_SERVER_UNREACHABLE',
      userMessage: '无法连接 NAS V2 服务器，请检查服务器是否在线后再导入'
    }
  }
}

/**
 * 判断是否应走 V2 Import Session
 */
export async function shouldUseV2ImportSession(
  serverUrl: string,
  vaultId: string,
  clientId: string,
  targetFolderKey?: string | null
): Promise<boolean> {
  const readiness = await checkV2ImportReadiness(serverUrl, vaultId, clientId, targetFolderKey)
  return readiness.supported && readiness.ready
}

/** 清除能力缓存（测试用） */
export function clearCapabilityCache(): void {
  capabilityCache.clear()
}
