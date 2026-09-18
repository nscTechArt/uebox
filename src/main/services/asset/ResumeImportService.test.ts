import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publicDb: {},
  checkV2ImportReadiness: vi.fn(),
  getPublicDatabase: vi.fn(),
  loadImportRecoveryContext: vi.fn(),
  loadSession: vi.fn(),
  reconcileSession: vi.fn(),
  refreshSession: vi.fn(),
  saveImportRecoveryContext: vi.fn(),
  updateImportRecoveryContextStatus: vi.fn(),
  cancelSession: vi.fn()
}))

vi.mock('../../sqliteDataBase', () => ({
  getDatabaseManager: vi.fn(),
  getPublicDatabase: mocks.getPublicDatabase
}))

vi.mock('../../sqliteDataBase/models/importRecoveryContext', () => ({
  updateImportRecoveryContextStatus: mocks.updateImportRecoveryContextStatus
}))

vi.mock('./ImportRecoveryContextService', () => ({
  loadImportRecoveryContext: mocks.loadImportRecoveryContext,
  saveImportRecoveryContext: mocks.saveImportRecoveryContext
}))

vi.mock('./importFeatureFlag', () => ({
  checkV2ImportReadiness: mocks.checkV2ImportReadiness
}))

vi.mock('../../networkV2/ImportSessionClient', () => ({
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS: 30_000,
  ImportSessionClient: vi.fn().mockImplementation(() => ({
    reconcileSession: mocks.reconcileSession,
    cancelSession: mocks.cancelSession
  }))
}))

vi.mock('../../networkV2/VaultServiceManager', () => ({
  VaultServiceManager: {
    getInstance: vi.fn(() => ({
      getClient: vi.fn()
    }))
  }
}))

import { abandonImport, resumeImport } from './ResumeImportService'

const recoveryContext = {
  schemaVersion: 2 as const,
  createdAt: '2026-05-07T00:00:00.000Z',
  taskId: 'task-a',
  localVaultId: 'local-vault-a',
  serverUrl: 'http://127.0.0.1:18900',
  remoteVaultId: 'remote-vault-a',
  sessionId: 'session-a',
  rootFolderPath: 'C:/Import',
  files: [],
  thumbnails: []
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPublicDatabase.mockReturnValue(mocks.publicDb)
  mocks.loadSession.mockResolvedValue(null)
  mocks.loadImportRecoveryContext.mockResolvedValue(recoveryContext)
  mocks.checkV2ImportReadiness.mockResolvedValue({
    supported: true,
    ready: true
  })
  mocks.updateImportRecoveryContextStatus.mockReturnValue(true)
})

describe('abandonImport', () => {
  it('只有服务端回读到 cancelled 才算清掉了暂存区', async () => {
    mocks.cancelSession.mockResolvedValueOnce({ sessionId: 'session-a', status: 'cancelled' })

    const result = await abandonImport({ taskId: 'task-a' })

    expect(result).toMatchObject({
      success: true,
      sessionId: 'session-a',
      stagingCleared: true,
      locallyDismissed: true
    })
    expect(result.error).toBeUndefined()
    expect(mocks.updateImportRecoveryContextStatus).toHaveBeenLastCalledWith(
      mocks.publicDb,
      'task-a',
      'dismissed',
      null,
      null
    )
  })

  it('服务端 200 但状态不是 cancelled，不许报「已清理」', async () => {
    // 会话早就 committed：POST 不抛，可那几十 G 一点没动
    mocks.cancelSession.mockResolvedValueOnce({ sessionId: 'session-a', status: 'committed' })

    const result = await abandonImport({ taskId: 'task-a' })

    expect(result.stagingCleared).toBe(false)
    expect(result.error).toContain('committed')
    // 本地提示还是要消掉 —— 用户已经说了不要这一单
    expect(result.locallyDismissed).toBe(true)
  })

  it('取消失败照样标掉本地记录，但如实说暂存区没清', async () => {
    mocks.cancelSession.mockRejectedValueOnce(new Error('ECONNRESET'))

    const result = await abandonImport({ taskId: 'task-a' })

    expect(result).toMatchObject({
      success: true,
      stagingCleared: false,
      locallyDismissed: true,
      error: 'ECONNRESET'
    })
  })

  it('本地状态没写进去就如实说没写进去', async () => {
    mocks.cancelSession.mockResolvedValueOnce({ sessionId: 'session-a', status: 'cancelled' })
    mocks.updateImportRecoveryContextStatus.mockReturnValueOnce(false)

    const result = await abandonImport({ taskId: 'task-a' })

    expect(result.stagingCleared).toBe(true)
    expect(result.locallyDismissed).toBe(false)
  })

  it('找不到恢复上下文时不谎报成功', async () => {
    mocks.loadImportRecoveryContext.mockResolvedValueOnce(null)

    const result = await abandonImport({ taskId: 'task-a' })

    expect(result.success).toBe(false)
    expect(result.stagingCleared).toBe(false)
    expect(result.locallyDismissed).toBe(false)
    expect(mocks.cancelSession).not.toHaveBeenCalled()
  })
})

describe('resumeImport', () => {
  it('marks the local recovery record committed when the server session is already committed', async () => {
    mocks.reconcileSession.mockResolvedValueOnce({
      canResume: false,
      sessionStatus: 'committed',
      expected: { files: 0, thumbnails: 0 },
      staged: { files: 0, thumbnails: 0 },
      missingFiles: 0,
      missingThumbnails: 0
    })

    const result = await resumeImport({ taskId: 'task-a' })

    expect(result).toMatchObject({
      success: true,
      status: 'committed',
      uploadedFiles: 0,
      uploadedThumbnails: 0,
      committed: true,
      missingFiles: 0,
      missingThumbnails: 0,
      sessionId: 'session-a'
    })
    expect(mocks.updateImportRecoveryContextStatus).toHaveBeenLastCalledWith(
      mocks.publicDb,
      'task-a',
      'committed',
      null,
      null
    )
  })

  it('expires the local recovery record when the server session no longer exists', async () => {
    const sessionError = new Error('Session not found')
    ;(sessionError as any).errorCode = 'SESSION_NOT_FOUND'
    mocks.reconcileSession.mockRejectedValueOnce(sessionError)

    const result = await resumeImport({ taskId: 'task-a' })

    expect(result).toMatchObject({
      success: false,
      status: 'expired',
      sessionId: 'session-a'
    })
    expect(mocks.updateImportRecoveryContextStatus).toHaveBeenLastCalledWith(
      mocks.publicDb,
      'task-a',
      'expired',
      'Session not found',
      null
    )
  })
})
