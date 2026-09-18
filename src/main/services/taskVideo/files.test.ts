/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { recoverMediaFile, retryMediaFile, saveMediaFile } from './files'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

it('retries transient sharing violations but does not retry unrelated failures', async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }))
    .mockResolvedValue('ok')
  expect(await retryMediaFile(operation)).toBe('ok')
  expect(operation).toHaveBeenCalledTimes(2)
  const denied = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(retryMediaFile(denied)).rejects.toThrow('denied')
  expect(denied).toHaveBeenCalledTimes(1)
})

it('retains and verifies complete paid audio after a persistent rename lock', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'video-lock-'))
  dirs.push(dir)
  const file = path.join(dir, 'voice.pcm')
  const rename = vi
    .spyOn(fs, 'rename')
    .mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }))
  await expect(saveMediaFile(file, Buffer.from('complete audio'))).rejects.toThrow('同一请求')
  expect(rename).toHaveBeenCalledTimes(6)
  rename.mockRestore()
  await recoverMediaFile(file)
  expect(await fs.readFile(file, 'utf8')).toBe('complete audio')
  await expect(fs.stat(`${file}.pending.sha256`)).rejects.toMatchObject({ code: 'ENOENT' })
}, 10000)

it('refuses an incomplete saved result instead of accepting partial audio', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'video-partial-'))
  dirs.push(dir)
  const file = path.join(dir, 'voice.pcm')
  await fs.writeFile(`${file}.pending.sha256`, 'not-the-hash')
  await fs.writeFile(`${file}.pending`, 'partial')
  await expect(recoverMediaFile(file)).rejects.toThrow('不会自动重复生成')
})
