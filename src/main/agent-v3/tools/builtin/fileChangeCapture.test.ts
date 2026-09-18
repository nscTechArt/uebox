import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFile, withFileChangeLock } from './fileChangeCapture'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('./accessScope', () => ({ assertInAccessScope: async () => undefined }))
import { createLocalWriteTools } from './localShell'

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})
async function target(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'uebox-diff-'))
  folders.push(folder)
  return join(folder, 'sample.txt')
}
async function execute(
  name: string,
  params: unknown
): Promise<{ isError?: boolean; details?: Record<string, unknown> }> {
  const tool = createLocalWriteTools().find((entry) => entry.name === name)!
  return tool.execute('diff-test', params as never) as Promise<{
    isError?: boolean
    details?: Record<string, unknown>
  }>
}

describe('file changes from real writes', () => {
  it('serializes concurrent writes and releases the queue after failure', async () => {
    const path = await target()
    const results = await Promise.all([
      execute('write_local_file', { path, content: 'one' }),
      execute('write_local_file', { path, content: 'two' })
    ])
    expect(results[1].details?.fileChange).toMatchObject({ before: 'one', after: 'two' })
    await expect(
      withFileChangeLock(path, async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    await expect(withFileChangeLock(path, async () => 'released')).resolves.toBe('released')
  })
  it('preserves BOM and line endings in snapshots', async () => {
    const path = await target()
    await writeFile(path, '\uFEFFhello\r\n')
    expect(await captureFile(path)).toEqual({ text: '\uFEFFhello\r\n', missing: false })
  })
  it('captures create, edit, overwrite and keeps old snapshots immutable', async () => {
    const path = await target()
    const created = await execute('write_local_file', { path, content: 'first\n' })
    expect(created.details?.fileChange).toEqual({
      path,
      before: '',
      after: 'first\n',
      created: true
    })
    const edited = await execute('edit_local_file', {
      path,
      edits: [{ oldText: 'first', newText: 'second' }]
    })
    expect(edited.details?.fileChange).toEqual({
      path,
      before: 'first\n',
      after: 'second\n',
      created: false
    })
    const overwritten = await execute('write_local_file', { path, content: 'third' })
    expect(overwritten.details?.fileChange).toMatchObject({ before: 'second\n', after: 'third' })
    expect(edited.details?.fileChange).toMatchObject({ after: 'second\n' })
    expect(await readFile(path, 'utf8')).toBe('third')
  })
  it('does not claim a change when edit fails', async () => {
    const path = await target()
    await writeFile(path, 'original')
    await expect(
      execute('edit_local_file', { path, edits: [{ oldText: 'missing', newText: 'new' }] })
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('original')
  })
  it('distinguishes missing, binary, invalid UTF-8 and large files', async () => {
    const path = await target()
    expect(await captureFile(path)).toEqual({ text: '', missing: true })
    for (const data of [
      Buffer.from([0, 1]),
      Buffer.from([255]),
      Buffer.alloc(256 * 1024 + 1, 65)
    ]) {
      await writeFile(path, data)
      expect(await captureFile(path)).toBeUndefined()
    }
    const result = await execute('write_local_file', { path, content: 'small' })
    expect(result.details?.fileChange).toBeUndefined()
    expect(result.details?.fileChangeUnavailable).toBe(path)
  })
})
