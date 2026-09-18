/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「哪些工程算连着」的判据。
 *
 * 这一条修的是真机上一次实打实的假话：用户把编辑器关了，一个
 * `-nullrhi -unattended` 的验证进程跑完没退、还占着 17860 的连接，
 * 盒子照着连接列表告诉用户「现在连着的工程是 MetaHumanDoubaoFullDuplex」——
 * 那个工程用户十分钟前就关了。
 *
 * 插件在 commandlet / unattended / nullrhi 里也照样连上来（那是我们自己要用的
 * 一条路：拿无头编辑器当考卷核对自研解析器）。所以判据不能只看「连没连」，
 * 还要看那头是不是一个人能看能点的编辑器。
 */

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

const send = vi.fn()
vi.mock('../../appWindows', () => ({
  sendToAppWindows: (...args: unknown[]): void => send(...args)
}))

import { ProjectManager } from './projectManager'
import type { ProjectInfoResponse } from './types'

function info(overrides: Partial<ProjectInfoResponse> = {}): ProjectInfoResponse {
  return {
    projectName: 'Demo',
    projectVersion: '1.0.0',
    engineVersion: '5.6.1',
    projectPath: 'I:/UE Project/Demo',
    defaultMap: '/Game/Maps/Main',
    ...overrides
  }
}

let manager: ProjectManager

beforeEach(() => {
  send.mockClear()
  manager = new ProjectManager()
})

describe('交互式编辑器 vs 无头进程', () => {
  it('无头进程不算「当前工程」', () => {
    manager.addProject('headless', info({ interactive: false, runMode: 'commandlet' }))

    expect(manager.getCurrentProject()).toBeUndefined()
    expect(manager.getInteractiveProjects()).toEqual([])
    expect(manager.getNonInteractiveProjects()).toHaveLength(1)
  })

  it('同时连着无头进程和真编辑器时，当前工程是那个编辑器', () => {
    manager.addProject('headless', info({ projectName: '跑批的', interactive: false }))
    manager.addProject('editor', info({ projectName: '用户开着的' }))

    expect(manager.getCurrentProject()?.projectName).toBe('用户开着的')
    expect(manager.getInteractiveProjects().map((p) => p.projectName)).toEqual(['用户开着的'])
  })

  /**
   * 旧插件不发 `interactive`。那时候只有交互式编辑器会连上来，
   * 缺省必须按 true 处理 —— 否则用户装着旧插件就整个连不上了。
   */
  it('旧插件没报运行模式时按交互式处理', () => {
    manager.addProject('legacy', info())

    expect(manager.getCurrentProject()?.connectionId).toBe('legacy')
  })

  it('按路径找连接时跳过无头进程', () => {
    manager.addProject('headless', info({ projectPath: 'I:/UE Project/Demo', interactive: false }))

    expect(manager.getConnectionIdByPath('I:/UE Project/Demo')).toBeUndefined()

    manager.addProject('editor', info({ projectPath: 'I:/UE Project/Demo' }))
    expect(manager.getConnectionIdByPath('I:/UE Project/Demo')).toBe('editor')
  })

  it('给 Agent 的已连接工程摘要里没有无头进程', () => {
    manager.addProject('headless', info({ interactive: false }))

    expect(manager.getConnectedProjectSummaries()).toEqual([])
  })

  /**
   * 界面上那个「已连接」的绿点，对用户的意思是「这个工程我开着」。
   * 把跑批进程算进去等于让绿点说谎，所以推给渲染进程的列表也要滤掉。
   */
  it('推给界面的工程列表里没有无头进程', () => {
    manager.addProject('headless', info({ interactive: false }))

    const [channel, projects] = send.mock.calls.at(-1) as [string, unknown[]]
    expect(channel).toBe('ws:projects-changed')
    expect(projects).toEqual([])
  })

  it('断开后不再出现在任何一份清单里', () => {
    manager.addProject('editor', info())
    expect(manager.getInteractiveProjects()).toHaveLength(1)

    manager.deleteProject('editor')
    expect(manager.getInteractiveProjects()).toEqual([])
    expect(manager.getCurrentProject()).toBeUndefined()
  })

  /** 标记离线（而不是删除）的记录同样不该被当成当前工程 */
  it('标记为离线的工程不算连着', () => {
    manager.addProject('editor', info())
    manager.removeProject('editor')

    expect(manager.getCurrentProject()).toBeUndefined()
    expect(manager.getNonInteractiveProjects()).toEqual([])
  })
})
