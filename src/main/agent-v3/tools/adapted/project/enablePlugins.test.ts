/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { electronMock, servicesMock, targetContextMock } from '../../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../../services', () => servicesMock())
vi.mock('../../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)
vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}),
  getDatabaseManager: () => ({})
}))
vi.mock('../../../../sqliteDataBase/models/project', () => ({ getAllProjects: () => [] }))

// 「本机装没装」要扫引擎目录，这里直接给结论：PoseSearch、MotionWarping 装着，别的没有
vi.mock('../../../../services/project/requiredPlugins', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../../services/project/requiredPlugins')>()
  const installed = new Map([
    ['posesearch', 'PoseSearch'],
    ['motionwarping', 'MotionWarping']
  ])
  return {
    ...original,
    checkPluginsInstalled: vi.fn(async (_file: string, names: string[]) => ({
      engineFound: true,
      installed: names
        .filter((n) => installed.has(n.toLowerCase()))
        .map((n) => installed.get(n.toLowerCase()) as string),
      notInstalled: names.filter((n) => !installed.has(n.toLowerCase()))
    }))
  }
})

import { enablePluginsForProject } from './projectTool'
import { projectManager } from '../../../../services/project'

describe('project_manage 的 enable_plugins', () => {
  let dir = ''
  let uproject = ''

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ue-enable-'))
    uproject = path.join(dir, 'Mimo.uproject')
    await writeFile(
      uproject,
      JSON.stringify({
        FileVersion: 3,
        EngineAssociation: '5.7',
        Plugins: [{ Name: 'UnrealAgentLink', Enabled: true }]
      })
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const pluginsOnDisk = async (): Promise<unknown> =>
    JSON.parse(await readFile(uproject, 'utf-8')).Plugins

  it('工程关着：写进 .uproject，回读确认，插件名按规范大小写写', async () => {
    const result = await enablePluginsForProject(['posesearch', 'MotionWarping'], {
      projectPath: dir
    })
    expect(result.success).toBe(true)
    expect(result.enabled).toEqual(['PoseSearch', 'MotionWarping'])
    expect(await pluginsOnDisk()).toEqual([
      { Name: 'UnrealAgentLink', Enabled: true },
      { Name: 'PoseSearch', Enabled: true },
      { Name: 'MotionWarping', Enabled: true }
    ])
  })

  it('有一个本机没装的就一个都不写 —— 写进去工程会打不开', async () => {
    const result = await enablePluginsForProject(['PoseSearch', 'KawaiiPhysics'], {
      projectPath: dir
    })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('KawaiiPhysics')
    // 免费开源插件不是只能用户自己装：经同意可以装进工程 Plugins 目录再调；Fab / 付费的才交给用户
    expect(String(result.error)).toContain('Plugins 目录')
    expect(String(result.error)).toContain('Fab')
    expect(await pluginsOnDisk()).toEqual([{ Name: 'UnrealAgentLink', Enabled: true }])
  })

  it('工程开着：通过它自己的编辑器连接开，不交给绑定在别的工程上的 ue_manage_plugin', async () => {
    vi.spyOn(projectManager, 'getInteractiveProjects').mockReturnValue([
      { connectionId: 'c-target', projectPath: dir } as ReturnType<
        typeof projectManager.getInteractiveProjects
      >[number]
    ])
    const result = await enablePluginsForProject(['PoseSearch'], { projectPath: dir })
    expect(result.success).toBe(true)
    expect(String((result.details as string[])[0])).toContain('重启编辑器')
    expect(await pluginsOnDisk()).toEqual([
      { Name: 'UnrealAgentLink', Enabled: true },
      { Name: 'PoseSearch', Enabled: true }
    ])
  })

  it('没给插件名直接拒', async () => {
    const result = await enablePluginsForProject([], { projectPath: dir })
    expect(result.success).toBe(false)
  })
})
