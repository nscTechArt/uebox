// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), projects: vi.fn(), run: vi.fn() }))
vi.mock('./macUnrealProcesses', () => ({
  listMacEditorProcesses: mocks.list,
  getMacEditorProjects: mocks.projects
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.run
  })
  return { ...actual, execFile, default: { ...actual, execFile } }
})
import { selectMacEditor, macActivationScript, activateMacEditor } from './macEditorActivation'

let directory: string
const first = { pid: 10, executable: '/UE/UnrealEditor', processName: 'UnrealEditor' }
const second = { ...first, pid: 20 }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'uebox-activate-'))
  writeFileSync(join(directory, 'First.uproject'), '{}')
  writeFileSync(join(directory, 'Second.uproject'), '{}')
  mocks.list.mockReset().mockResolvedValue([first])
  mocks.projects.mockReset().mockResolvedValue([
    { ...first, projectPath: join(directory, 'First.uproject') },
    { ...second, projectPath: join(directory, 'Second.uproject') }
  ])
  mocks.run.mockReset().mockResolvedValue({ stdout: 'true\n', stderr: '' })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('Mac editor activation', () => {
  it('does not choose arbitrarily when multiple editors are running', async () => {
    mocks.list.mockResolvedValue([first, second])
    expect(await selectMacEditor()).toBeNull()
    expect(await activateMacEditor()).toBe(false)
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('selects the explicitly bound project and rejects a missing target', async () => {
    expect((await selectMacEditor(join(directory, 'Second.uproject')))?.pid).toBe(20)
    expect(await selectMacEditor(join(directory, 'missing.uproject'))).toBeNull()
    expect(await selectMacEditor(directory)).toBeNull()
  })
  it('activates the only editor by PID with a bounded native command', async () => {
    expect(await activateMacEditor()).toBe(true)
    expect(mocks.run).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', macActivationScript(first)],
      expect.objectContaining({ timeout: 2000 })
    )
  })
  it('reports an unsuccessful activation without claiming the editor is foreground', async () => {
    mocks.run.mockResolvedValue({ stdout: 'false\n', stderr: '' })
    expect(await activateMacEditor()).toBe(false)
  })
  it('quotes executable paths as data and checks PID reuse', () => {
    const executable = '/UE/"quoted"/UnrealEditor'
    const script = macActivationScript({ ...first, executable })
    expect(script).toContain(`var expected = ${JSON.stringify(executable)};`)
    expect(script).toContain('app.executableURL.path')
    expect(() => macActivationScript({ ...first, pid: -1 })).toThrow()
  })
})
