import { describe, expect, it } from 'vitest'
import {
  importProjectChoices,
  importFilterChips,
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

describe('import project filter chips', () => {
  const projects = [
    { projectKey: 'plain', projectName: 'Plain' },
    { projectKey: 'forest', projectName: 'Forest' },
    { projectKey: 'city', projectName: 'City' }
  ]
  const collections = [
    { collectionKey: 'b', name: 'Cities', items: [{ projectKey: 'city' }] },
    // 一个工程可以同时在几个分组里
    { collectionKey: 'a', name: '', items: [{ projectKey: 'forest' }, { projectKey: 'city' }] }
  ]
  const summary = (chips: ReturnType<typeof importFilterChips>): string[] =>
    chips.map((c) => `${c.key}:${c.projects.map((p) => p.projectKey).join(',')}`)

  it('lists 全部, each group in database order, then 未分组 — same as the home page', () => {
    expect(summary(importFilterChips(projects, collections))).toEqual([
      '__all__:plain,forest,city',
      'b:city',
      'a:forest,city',
      '__ungrouped__:plain'
    ])
  })
  it('counts only what the search left, keeping emptied groups visible', () => {
    expect(summary(importFilterChips([projects[0]], collections))).toEqual([
      '__all__:plain',
      'b:',
      'a:',
      '__ungrouped__:plain'
    ])
  })
  it('skips 未分组 when there are no groups at all', () => {
    expect(summary(importFilterChips(projects, []))).toEqual(['__all__:plain,forest,city'])
  })
})

describe('import search relevance', () => {
  const projects = [
    {
      projectKey: 'path',
      projectName: 'UALHost55',
      projectPath: 'H:/UnrealAgent/UALHost55',
      isPinned: 1
    },
    { projectKey: 'name', projectName: 'RealBiomesDesert' }
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
