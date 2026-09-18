/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  commit: vi.fn(),
  preflight: vi.fn(async () => ({ supported: true, ready: true }))
}))
vi.mock('./importFeatureFlag', () => ({ checkV2ImportReadiness: mocks.preflight }))
vi.mock('../../networkV2/VaultServiceManager', () => ({ VaultServiceManager: {} }))
vi.mock('../../networkV2/ImportSessionClient', () => ({
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS: 1000,
  ImportSessionClient: class {
    createSession = async (): Promise<object> => ({ sessionId: 'test-session' })
    uploadManifest = async (): Promise<object> => ({})
    uploadMetadataChunk = async (): Promise<object> => ({ recordCount: 0 })
    uploadFileStream = mocks.upload
    commitSession = mocks.commit
  }
}))
import { runRemoteImport } from './RemoteImportService'

describe('remote import cancellation', () => {
  it('stops queued uploads and never submits a cancelled batch for commit', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'remote-cancel-'))
    try {
      const controller = new AbortController()
      const files = Array.from({ length: 8 }, (_, i) => ({
        path: join(root, `${i}.bin`),
        name: `${i}.bin`
      }))
      await Promise.all(files.map((file) => fs.writeFile(file.path, 'content')))
      mocks.upload.mockImplementation(async (_session: string, _path: string, stream: Readable) => {
        controller.abort()
        for await (const chunk of stream) {
          void chunk
        }
      })
      const result = await runRemoteImport({
        serverUrl: 'http://example.invalid',
        vaultId: 'test',
        clientId: 'test',
        files,
        folders: [],
        assets: [],
        thumbnails: [],
        rootFolderPath: root,
        signal: controller.signal
      })
      expect(mocks.upload).toHaveBeenCalledOnce()
      expect(mocks.commit).not.toHaveBeenCalled()
      expect(result.status).toBe('failed')
      expect(result.sessionId).toBe('test-session')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
