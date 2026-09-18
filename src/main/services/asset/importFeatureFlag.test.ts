import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getImportPreflight: vi.fn(),
  loadSession: vi.fn(),
  getFreshSession: vi.fn(),
  refreshSession: vi.fn()
}))

vi.mock('../../networkV2/ImportSessionClient', () => ({
  ImportSessionClient: vi.fn().mockImplementation(() => ({
    getImportPreflight: mocks.getImportPreflight
  }))
}))

import { checkV2ImportReadiness, clearCapabilityCache } from './importFeatureFlag'

const readyPreflight = {
  ready: true,
  status: 'ready',
  capabilities: {
    importSession: true,
    manifestRequired: true,
    manifestPathDigestUpload: true,
    reconcileBeforeCommit: true,
    failedRecoverable: true,
    preflight: true
  },
  checks: {
    storage: { ok: true }
  }
}

function makeHttpError(message: string, statusCode: number, errorCode?: string): Error {
  const err = new Error(message)
  ;(err as any).statusCode = statusCode
  if (errorCode) {
    ;(err as any).errorCode = errorCode
  }
  return err
}

beforeEach(() => {
  vi.clearAllMocks()
  clearCapabilityCache()
  mocks.loadSession.mockResolvedValue(null)
})

describe('checkV2ImportReadiness', () => {
  it('requires digest path upload capability before enabling V2 import', async () => {
    mocks.getImportPreflight.mockResolvedValueOnce({
      ...readyPreflight,
      capabilities: {
        importSession: true,
        manifestRequired: true,
        reconcileBeforeCommit: true,
        failedRecoverable: true,
        preflight: true
      }
    })

    const readiness = await checkV2ImportReadiness(
      'http://127.0.0.1:18900',
      'vault-a',
      'client-a',
      'ALL',
      1024
    )

    expect(readiness).toMatchObject({
      supported: false,
      ready: false,
      errorCode: 'SERVER_UPDATE_REQUIRED'
    })
  })

  it('maps a 403 from the asset server to a user-actionable message', async () => {
    mocks.getImportPreflight.mockRejectedValueOnce(makeHttpError('Forbidden', 403))

    const readiness = await checkV2ImportReadiness(
      'http://127.0.0.1:18900',
      'vault-a',
      'client-a',
      'folder-a',
      1024
    )

    expect(readiness).toMatchObject({
      supported: true,
      ready: false,
      errorCode: 'NAS_UPLOAD_PERMISSION_DENIED',
      userMessage: '资产服务器拒绝了这次上传，请检查这个库的访问码是不是只读的那一把'
    })
  })

  it('can bypass the negative server-capability cache for user-triggered retries', async () => {
    mocks.getImportPreflight.mockRejectedValueOnce(makeHttpError('not found', 404))

    const first = await checkV2ImportReadiness(
      'http://127.0.0.1:18900',
      'vault-a',
      'client-a',
      'ALL',
      1024
    )
    const cached = await checkV2ImportReadiness(
      'http://127.0.0.1:18900',
      'vault-a',
      'client-a',
      'ALL',
      1024
    )

    expect(first.errorCode).toBe('SERVER_UPDATE_REQUIRED')
    expect(cached.errorCode).toBe('SERVER_UPDATE_REQUIRED')
    expect(mocks.getImportPreflight).toHaveBeenCalledTimes(1)

    mocks.getImportPreflight.mockResolvedValueOnce(readyPreflight)
    const retried = await checkV2ImportReadiness(
      'http://127.0.0.1:18900',
      'vault-a',
      'client-a',
      'ALL',
      1024,
      { bypassCapabilityCache: true }
    )

    expect(retried).toMatchObject({
      supported: true,
      ready: true
    })
    expect(mocks.getImportPreflight).toHaveBeenCalledTimes(2)
  })
})
