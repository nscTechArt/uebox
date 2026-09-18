import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatSidebarStore } from './chatSidebarStore'

describe('chat sidebar manual projects', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('adds a project once, trimming the name and path', () => {
    const store = useChatSidebarStore()

    store.addManualProject({ projectName: '  ShooterGame  ', projectPath: ' D:/UE/Shooter ' })
    store.addManualProject({ projectName: 'shootergame' })

    expect(store.manualProjects).toEqual([
      { projectName: 'ShooterGame', projectPath: 'D:/UE/Shooter', engineVersion: undefined }
    ])
    expect(store.isManualProject('SHOOTERGAME')).toBe(true)
  })

  it('ignores a blank project name', () => {
    const store = useChatSidebarStore()

    store.addManualProject({ projectName: '   ' })

    expect(store.manualProjects).toEqual([])
  })

  it('removes a project regardless of case', () => {
    const store = useChatSidebarStore()
    store.addManualProject({ projectName: 'ArchViz' })

    store.removeManualProject('archviz')

    expect(store.manualProjects).toEqual([])
    expect(store.isManualProject('ArchViz')).toBe(false)
  })

  it('keeps a removed project hidden until the user explicitly adds it back', () => {
    const store = useChatSidebarStore()

    store.hideProject('  LiveProject ')

    expect(store.isProjectHidden('liveproject')).toBe(true)

    store.addManualProject({ projectName: 'LIVEPROJECT' })

    expect(store.isProjectHidden('LiveProject')).toBe(false)
    expect(store.manualProjects).toEqual([
      { projectName: 'LIVEPROJECT', projectPath: undefined, engineVersion: undefined }
    ])
  })

  it('pins and unpins a project regardless of case', () => {
    const store = useChatSidebarStore()

    expect(store.toggleProjectPinned('  ShooterGame  ')).toBe(true)
    expect(store.pinnedProjects).toEqual(['ShooterGame'])
    expect(store.isProjectPinned('shootergame')).toBe(true)

    expect(store.toggleProjectPinned('SHOOTERGAME')).toBe(false)
    expect(store.pinnedProjects).toEqual([])
  })

  it('carries a renamed project into the manual and pinned lists', () => {
    const store = useChatSidebarStore()
    store.addManualProject({ projectName: 'OldName', projectPath: 'D:/UE/Old' })
    store.toggleProjectPinned('oldname')

    store.renameProject('OLDNAME', '  NewName  ')

    expect(store.manualProjects[0].projectName).toBe('NewName')
    expect(store.pinnedProjects).toEqual(['NewName'])
    expect(store.isProjectPinned('newname')).toBe(true)
  })

  it('toggles group collapse state and expands on demand', () => {
    const store = useChatSidebarStore()

    store.toggleGroup('section:projects')
    expect(store.isGroupCollapsed('section:projects')).toBe(true)

    store.expandGroup('section:projects')
    expect(store.isGroupCollapsed('section:projects')).toBe(false)
  })
})
