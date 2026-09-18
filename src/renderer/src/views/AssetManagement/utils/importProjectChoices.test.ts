import { describe, expect, it } from 'vitest'
import {
  importProjectChoices,
  importBrowserEntries,
  type ImportBrowserEntry,
  importProjectConnection,
  projectDirectory
} from './importProjectChoices'

const saved = [
  {
    projectKey: 'saved',
    projectName: 'Forest',
    projectPath: 'H:\\Games\\Forest',
    image: 'cover.jpg'
  }
]
const live = [
  {
    connectionId: '1',
    projectName: 'Forest',
    projectPath: 'h:/games/forest/Forest.uproject',
    isConnected: true
  }
]

describe('import project choices', () => {
  it('routes to the selected project and never falls back to a different connection', () => {
    const other = { ...live[0], connectionId: 'other', projectPath: 'H:/Other/Game.uproject' }
    expect(importProjectConnection(saved[0], [other, ...live])).toBe('1')
    expect(importProjectConnection(saved[0], [other])).toBeUndefined()
    expect(importProjectConnection(saved[0], [{ ...live[0], isConnected: false }])).toBeUndefined()
  })
  it('preserves the saved identity and cover of connected projects', () => {
    expect(importProjectChoices(saved, live, '')).toEqual(saved)
    expect(importProjectChoices(saved, live, 'forest')[0]).toBe(saved[0])
  })
  it('filters connected projects instead of recreating filtered records without covers', () => {
    expect(importProjectChoices(saved, live, 'missing')).toEqual([])
    expect(importProjectChoices([], live, 'missing')).toEqual([])
  })
  it('matches a saved uproject path when the indexed directory is absent', () => {
    const project = { ...saved[0], projectPath: null, originPath: live[0].projectPath }
    expect(importProjectChoices([project], live, '')).toEqual([project])
  })
  it('keeps a stable selection across reconnects and deduplicates connections', () => {
    const first = importProjectChoices([], live, '')
    const reconnected = importProjectChoices([], [{ ...live[0], connectionId: '2' }, live[0]], '')
    expect(reconnected).toEqual(first)
    expect(importProjectChoices([], [{ ...live[0], isConnected: false }], '')).toEqual([])
  })
  it('normalizes directory boundaries without changing display case', () => {
    expect(projectDirectory(' H:\\Games\\Forest\\Forest.uproject ')).toBe('H:/Games/Forest')
    expect(projectDirectory(null)).toBe('')
    expect(importProjectChoices(saved, [], 'GAMES')).toEqual(saved)
  })
})

describe('import project browser', () => {
  const projects = [
    { projectKey: 'normal', projectName: 'Plain', EngineAssociation: '5.5' },
    {
      projectKey: 'inside',
      projectName: 'Forest',
      EngineAssociation: '5.6',
      isPinned: 1
    },
    {
      projectKey: 'inside2',
      projectName: 'City',
      EngineAssociation: '5.5'
    },
    { projectKey: 'pinned', projectName: 'Pinned', EngineAssociation: '{custom}', isPinned: 1 }
  ]
  // 成员关系挂在分组自己带回来的名单上 —— 一个工程可以同时在几个分组里
  const collections = [
    {
      collectionKey: 'group',
      name: 'Landscapes',
      items: [{ projectKey: 'inside' }, { projectKey: 'inside2' }]
    }
  ]
  const label = (value?: string | null): string => (value === '{custom}' ? '5.6' : value || 'N/A')
  const browse = (query = '', version = ''): ImportBrowserEntry[] =>
    importBrowserEntries(importProjectChoices(projects, [], ''), collections, query, version, label)
  /** Members ride along on the collection entry so the modal can expand it without a sub-view. */
  const members = (entries: ImportBrowserEntry[], key: string): string[] => {
    const entry = entries.find((e) => e.key === key)
    return entry?.kind === 'collection' ? entry.projects.map((p) => p.projectKey) : []
  }
  it('keeps members on their collection and pinned projects ahead of normal entries', () => {
    expect(browse().map((e) => e.key)).toEqual(['pinned', 'group', 'normal'])
    expect(members(browse(), 'group')).toEqual(['inside', 'inside2'])
  })
  it('searches members and collection names without flattening the collection', () => {
    expect(browse('Forest').map((e) => e.key)).toEqual(['group'])
    expect(members(browse('Forest'), 'group')).toEqual(['inside'])
    expect(members(browse('Landscapes'), 'group')).toEqual(['inside', 'inside2'])
  })
  it('combines resolved custom engine versions with search and collection membership', () => {
    expect(browse('', '5.6').map((e) => e.key)).toEqual(['pinned', 'group'])
    expect(members(browse('', '5.6'), 'group')).toEqual(['inside'])
    expect(browse('City', '5.6')).toEqual([])
  })
  it('takes membership from the collection items the database hands back', () => {
    const entries = importBrowserEntries(
      projects,
      [{ collectionKey: 'legacy', items: [projects[0]], isPinned: 1 }],
      '',
      '',
      label
    )
    expect(entries[0].key).toBe('legacy')
    expect(entries.filter((e) => e.kind === 'project').map((e) => e.key)).toContain('inside')
    expect(entries.filter((e) => e.kind === 'project').map((e) => e.key)).not.toContain('normal')
  })
  it('keeps pinned projects ahead of connected unpinned projects', () => {
    expect(
      importProjectChoices(
        [
          { projectKey: 'normal', projectPath: 'H:/Normal' },
          { projectKey: 'pin', isPinned: 1 }
        ],
        [{ connectionId: 'live', projectPath: 'H:/Normal', isConnected: true }],
        ''
      ).map((p) => p.projectKey)
    ).toEqual(['pin', 'normal'])
  })
})

describe('import search relevance across collection boundaries', () => {
  const projects = [
    {
      projectKey: 'path',
      projectName: 'UALHost55',
      projectPath: 'H:/UnrealAgent/UALHost55',
      isPinned: 1
    },
    { projectKey: 'name', projectName: 'RealBiomesDesert' },
    {
      projectKey: 'inside-path',
      projectName: 'City',
      projectPath: 'H:/Unreal/City',
      isPinned: 1
    }
  ]
  it('name matches outrank pinned and connected path matches', () => {
    expect(
      importProjectChoices(
        projects,
        [{ connectionId: 'live', projectPath: 'H:/UnrealAgent/UALHost55', isConnected: true }],
        'real'
      )[0].projectKey
    ).toBe('name')
  })
  it('ranks a collection by its best match and keeps relevance inside it', () => {
    const collections = [
      {
        collectionKey: 'group',
        name: 'Samples',
        items: [{ projectKey: 'name' }, { projectKey: 'inside-path' }]
      }
    ]
    const entries = importBrowserEntries(projects, collections, 'real', '', () => '5.5')
    expect(entries.map((e) => e.key)).toEqual(['group', 'path'])
    const group = entries[0]
    expect(group.kind === 'collection' && group.projects.map((p) => p.projectKey)).toEqual([
      'name',
      'inside-path'
    ])
  })
})
