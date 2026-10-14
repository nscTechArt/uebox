/**
 * @vitest-environment node
 *
 * `project_update_plugin` 替掉的是「请用户在盒子设置里更新插件后重启编辑器」那句话，要钉住的是：
 *   - 已经是最新就不碰编辑器（白关一次是实打实的打扰）；
 *   - 用户主动移除过的不装回去，除非明说；
 *   - 关编辑器守住未保存的改动 —— 包括没有 `editor.quit` 的旧插件（这个工具最常碰到的就是它们）；
 *   - 装没装上都把编辑器还给用户；装不上第一句就是 ✗，而且按错误抛；
 *   - 回执里的版本号是装完从磁盘读回来的，不是想当然的随包版本。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const findRunningProjectByPath = vi.fn()
const openPath = vi.fn()
const awaitProjectLive = vi.fn()
const getStatus = vi.fn()
const install = vi.fn()
const isProjectPluginUpToDate = vi.fn()
const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
let interactive: Array<{ projectPath: string; connectionId: string }> = []

vi.mock('electron', () => ({ shell: { openPath: (p: string) => openPath(p) } }))
vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest }) }
}))
vi.mock('../../../../services/project', () => ({
  projectManager: {
    getProject: () => undefined,
    getInteractiveProjects: () => interactive
  }
}))
vi.mock('../../../../utils/UnrealProcessDetector', () => ({
  default: { findRunningProjectByPath: (p: string) => findRunningProjectByPath(p) }
}))
vi.mock('../../../../utils/UnrealPathManager', () => ({
  default: {
    isSourceBuildGUID: () => false,
    resolveEngineVersionFromGUID: async () => null,
    isProjectPluginUpToDate: (...a: unknown[]) => isProjectPluginUpToDate(...a)
  }
}))
vi.mock('../../../../utils/ueTextFile', () => ({
  readUeJsonFile: async () => ({ EngineAssociation: '5.5' })
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => undefined,
  getTargetProjectPath: () => 'H:/Dev/MyGame'
}))
vi.mock('../../../core/team/editorWatch', () => ({ expectEditorClose: vi.fn() }))
vi.mock('./awaitProjectLive', () => ({ awaitProjectLive: (a: unknown) => awaitProjectLive(a) }))
vi.mock('../../../../sqliteDataBase/ipc/project', () => ({
  getUnrealAgentLinkStatus: (p: string) => getStatus(p),
  installUnrealAgentLinkPlugin: (p: string) => install(p)
}))
vi.mock('../../builtin/projectPackage', () => ({
  findUproject: async (dir: string) => `${dir}/MyGame.uproject`
}))

import { dirtyPackages, isUnknownMethod } from './closeEditor'
import { createProjectUpdatePluginTool, describeInstallFailure } from './updatePlugin'

type Executable = {
  execute: (
    id: string,
    params: unknown
  ) => Promise<{ content?: { text?: string }[]; details?: Record<string, unknown> }>
}

async function run(
  input: Record<string, unknown> = {}
): Promise<{ text: string; details?: Record<string, unknown> }> {
  const tool = createProjectUpdatePluginTool() as unknown as Executable
  const r = await tool.execute('c1', input)
  return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), details: r.details }
}

const OLD = {
  installed: true,
  version: '1.0.3',
  bundledVersion: '1.0.7',
  optedOut: false,
  enabledInUproject: true
}
const NEW = { ...OLD, version: '1.0.7' }

/** 编辑器开着、插件连着；关闭命令之后进程就没了 */
function editorOpenThenClosed(): void {
  interactive = [{ projectPath: 'H:/Dev/MyGame', connectionId: 'conn-1' }]
  findRunningProjectByPath
    .mockResolvedValueOnce({ pid: 99 }) // 要不要动
    .mockResolvedValueOnce({ pid: 99 }) // 关编辑器前
    .mockResolvedValue(null)
}

const methods = (): string[] => callRequest.mock.calls.map((c) => c[0] as string)

beforeEach(() => {
  vi.useRealTimers()
  for (const m of [callRequest, findRunningProjectByPath, openPath, awaitProjectLive, install]) {
    m.mockReset()
  }
  killSpy.mockClear()
  interactive = []
  getStatus.mockReset().mockResolvedValueOnce(OLD).mockResolvedValue(NEW)
  isProjectPluginUpToDate.mockReset().mockResolvedValue(false)
  install.mockResolvedValue({ success: true })
  openPath.mockResolvedValue('')
  awaitProjectLive.mockResolvedValue({ live: true, retargeted: true })
  findRunningProjectByPath.mockResolvedValue(null)
})

describe('纯函数', () => {
  it('认得出旧插件的「Unknown method」，别的 404 不算', () => {
    expect(isUnknownMethod({ code: 404, error: 'Unknown method: editor.quit' })).toBe(true)
    expect(isUnknownMethod({ __rpc: { code: 404 }, message: 'Unknown method: x' })).toBe(true)
    expect(isUnknownMethod({ code: 404, error: 'Asset not found' })).toBe(false)
    expect(isUnknownMethod({ ok: true })).toBe(false)
  })

  it('get_dirty 两栏并成一张清单', () => {
    expect(
      dirtyPackages({ touched: [{ package: '/Game/A' }], other: [{ package: '/Game/B' }, {}] })
    ).toEqual(['/Game/A', '/Game/B'])
    expect(dirtyPackages(undefined)).toEqual([])
  })

  it('原因码翻成人话，认不出的原样带回', () => {
    expect(describeInstallFailure('插件文件安装到项目失败：NO_ENGINE_ASSOCIATION')).toContain(
      'EngineAssociation'
    )
    expect(describeInstallFailure('目录被占用')).toBe('目录被占用')
  })
})

describe('project_update_plugin', () => {
  it('已经是最新、编辑器也连着：什么都不做，不关编辑器', async () => {
    getStatus.mockReset().mockResolvedValue(NEW)
    isProjectPluginUpToDate.mockResolvedValue(true)
    interactive = [{ projectPath: 'H:/Dev/MyGame', connectionId: 'conn-1' }]
    findRunningProjectByPath.mockResolvedValue({ pid: 99 })

    const { text, details } = await run()

    expect(text.startsWith('✓')).toBe(true)
    expect(text).toContain('1.0.7')
    expect(callRequest).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(details).toMatchObject({ updated: false, closedEditor: false, live: true })
  })

  it('用户主动移除过：不装回去，问用户', async () => {
    getStatus.mockReset().mockResolvedValue({ ...OLD, installed: false, optedOut: true })

    await expect(run()).rejects.toThrow('reinstall_removed')
    expect(install).not.toHaveBeenCalled()
  })

  it('用户明说装回来：照装', async () => {
    getStatus
      .mockReset()
      .mockResolvedValueOnce({ ...OLD, installed: false, version: null, optedOut: true })
      .mockResolvedValue(NEW)

    const { text } = await run({ reinstall_removed: true })

    expect(install).toHaveBeenCalledWith('H:/Dev/MyGame/MyGame.uproject')
    expect(text.startsWith('✓')).toBe(true)
  })

  it('有未保存的改动：拒绝并列清单，不装', async () => {
    editorOpenThenClosed()
    callRequest.mockResolvedValue({
      __rpc: { code: 409 },
      details: { unsaved: ['/Game/Maps/Main'], unsaved_count: 1 }
    })

    await expect(run()).rejects.toThrow('/Game/Maps/Main')
    expect(install).not.toHaveBeenCalled()
  })

  it('开着、连着、插件旧：关编辑器 → 装 → 重开并连回来，回执版本取装完读回来的', async () => {
    editorOpenThenClosed()
    callRequest.mockResolvedValue({ ok: true, closing: true })
    // 引擎侧（磁盘）读回来的和随包版本号不同 —— 回执跟着读回来的走
    getStatus
      .mockReset()
      .mockResolvedValueOnce(OLD)
      .mockResolvedValue({ ...NEW, version: '1.0.6' })

    const { text, details } = await run()

    expect(methods()).toEqual(['editor.quit'])
    expect(install).toHaveBeenCalled()
    expect(text.startsWith('✓')).toBe(true)
    expect(text).toContain('1.0.3 → 1.0.6')
    expect(text).not.toContain('1.0.7')
    expect(openPath).toHaveBeenCalledWith('H:/Dev/MyGame/MyGame.uproject')
    expect(details).toMatchObject({
      updated: true,
      closedEditor: true,
      reopened: true,
      live: true,
      version: '1.0.6',
      previousVersion: '1.0.3'
    })
  })

  it('旧插件没有 editor.quit：查脏 → 干净就让编辑器自己关', async () => {
    editorOpenThenClosed()
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'editor.quit') return { code: 404, error: 'Unknown method: editor.quit' }
      if (method === 'editor.get_dirty') return { ok: true, touched: [], other: [] }
      throw new Error('连接断开') // 编辑器一关，CLOSE_SLATE_MAINFRAME 那条多半等不到回话
    })

    const { text } = await run()

    expect(methods()).toEqual(['editor.quit', 'editor.get_dirty', 'system.run_console_command'])
    expect(callRequest.mock.calls[2][1]).toEqual({ command: 'CLOSE_SLATE_MAINFRAME' })
    expect(killSpy).not.toHaveBeenCalled()
    expect(text.startsWith('✓')).toBe(true)
  })

  it('旧插件没有 editor.quit、有没存的：拒绝并列清单，不关', async () => {
    editorOpenThenClosed()
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'editor.quit') return { code: 404, error: 'Unknown method: editor.quit' }
      return { ok: true, touched: [{ package: '/Game/BP_Hero' }], other: [] }
    })

    await expect(run()).rejects.toThrow('/Game/BP_Hero')
    expect(methods()).not.toContain('system.run_console_command')
    expect(install).not.toHaveBeenCalled()
  })

  it('插件连不上又没同意丢改动：不杀进程，说清楚怎么办', async () => {
    findRunningProjectByPath.mockResolvedValue({ pid: 99 })

    await expect(run()).rejects.toThrow('discard_unsaved')
    expect(killSpy).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('装不上：第一句 ✗、按错误抛，编辑器照样还给用户', async () => {
    editorOpenThenClosed()
    callRequest.mockResolvedValue({ ok: true, closing: true })
    install.mockResolvedValue({
      success: false,
      error: '插件文件安装到项目失败：UPROJECT_UNREADABLE'
    })
    getStatus.mockReset().mockResolvedValue(OLD)

    const err = await run().then(
      () => null,
      (e: Error) => e
    )

    expect(err?.message.startsWith('✗')).toBe(true)
    expect(err?.message).toContain('读不出来')
    expect(err?.message).toContain('不要让用户去手动安装')
    expect(openPath).toHaveBeenCalled()
  })

  it('编辑器原来没开：只装，不替用户打开', async () => {
    const { text, details } = await run()

    expect(install).toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
    expect(text).toContain('open_project')
    expect(details).toMatchObject({ updated: true, closedEditor: false, reopened: false })
  })
})
