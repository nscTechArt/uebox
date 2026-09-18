// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn(), realpath: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.run
  })
  return { ...actual, execFile, default: { ...actual, execFile } }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, realpathSync: mocks.realpath }
})
import { isBlenderRunning } from './blenderBridge'

const target = '/Applications/Blender 5.app/Contents/MacOS/Blender'
beforeEach(() => {
  mocks.run.mockReset()
  mocks.realpath.mockReset().mockImplementation((value: string) => value)
})

it('matches the configured Mac executable with spaces, not a different Blender version', async () => {
  mocks.run.mockResolvedValue({ stdout: '/Applications/Blender 4.app/Contents/MacOS/Blender\n' })
  expect(await isBlenderRunning(target, 'darwin')).toBe(false)
  mocks.run.mockResolvedValue({
    stdout: ` /Applications/Other.app/Contents/MacOS/Other\n${target}\n`
  })
  expect(await isBlenderRunning(target, 'darwin')).toBe(true)
  expect(mocks.run).toHaveBeenCalledWith('/bin/ps', ['-ww', '-axo', 'comm='], expect.any(Object))
})

it('resolves aliases without forcing case-insensitive comparison on Mac', async () => {
  mocks.realpath.mockImplementation((value: string) =>
    value === '/alias/Blender' ? target : value
  )
  mocks.run.mockResolvedValue({ stdout: '/alias/Blender\n' })
  expect(await isBlenderRunning(target, 'darwin')).toBe(true)
  mocks.run.mockResolvedValue({ stdout: target.toLowerCase() })
  expect(await isBlenderRunning(target, 'darwin')).toBe(false)
})

it('continues past inaccessible processes and fails softly if ps fails', async () => {
  mocks.realpath.mockImplementation((value: string) => {
    if (value === '/gone') throw new Error('ENOENT')
    return value
  })
  mocks.run.mockResolvedValue({ stdout: `/gone\n${target}\n` })
  expect(await isBlenderRunning(target, 'darwin')).toBe(true)
  mocks.run.mockRejectedValue(new Error('ps failed'))
  expect(await isBlenderRunning(target, 'darwin')).toBe(false)
})

it('retains the Windows encoded CIM query and case-insensitive comparison', async () => {
  mocks.run.mockResolvedValue({ stdout: 'C:/Blender/BLENDER.EXE\r\n' })
  expect(await isBlenderRunning('C:/Blender/blender.exe', 'win32')).toBe(true)
  const [command, args] = mocks.run.mock.calls[0]
  expect(command).toBe('powershell')
  expect(args.slice(0, 2)).toEqual(['-NoProfile', '-EncodedCommand'])
  expect(Buffer.from(args[2], 'base64').toString('utf16le')).toContain('Win32_Process')
  expect(mocks.realpath).not.toHaveBeenCalled()
})
