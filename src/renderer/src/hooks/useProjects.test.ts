import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { message } from '@/utils/messageManager'
import { useProjects } from './useProjects'

vi.mock('@renderer/i18n', () => ({ default: { global: { t: (key: string): string => key } } }))

vi.mock('@renderer/hooks/usePluginInstallNotice', () => ({ notifyPluginInstallFailure: vi.fn() }))
vi.mock('@/utils/messageManager', () => ({ message: { success: vi.fn(), error: vi.fn() } }))

const themeState = vi.hoisted(() => ({ isLight: { value: false } }))

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => themeState
}))

vi.mock('@renderer/assets/imgs/fixme.jpg', () => ({ default: 'dark-placeholder' }))
vi.mock('@renderer/assets/imgs/fixme-light.jpg', () => ({ default: 'light-placeholder' }))

describe('useProjects project thumbnail placeholder', () => {
  beforeEach(() => {
    themeState.isLight.value = false
  })

  it('uses the placeholder matching the active theme', () => {
    const { getProjectImage } = useProjects()
    const project = { image: '' } as ProjectRecord

    expect(getProjectImage(project)).toBe('dark-placeholder')

    themeState.isLight.value = true
    expect(getProjectImage(project)).toBe('light-placeholder')
  })

  it('keeps a real project thumbnail in either theme', () => {
    const { getProjectImage } = useProjects()
    const project = { image: 'https://example.com/project-cover.jpg' } as ProjectRecord

    expect(getProjectImage(project)).toBe('https://example.com/project-cover.jpg')

    themeState.isLight.value = true
    expect(getProjectImage(project)).toBe('https://example.com/project-cover.jpg')
  })
})

describe('single project registration result', () => {
  it.each([true, false])(
    'returns the exact selected project only when registration succeeds (%s)',
    async (success) => {
      const project = { projectKey: 'existing', projectPath: 'H:/Existing' }
      vi.stubGlobal('window', {
        api: {
          dialog: {
            showOpenDialog: vi.fn(async () => ({
              canceled: false,
              filePaths: ['H:/Existing/Game.uproject']
            }))
          },
          database: {
            project: {
              importByFilePath: vi.fn(async () => ({
                success,
                data: success ? project : undefined
              })),
              getAll: vi.fn(async () => ({ success: true, data: [project] }))
            }
          }
        }
      })
      try {
        const { handleImportSingle } = useProjects()
        expect(await handleImportSingle()).toEqual(success ? project : undefined)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )
})

describe('project library search', () => {
  it('puts a name prefix ahead of a pinned path-only match', () => {
    const { projects, keyword, filteredProjects } = useProjects()
    projects.value = [
      {
        projectKey: 'path',
        projectName: 'UALHost55',
        projectPath: 'H:/UnrealAgent/UALHost55',
        isPinned: 1
      },
      { projectKey: 'name', projectName: 'RealBiomesDesert' }
    ]
    keyword.value = 'real'
    expect(filteredProjects.value.map((p) => p.projectKey)).toEqual(['name', 'path'])
    keyword.value = ''
    expect(filteredProjects.value.map((p) => p.projectKey)).toEqual(['path', 'name'])
  })
})

describe('overlapping project loads', () => {
  type ProjectsResult = Awaited<ReturnType<typeof window.api.database.project.getAll>>
  const getAll = vi.fn<() => Promise<ProjectsResult>>()
  const getThumbnail = vi.fn<typeof window.api.path.getPublicThumbnailUrl>()

  beforeEach(() => {
    getAll.mockReset()
    getThumbnail.mockReset()
    vi.mocked(message.error).mockClear()
    vi.stubGlobal('window', {
      api: { database: { project: { getAll } }, path: { getPublicThumbnailUrl: getThumbnail } }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps the latest cover when an older load finishes thumbnail mapping last', async () => {
    const oldThumbnail = Promise.withResolvers<{ success: boolean; data: string }>()
    getAll
      .mockResolvedValueOnce({ success: true, data: [{ projectKey: 'one', image: 'old.jpg' }] })
      .mockResolvedValueOnce({ success: true, data: [{ projectKey: 'one', image: 'new.jpg' }] })
    getThumbnail
      .mockReturnValueOnce(oldThumbnail.promise)
      .mockResolvedValueOnce({ success: true, data: 'file:///new.jpg' })
    const { projects, loadAllProjects } = useProjects()
    const oldLoad = loadAllProjects()
    await Promise.resolve()
    expect(getThumbnail).toHaveBeenCalledWith('old.jpg')
    await loadAllProjects()
    expect(projects.value[0].image).toBe('file:///new.jpg')

    oldThumbnail.resolve({ success: true, data: 'file:///old.jpg' })
    await oldLoad
    expect(projects.value[0].image).toBe('file:///new.jpg')
  })

  it.each(['response', 'exception'])(
    'ignores an obsolete %s failure while the latest load is pending',
    async (failure) => {
      const oldResponse = Promise.withResolvers<ProjectsResult>()
      const latestResponse = Promise.withResolvers<ProjectsResult>()
      getAll.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(latestResponse.promise)
      const { loadAllProjects, loading, loadFailed, projects } = useProjects()
      const oldLoad = loadAllProjects()
      const latestLoad = loadAllProjects()
      if (failure === 'exception') oldResponse.reject(new Error('obsolete failure'))
      else oldResponse.resolve({ success: false, data: [], error: 'obsolete failure' })
      await oldLoad
      expect(loading.value).toBe(true)
      expect(loadFailed.value).toBe(false)
      expect(message.error).not.toHaveBeenCalled()

      latestResponse.resolve({
        success: true,
        data: [{ projectKey: 'one', image: 'file:///new.jpg' }]
      })
      await latestLoad
      expect(projects.value[0].image).toBe('file:///new.jpg')
      expect(loading.value).toBe(false)
    }
  )

  it('preserves the latest failure instead of replacing it with an obsolete success', async () => {
    const oldResponse = Promise.withResolvers<ProjectsResult>()
    getAll.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce({
      success: false,
      data: [],
      error: 'current failure'
    })
    const { projects, loadAllProjects, loadFailed } = useProjects()
    projects.value = [{ projectKey: 'one', image: 'file:///current.jpg' }]
    const oldLoad = loadAllProjects()
    await loadAllProjects()
    expect(loadFailed.value).toBe(true)
    expect(message.error).toHaveBeenCalledWith('current failure')

    oldResponse.resolve({ success: true, data: [{ projectKey: 'one', image: 'file:///old.jpg' }] })
    await oldLoad
    expect(projects.value[0].image).toBe('file:///current.jpg')
    expect(loadFailed.value).toBe(true)
  })
})
