// @vitest-environment node
/**
 * 团队门面：加入团队把账号所在的工程和团队上的资产库全部放进切换器（没有「选择工程」），
 * 外包区不单独进；同步到本机默认不带源文件夹；放入不传 UE 自己生成的目录。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CatalogHttp, RawResponse } from '../http'
import type { CatalogLibraryRecord } from '../../../shared/catalogLibrary'
import {
  TeamService,
  defaultUnsynced,
  projectRelativeOf,
  renderWorkingView,
  shouldSkipOnPutIn,
  type TeamHost
} from './teamService'

function fakeHttp(routes: Record<string, unknown>): CatalogHttp {
  return {
    raw: async (path: string): Promise<RawResponse> => {
      const body = routes[path]
      if (body === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) }
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) }
    },
    destroy: () => undefined
  } as unknown as CatalogHttp
}

function fakeHost(
  http: CatalogHttp,
  remote: Array<{ id: string; name: string }>
): TeamHost & {
  added: Array<{ id: string; name: string; team?: unknown }>
} {
  const added: Array<{ id: string; name: string; team?: unknown }> = []
  const host = {
    added,
    libraries: async (): Promise<CatalogLibraryRecord[]> => [],
    record: async () => {
      throw new Error('unused')
    },
    memberHttp: async () => http,
    catalogJson: async () => ({}),
    previewUrl: () => null,
    loreRemote: async () => null,
    loreContext: async () => {
      throw new Error('unused')
    },
    shadows: {} as never,
    emitJob: vi.fn(),
    emitTeam: vi.fn(),
    connect: async () => ({
      server: { id: 'srv' } as never,
      libraries: remote as never
    }),
    addLibraries: async (_serverId: string, libraries: typeof added) => {
      added.push(...libraries)
    },
    updateTeamLink: async () => undefined,
    invalidate: () => undefined,
    rootFolders: async () => [],
    signedIn: async () => true,
    anonymousHttp: async () => http,
    memberUrl: async () => null
  }
  return host as unknown as TeamHost & { added: typeof added }
}

describe('joining a team', () => {
  it('adds every project and the team asset libraries, but not outsourcing areas', async () => {
    const http = fakeHttp({
      '/v1/auth/me': {
        member: 'chendong',
        displayName: '陈东',
        kind: 'employee',
        projects: [{ id: 'xinghai', name: '星海', role: 'admin', company: null }]
      },
      '/v1/projects/xinghai': {
        id: 'xinghai',
        name: '星海',
        role: 'admin',
        company: null,
        library: 'xinghai',
        companies: [
          { id: 'mmwb', name: '某某外包', area: { repository: 'r', library: 'xinghai-mmwb' } }
        ]
      },
      '/v1/me/events': {}
    })
    const host = fakeHost(http, [
      { id: 'xinghai', name: '星海' },
      { id: 'xinghai-mmwb', name: 'area' },
      { id: 'lab', name: 'Lab assets' }
    ])
    const service = new TeamService(host)
    const result = await service.join({
      server: 'http://127.0.0.1:47484',
      project: 'xinghai',
      member: 'chendong',
      password: 'x'
    })
    expect(result.openKey).toBe('srv:xinghai')
    expect(result.noProjects).toBe(false)
    expect(host.added.map((item) => item.id)).toEqual(['xinghai', 'lab'])
    expect(host.added[0].team).toMatchObject({ projectId: 'xinghai', role: 'admin' })
    expect(host.added[1].team).toBeNull()
    service.dispose()
  })

  it('an outsourcer gets the area library as the project, and nothing else', async () => {
    const http = fakeHttp({
      '/v1/auth/me': {
        member: 'waibao@example.com',
        displayName: '小张',
        kind: 'outsourcer',
        projects: [
          {
            id: 'xinghai',
            name: '星海',
            role: 'outsourcer',
            company: { id: 'mmwb', name: '某某外包' }
          }
        ]
      },
      '/v1/projects/xinghai': {
        id: 'xinghai',
        name: '星海',
        role: 'outsourcer',
        company: { id: 'mmwb', name: '某某外包' },
        library: 'xinghai-mmwb',
        area: { repository: 'r', library: 'xinghai-mmwb' }
      }
    })
    const host = fakeHost(http, [
      { id: 'xinghai-mmwb', name: 'area' },
      { id: 'lab', name: 'Lab' }
    ])
    const service = new TeamService(host)
    const result = await service.join({ server: 'http://h', member: 'w', password: 'x' })
    expect(host.added).toHaveLength(1)
    expect(host.added[0]).toMatchObject({
      id: 'xinghai-mmwb',
      team: { role: 'outsourcer', company: { name: '某某外包' } }
    })
    expect(result.openKey).toBe('srv:xinghai-mmwb')
    service.dispose()
  })

  it('says so when the account is in no project yet', async () => {
    const http = fakeHttp({
      '/v1/auth/me': { member: 'xiaowang', displayName: '小王', kind: 'employee', projects: [] }
    })
    const service = new TeamService(fakeHost(http, []))
    const result = await service.join({ server: 'http://h', member: 'xiaowang', password: 'x' })
    expect(result).toMatchObject({ noProjects: true, openKey: null, member: 'xiaowang' })
    service.dispose()
  })
})

describe('local project helpers', () => {
  it('does not sync source-art folders by default', () => {
    expect(
      defaultUnsynced(['Config', 'Content', 'Source', 'SourceArt', 'Plugins', 'Docs'])
    ).toEqual(['SourceArt', 'Docs'])
  })

  it('writes an exclusion view for the folders that are not synced', () => {
    expect(renderWorkingView([])).toBe('')
    expect(renderWorkingView(['SourceArt'])).toBe('SourceArt/**\n')
  })

  it('does not upload what UE generates when putting a project in', () => {
    expect(shouldSkipOnPutIn('Saved/Logs/x.log')).toBe(true)
    expect(shouldSkipOnPutIn('Intermediate\\Build')).toBe(true)
    expect(shouldSkipOnPutIn('DerivedDataCache/a')).toBe(true)
    expect(shouldSkipOnPutIn('Content/Env/SM_Rock.uasset')).toBe(false)
  })

  it('keeps delivery paths the same as in the project', () => {
    expect(projectRelativeOf('D:\\Vendor\\Rocks\\Content\\Env\\Rocks\\SM_Rock_11.uasset')).toBe(
      'Content/Env/Rocks/SM_Rock_11.uasset'
    )
    expect(projectRelativeOf('C:/tmp/SM_Rock_11.uasset')).toBe('SM_Rock_11.uasset')
  })
})
