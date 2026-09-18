// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), activate: vi.fn(), target: vi.fn() }))
vi.mock('child_process', () => {
  const exec = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.exec })
  return { exec, default: { exec } }
})
vi.mock('../../../../utils/macEditorActivation', () => ({ activateMacEditor: mocks.activate }))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetProjectPath: mocks.target }))
import { foregroundUnrealEditorWindow } from './foregroundEditorWindow'
beforeEach(() => {
  mocks.exec.mockReset().mockResolvedValue({ stdout: '' })
  mocks.activate.mockReset().mockResolvedValue(true)
  mocks.target.mockReset().mockReturnValue('/project/Game.uproject')
})
afterEach(() => vi.unstubAllGlobals())

it('keeps the Windows activation command and does not invoke the Mac helper', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  await foregroundUnrealEditorWindow('[Test]')
  expect(mocks.exec).toHaveBeenCalledWith(expect.stringContaining('WScript.Shell'), {
    timeout: 2000
  })
  expect(mocks.activate).not.toHaveBeenCalled()
})
it('activates the bound Mac editor without invoking PowerShell', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  await foregroundUnrealEditorWindow('[Test]')
  expect(mocks.activate).toHaveBeenCalledWith('/project/Game.uproject')
  expect(mocks.exec).not.toHaveBeenCalled()
})
it('does not interrupt sampling when native activation fails', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  mocks.activate.mockRejectedValue(new Error('activation denied'))
  await expect(foregroundUnrealEditorWindow('[Test]')).resolves.toBeUndefined()
})
