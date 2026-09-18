import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (
      file: string,
      args: string[],
      options: unknown
    ) => ({
      stdout: run(file, args, options),
      stderr: ''
    })
  })
  return { ...actual, execFile, default: { ...actual, execFile } }
})

import {
  extractMacProjectArgument,
  getMacEditorProjects,
  listMacEditorProcesses,
  parseMacEditorProcesses
} from './macUnrealProcesses'
import UnrealProcessDetector from './UnrealProcessDetector'

const editor =
  '/Users/Shared/Epic Games/UE_5.6/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor'
const directory = '/Users/dev/UE 工程'
const project = `${directory}/中文  双空格.uproject`

/**
 * 工程路径必须是 POSIX 字面量，不能用 tmpdir()：被测的是 Mac 专属逻辑，
 * 里面靠 `path.posix.isAbsolute` 判断绝对路径，而 tmpdir() 在 Windows 宿主上
 * 给的是 `C:\...` —— 那会让每条用例都走进 lsof 兜底分支，测的就不是原意了。
 * 路径既然不落盘，stat/readFile 就用这张表来回答。
 */
let entries: Map<string, 'file' | 'directory'>
beforeEach(() => {
  entries = new Map([[project, 'file']])
  run.mockReset()
  vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
    const kind = entries.get(String(target))
    if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { isFile: () => kind === 'file' } as never
  })
  vi.spyOn(fs, 'readFile').mockImplementation(async (target) => {
    if (String(target) !== project) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return JSON.stringify({ EngineAssociation: '5.6' })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Mac process parsing', () => {
  it('accepts UE4 and UE5 editors while excluding commandlets, helpers and unrelated commands', () => {
    expect(
      parseMacEditorProcesses(
        `12 ${editor}\n13 /UE4Editor\n14 /UnrealEditor-Cmd\n15 /CrashReportClient\n16 /bin/sh\n0 /UnrealEditor\nbad`
      )
    ).toEqual([
      { pid: 12, executable: editor, processName: 'UnrealEditor' },
      { pid: 13, executable: '/UE4Editor', processName: 'UE4Editor' }
    ])
  })

  it.each([
    'PROJECT -log',
    '"PROJECT" -log',
    "'PROJECT' -log",
    '-project=PROJECT -log',
    '-log -project="PROJECT"',
    '-Project=PROJECT'
  ])('preserves spaces and quotes in %s', (args) => {
    expect(extractMacProjectArgument(`${editor} ${args.replace('PROJECT', project)}`, editor)).toBe(
      project
    )
  })

  it('does not mistake a log destination or another executable for a project', () => {
    expect(extractMacProjectArgument(`${editor} -log=${project}`, editor)).toBeNull()
    expect(extractMacProjectArgument(`/bin/echo ${editor} ${project}`, editor)).toBeNull()
    expect(extractMacProjectArgument(`${editor}-Cmd ${project}`, editor)).toBeNull()
    expect(extractMacProjectArgument(editor, editor)).toBeNull()
  })
})

describe('Mac process detection', () => {
  it('matches filesystem aliases without conflating case-sensitive project paths', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    run.mockImplementation((_file, args) =>
      args.includes('-axo') ? `42 ${editor}` : `${editor} ${project}`
    )
    vi.spyOn(fs, 'realpath').mockImplementation(async (value) => {
      if (value === '/alias/game.uproject' || value === project) return '/real/Game.uproject'
      return '/real/game.uproject'
    })
    expect(
      (await UnrealProcessDetector.findRunningProjectByPath('/alias/game.uproject'))?.pid
    ).toBe(42)
    expect(
      await UnrealProcessDetector.findRunningProjectByPath('/different/game.uproject')
    ).toBeNull()
  })

  it('returns a real project and propagates metadata through the existing detector API', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    run.mockImplementation((_file, args) =>
      args.includes('-axo') ? `42 ${editor}` : `${editor} ${project} -log`
    )
    expect(await UnrealProcessDetector.getRunningProjects()).toEqual([
      {
        pid: 42,
        processName: 'UnrealEditor',
        projectPath: project,
        projectName: '中文  双空格',
        projectDir: directory,
        engineVersion: '5.6'
      }
    ])
    expect(run.mock.calls.every(([file]) => file === '/bin/ps')).toBe(true)
  })

  it('resolves relative paths against the editor cwd', async () => {
    run.mockImplementation((file, args) => {
      if (file === '/usr/sbin/lsof') return `p42\nfcwd\nn${directory}\n`
      return args.includes('-axo') ? `42 ${editor}` : `${editor} 中文  双空格.uproject -log`
    })
    expect((await getMacEditorProjects())[0].projectPath).toBe(project)
    expect(run).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      ['-a', '-p', '42', '-d', 'cwd', '-Fn'],
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('continues when one editor exits during inspection', async () => {
    run.mockImplementation((_file, args) => {
      if (args.includes('-axo')) return `41 ${editor}\n42 ${editor}`
      if (args.includes('41')) throw new Error('Process exited')
      return `${editor} ${project}`
    })
    expect((await getMacEditorProjects()).map((p) => p.pid)).toEqual([42])
  })

  it('ignores missing files, directories and inaccessible working directories', async () => {
    entries.set(`${directory}/folder.uproject`, 'directory')
    for (const argument of [
      `${directory}/missing.uproject`,
      `${directory}/folder.uproject`,
      'relative.uproject'
    ]) {
      run.mockImplementation((file, args) => {
        if (file === '/usr/sbin/lsof') throw new Error('Denied')
        return args.includes('-axo') ? `42 ${editor}` : `${editor} ${argument}`
      })
      expect(await getMacEditorProjects()).toEqual([])
    }
  })

  it('recognizes an editor at the project chooser without inventing a running project', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    run.mockImplementation((_file, args) => (args.includes('-axo') ? `42 ${editor}` : editor))
    expect(await UnrealProcessDetector.isUnrealEditorRunning()).toBe(true)
    expect(await UnrealProcessDetector.getRunningProjects()).toEqual([])
  })

  it('handles empty process lists and scan errors', async () => {
    run.mockReturnValue('')
    expect(await listMacEditorProcesses()).toEqual([])
    run.mockImplementation(() => {
      throw new Error('ps unavailable')
    })
    await expect(listMacEditorProcesses()).rejects.toThrow('ps unavailable')
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    expect(await UnrealProcessDetector.isUnrealEditorRunning()).toBe(false)
    expect(await UnrealProcessDetector.getRunningProjects()).toEqual([])
  })
})
