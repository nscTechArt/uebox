import { describe, expect, it } from 'vitest'
import {
  decideUploadRetry,
  getRetryAfterDelayMs,
  isBusyUploadError,
  isNonRetriableUploadError
} from './importUploadRetry'

function makeHttpError(statusCode: number, errorCode?: string): Error {
  const err = new Error(errorCode || `HTTP ${statusCode}`)
  ;(err as any).statusCode = statusCode
  if (errorCode) {
    ;(err as any).errorCode = errorCode
  }
  return err
}

describe('import upload retry policy', () => {
  it('treats IMPORT_BUSY as a separate long retry bucket', () => {
    const busy = makeHttpError(429, 'IMPORT_BUSY')

    expect(isBusyUploadError(busy)).toBe(true)
    expect(isNonRetriableUploadError(busy)).toBe(false)
    expect(
      decideUploadRetry(
        busy,
        { defaultRetries: 3, busyRetries: 119 },
        { defaultMaxRetries: 3, busyMaxRetries: 120 }
      )
    ).toMatchObject({
      bucket: 'busy',
      retriesUsed: 119,
      maxRetries: 120,
      shouldRetry: true
    })
  })

  it('stops retrying busy uploads after the busy retry budget is exhausted', () => {
    expect(
      decideUploadRetry(
        makeHttpError(429, 'IMPORT_BUSY'),
        { defaultRetries: 0, busyRetries: 120 },
        { defaultMaxRetries: 3, busyMaxRetries: 120 }
      )
    ).toMatchObject({
      bucket: 'busy',
      shouldRetry: false,
      nonRetriable: false
    })
  })

  it('keeps client errors other than timeout or busy as non-retriable', () => {
    const forbidden = makeHttpError(403, 'PLATFORM_CAPABILITY_DENIED')

    expect(isNonRetriableUploadError(forbidden)).toBe(true)
    expect(
      decideUploadRetry(
        forbidden,
        { defaultRetries: 0, busyRetries: 0 },
        { defaultMaxRetries: 3, busyMaxRetries: 120 }
      )
    ).toMatchObject({
      bucket: 'default',
      shouldRetry: false,
      nonRetriable: true
    })
  })

  it('honors Retry-After from the server', () => {
    const busy = makeHttpError(429, 'IMPORT_BUSY')
    ;(busy as any).retryAfter = '7'

    expect(getRetryAfterDelayMs(busy)).toBe(7000)
  })
})
