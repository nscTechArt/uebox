import { beforeEach, describe, expect, it, vi } from 'vitest'
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
