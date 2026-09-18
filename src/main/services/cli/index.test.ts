// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ home: '', read: vi.fn(), write: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'exe' ? join(mocks.home, 'unreal-agent.exe') : mocks.home)
  }
}))
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('./userPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  readUserPath: mocks.read,
  writeUserPath: mocks.write
}))
import { cliStatus, addToUserPath, removeFromUserPath } from './index'

beforeEach(() => {
  mocks.home = mkdtempSync(join(tmpdir(), 'uebox-cli-state-'))
  mocks.read.mockReset().mockResolvedValue('')
  mocks.write.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(mocks.home, { recursive: true, force: true })
})

it('registers and removes the Mac CLI without touching the Windows registry', async () => {
  const directory = join(mocks.home, 'cli', 'bin')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'uebox'), '')
  vi.stubGlobal('process', {
    ...process,
    platform: 'darwin',
    resourcesPath: mocks.home,
    env: { ...process.env, SHELL: '/bin/zsh' }
  })
  expect(await cliStatus()).toMatchObject({
    available: true,
    path: join(directory, 'uebox'),
    onPath: false
  })
  expect((await addToUserPath()).ok).toBe(true)
  expect((await cliStatus()).onPath).toBe(true)
  expect((await removeFromUserPath()).ok).toBe(true)
  expect((await cliStatus()).onPath).toBe(false)
  expect(mocks.read).not.toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
})

it('keeps the Windows launcher and registry PATH workflow', async () => {
  writeFileSync(join(mocks.home, 'uebox.cmd'), '')
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  expect(await cliStatus()).toMatchObject({ available: true, path: join(mocks.home, 'uebox.cmd') })
  expect((await addToUserPath()).ok).toBe(true)
  expect(mocks.write).toHaveBeenCalledWith(mocks.home)
})

it('reports a missing Mac launcher as unavailable', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: mocks.home })
  expect((await cliStatus()).available).toBe(false)
  expect((await addToUserPath()).ok).toBe(false)
})
