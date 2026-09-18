export type UploadRetryBucket = 'default' | 'busy'

export interface UploadRetryState {
  defaultRetries: number
  busyRetries: number
}

export interface UploadRetryLimits {
  defaultMaxRetries: number
  busyMaxRetries: number
}

export interface UploadRetryDecision {
  bucket: UploadRetryBucket
  retriesUsed: number
  maxRetries: number
  shouldRetry: boolean
  nonRetriable: boolean
}

function getErrorCode(err: unknown): string {
  return typeof err === 'object' && err && 'errorCode' in err
    ? String((err as any).errorCode || '')
    : ''
}

function getStatusCode(err: unknown): number {
  return typeof err === 'object' && err && 'statusCode' in err
    ? Number((err as any).statusCode)
    : NaN
}

export function isBusyUploadError(err: unknown): boolean {
  return getErrorCode(err) === 'IMPORT_BUSY' || getStatusCode(err) === 429
}

export function isNonRetriableUploadError(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err)
  const errorCode = getErrorCode(err)
  const statusCode = getStatusCode(err)

  if (errorCode === 'INSUFFICIENT_STORAGE' || errorCode === 'SERVER_IO_ERROR') {
    return true
  }

  if (
    Number.isFinite(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429
  ) {
    return true
  }

  return (
    errMsg.includes('ENOSPC') ||
    /no space left on device/i.test(errMsg) ||
    /insufficient storage/i.test(errMsg)
  )
}

export function decideUploadRetry(
  err: unknown,
  state: UploadRetryState,
  limits: UploadRetryLimits
): UploadRetryDecision {
  const bucket: UploadRetryBucket = isBusyUploadError(err) ? 'busy' : 'default'
  const retriesUsed = bucket === 'busy' ? state.busyRetries : state.defaultRetries
  const maxRetries = bucket === 'busy' ? limits.busyMaxRetries : limits.defaultMaxRetries
  const nonRetriable = isNonRetriableUploadError(err)

  return {
    bucket,
    retriesUsed,
    maxRetries,
    nonRetriable,
    shouldRetry: !nonRetriable && retriesUsed < maxRetries
  }
}

export function getRetryAfterDelayMs(err: unknown): number | null {
  const raw =
    typeof err === 'object' && err && 'retryAfter' in err ? (err as any).retryAfter : undefined
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(250, seconds * 1000))
  }

  const retryAt = Date.parse(String(value))
  if (Number.isFinite(retryAt)) {
    return Math.min(60_000, Math.max(250, retryAt - Date.now()))
  }

  return null
}
