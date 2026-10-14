/**
 * @vitest-environment node
 *
 * `cpp_full_rebuild` 替掉的是「请用户关编辑器、跑 Build.bat」那句话，所以要钉住的是：
 *   - 关编辑器那一步守住未保存的改动（和 ue_restart_editor 同一道闸）；
 *   - 插件连不上时不擅自杀进程，除非用户同意丢改动；
 *   - 编不过时第一句是 ✗、带行号、编辑器保持关着；编过了才重开并连回来；
 *   - Target 按文件内容认，不按名字猜。
 */

import { EventEmitter } from 'events'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { effectiveRisk } from '../../defineTool'

const callRequest = vi.fn()
const findRunningProjectByPath = vi.fn()
const openPath = vi.fn()
const awaitProjectLive = vi.fn()
const spawnMock = vi.fn()
const readdir = vi.fn()
const readFile = vi.fn()
const access = vi.fn()
const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

vi.mock('electron', () => ({ shell: { openPath: (p: string) => openPath(p) } }))
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))
vi.mock('fs', () => ({
  promises: {
    readdir: (...a: unknown[]) => readdir(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    access: (...a: unknown[]) => access(...a)
  }
}))
vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest }) }
}))
vi.mock('../../../../services/project', () => ({
  projectManager: {
    getProject: () => ({ projectPath: 'H:/Dev/MyGame' }),
    getInteractiveProjects: () => [{ projectPath: 'H:/Dev/MyGame', connectionId: 'conn-1' }]
  }
}))
vi.mock('../../../../utils/UnrealProcessDetector', () => ({
  default: { findRunningProjectByPath: (p: string) => findRunningProjectByPath(p) }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => 'H:/Dev/MyGame'
}))
vi.mock('../../../core/team/editorWatch', () => ({ expectEditorClose: vi.fn() }))
vi.mock('../project/awaitProjectLive', () => ({
  awaitProjectLive: (a: unknown) => awaitProjectLive(a)
}))
vi.mock('../../../../sqliteDataBase/ipc/project', () => ({
  ensureUnrealAgentLinkPlugin: vi.fn(async () => undefined)
}))
vi.mock('../../builtin/projectPackage', () => ({
  findUproject: async (dir: string) => `${dir}/MyGame.uproject`,
  engineRootFor: async () => 'D:/UE_5.5',
  lowerPriority: vi.fn(),
  killTree: vi.fn(),
  quoteForCmd: (a: string) => a
}))

import {
  buildArgs,
  buildScript,
  createCppFullRebuildTool,
  describeBuild,
  pickEditorTarget,
  pickGameTarget
} from './fullRebuild'

type Executable = {
  execute: (
    id: string,
    params: unknown
  ) => Promise<{ content?: { text?: string }[]; details?: Record<string, unknown> }>
}

/** 一个假的子进程：吐一段输出，然后以给定退出码结束 */
function fakeChild(output: string, code: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new EventEmitter()
  child.stdout = stdout
  child.stderr = new EventEmitter()
  child.pid = 4242
  setTimeout(() => {
    stdout.emit('data', Buffer.from(output))
    child.emit('close', code)
  }, 0)
  return child
}

const EDITOR_TARGET = 'public class MyGameEditorTarget : TargetRules { Type = TargetType.Editor; }'

async function run(input: Record<string, unknown> = {}): Promise<string> {
  const tool = createCppFullRebuildTool() as unknown as Executable
  const r = await tool.execute('c1', input)
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

beforeEach(() => {
  vi.useRealTimers()
  for (const m of [callRequest, findRunningProjectByPath, openPath, awaitProjectLive, spawnMock]) {
    m.mockReset()
  }
  killSpy.mockClear()
  readdir.mockReset().mockResolvedValue(['MyGame.Target.cs', 'MyGameEditor.Target.cs'])
  readFile
    .mockReset()
    .mockImplementation(async (p: string) =>
      p.endsWith('MyGameEditor.Target.cs') ? EDITOR_TARGET : 'Type = TargetType.Game;'
    )
  access.mockReset().mockResolvedValue(undefined)
  openPath.mockResolvedValue('')
  awaitProjectLive.mockResolvedValue({ live: true, retargeted: true })
})

describe('纯函数', () => {
  it('按 TargetType.Editor 认编辑器 Target，多个时优先 <工程名>Editor', () => {
    expect(
      pickEditorTarget('MyGame', [
        { file: 'MyGame.Target.cs', content: 'Type = TargetType.Game;' },
        { file: 'Tools.Target.cs', content: 'Type = TargetType.Editor;' },
        { file: 'MyGameEditor.Target.cs', content: 'Type = TargetType . Editor ;' }
      ])
    ).toBe('MyGameEditor')
    // 改过名的工程：名字对不上也认内容
    expect(
      pickEditorTarget('MyGame', [{ file: 'StudioEd.Target.cs', content: 'TargetType.Editor' }])
    ).toBe('StudioEd')
    expect(
      pickEditorTarget('MyGame', [{ file: 'MyGame.Target.cs', content: 'TargetType.Game' }])
    ).toBeNull()
  })

  it('三个平台的脚本和参数', () => {
    expect(buildScript('D:/UE_5.5', 'win32')).toBe(
      join('D:/UE_5.5', 'Engine', 'Build', 'BatchFiles', 'Build.bat')
    )
    expect(buildScript('/UE', 'darwin')).toBe(
      join('/UE', 'Engine', 'Build', 'BatchFiles', 'Mac', 'Build.sh')
    )
    expect(buildArgs('MyGameEditor', 'H:/Dev/MyGame/MyGame.uproject', 'win32')).toEqual([
      'MyGameEditor',
      'Win64',
      'Development',
      '-Project=H:/Dev/MyGame/MyGame.uproject',
      '-WaitMutex',
      '-utf8output'
    ])
    expect(buildArgs('X', 'y', 'linux')[1]).toBe('Linux')
  })

  it('编不过：第一句 ✗，带文件名和行号', () => {
    const r = describeBuild({
      exitCode: 6,
      minutes: 1.2,
      timedOut: false,
      output:
        "H:\\Dev\\MyGame\\Source\\MyGame\\SurvivorDirector.cpp(12): error C2065: 'Foo': undeclared identifier\n"
    })
    expect(r.ok).toBe(false)
    expect(r.text.startsWith('✗')).toBe(true)
    expect(r.text).toContain('SurvivorDirector.cpp')
    expect(r.text).toContain('12')
  })

  it('解析不出错误时给原文尾巴，不让原因消失', () => {
    const r = describeBuild({
      exitCode: 1,
      minutes: 0.1,
      timedOut: false,
      output: 'UHT: something odd'
    })
    expect(r.text).toContain('something odd')
  })
})

describe('cpp_full_rebuild', () => {
  it('不丢改动的那次按 mutating 走；discard_unsaved 才是 destructive', () => {
    const meta = createCppFullRebuildTool().unrealBox
    expect(meta.risk).toBe('destructive')
    expect(effectiveRisk(meta, {})).toBe('mutating')
    expect(effectiveRisk(meta, { discard_unsaved: false })).toBe('mutating')
    expect(effectiveRisk(meta, { discard_unsaved: true })).toBe('destructive')
  })

  it('有未保存的改动：拒绝并列清单，不编译', async () => {
    findRunningProjectByPath.mockResolvedValue({ pid: 99 })
    callRequest.mockResolvedValue({
      __rpc: { code: 409 },
      details: { unsaved: ['/Game/Maps/Main'], unsaved_count: 1 }
    })

    await expect(run()).rejects.toThrow('/Game/Maps/Main')
    expect(callRequest.mock.calls[0][0]).toBe('editor.quit')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('插件连不上又没同意丢改动：不杀进程，说清楚怎么办', async () => {
    findRunningProjectByPath.mockResolvedValue({ pid: 99 })
    const { projectManager } = await import('../../../../services/project')
    const spy = vi.spyOn(projectManager, 'getInteractiveProjects').mockReturnValue([])
    const spy2 = vi.spyOn(projectManager, 'getProject').mockReturnValue(undefined as never)

    await expect(run()).rejects.toThrow('discard_unsaved')
    expect(killSpy).not.toHaveBeenCalled()
    spy.mockRestore()
    spy2.mockRestore()
  })

  it('没有编辑器 Target（纯蓝图工程）：指回 cpp_add_class，不碰编辑器', async () => {
    readdir.mockResolvedValue([])

    await expect(run()).rejects.toThrow('cpp_add_class')
    expect(findRunningProjectByPath).not.toHaveBeenCalled()
  })

  it('编过了：关编辑器 → 编译 → 重开并连回来', async () => {
    // 第一次查：开着；之后：已经关了
    findRunningProjectByPath.mockResolvedValueOnce({ pid: 99 }).mockResolvedValue(null)
    callRequest.mockResolvedValue({ ok: true, closing: true })
    spawnMock.mockImplementation(() => fakeChild('Result: Succeeded\n', 0))

    const tool = createCppFullRebuildTool() as unknown as Executable
    const r = await tool.execute('c1', {})
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')

    expect(text.startsWith('✓ 编译成功')).toBe(true)
    expect(text).toContain('已关闭编辑器')
    expect(text).toContain('连上')
    expect(openPath).toHaveBeenCalledWith('H:/Dev/MyGame/MyGame.uproject')
    expect(r.details).toMatchObject({ closedEditor: true, built: true, reopened: true, live: true })
  })

  it('编不过：编辑器保持关着，不重开', async () => {
    findRunningProjectByPath.mockResolvedValue(null)
    spawnMock.mockImplementation(() =>
      fakeChild('H:\\Dev\\MyGame\\Source\\MyGame\\A.cpp(3): error C2143: syntax error\n', 6)
    )

    const text = await run()

    expect(text.startsWith('✗')).toBe(true)
    expect(text).toContain('A.cpp')
    expect(text).toContain('保持关着')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('编不过但要求还给用户：照样重开', async () => {
    findRunningProjectByPath.mockResolvedValue(null)
    spawnMock.mockImplementation(() => fakeChild('error: boom\n', 6))

    await run({ reopen_on_failure: true })

    expect(openPath).toHaveBeenCalled()
  })

  it('Live Coding 控制台还没退干净：等一下重试，不报成编译失败', async () => {
    vi.useFakeTimers()
    findRunningProjectByPath.mockResolvedValue(null)
    spawnMock
      .mockImplementationOnce(() => fakeChild('Unable to build while Live Coding is active.\n', 6))
      .mockImplementation(() => fakeChild('Result: Succeeded\n', 0))

    const pending = run()
    await vi.runAllTimersAsync()
    const text = await pending

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(text.startsWith('✓')).toBe(true)
  })

  /**
   * 编辑器 Target 带着 WITH_EDITOR，Runtime 模块里漏包的编辑器代码开发时全绿，
   * 打包那天才红。这条路只编游戏 Target，编辑器碰都不碰。
   */
  describe('game_target_only：只编游戏 Target', () => {
    it('不关编辑器、不重开，编的是游戏 Target', async () => {
      spawnMock.mockImplementation(() => fakeChild('Result: Succeeded\n', 0))

      const tool = createCppFullRebuildTool() as unknown as Executable
      const r = await tool.execute('c1', { game_target_only: true })
      const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')

      expect(text.startsWith('✓ 编译成功')).toBe(true)
      expect(callRequest).not.toHaveBeenCalled()
      expect(findRunningProjectByPath).not.toHaveBeenCalled()
      expect(openPath).not.toHaveBeenCalled()
      expect(JSON.stringify(spawnMock.mock.calls[0])).toContain('MyGame Win64 Development')
      expect(r.details).toMatchObject({ closedEditor: false, built: true, target: 'MyGame' })
    })

    it('编不过：点出 WITH_EDITOR 这条常见原因，编辑器还开着', async () => {
      spawnMock.mockImplementation(() =>
        fakeChild(
          'H:\\Dev\\MyGame\\Source\\MyGame\\A.cpp(3): error C1083: Cannot open include file\n',
          6
        )
      )

      const text = await run({ game_target_only: true })

      expect(text.startsWith('✗')).toBe(true)
      expect(text).toContain('A.cpp')
      expect(text).toContain('WITH_EDITOR')
      expect(openPath).not.toHaveBeenCalled()
    })

    it('丢改动的开关在这条路上不生效，所以不算 destructive', () => {
      const meta = createCppFullRebuildTool().unrealBox
      expect(effectiveRisk(meta, { game_target_only: true, discard_unsaved: true })).toBe(
        'mutating'
      )
    })

    it('没有游戏 Target：说清楚，不编', async () => {
      readdir.mockResolvedValue(['MyGameEditor.Target.cs'])
      readFile.mockResolvedValue(EDITOR_TARGET)

      await expect(run({ game_target_only: true })).rejects.toThrow(/没有游戏 Target/)
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('按 TargetType.Game 认，多个时优先和工程同名的', () => {
      expect(
        pickGameTarget('MyGame', [
          { file: 'Server.Target.cs', content: 'TargetType.Server' },
          { file: 'Demo.Target.cs', content: 'TargetType.Game' },
          { file: 'MyGame.Target.cs', content: 'Type = TargetType . Game ;' }
        ])
      ).toBe('MyGame')
      expect(
        pickGameTarget('MyGame', [{ file: 'X.Target.cs', content: 'TargetType.Editor' }])
      ).toBeNull()
    })
  })
})
