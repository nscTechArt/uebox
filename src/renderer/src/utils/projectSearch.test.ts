import { describe, expect, it } from 'vitest'
import { rankProjectSearch } from './projectSearch'

const projects = [
  {
    projectKey: 'path',
    projectName: 'UALHost55',
    projectPath: 'H:/UnrealAgent/UALHost55',
    isPinned: 1
  },
  { projectKey: 'contains', projectName: 'MyRealWorld' },
  { projectKey: 'prefix', projectName: 'RealBiomesDesert' },
  { projectKey: 'exact', projectName: 'Real' },
  { projectKey: 'other', projectName: 'Forest', originPath: 'H:/Real/Forest' },
  { projectKey: 'real-key', projectName: 'City' },
  { projectKey: 'absent', projectName: 'Lake' }
]
describe('project search relevance', () => {
  it('orders exact name, prefix, substring, path, then internal key matches', () => {
    expect(rankProjectSearch(projects, ' REAL ').map((p) => p.projectKey)).toEqual([
      'exact',
      'prefix',
      'contains',
      'path',
      'other',
      'real-key'
    ])
    expect(projects[0].projectKey).toBe('path')
  })
  it('preserves the existing order for ties and for an empty search', () => {
    expect(rankProjectSearch(projects, '   ')).toBe(projects)
    expect(rankProjectSearch([projects[4], projects[0]], 'real').map((p) => p.projectKey)).toEqual([
      'other',
      'path'
    ])
  })
  it('handles missing fields and non-Latin names', () => {
    expect(
      rankProjectSearch([{}, { projectName: '森林工程' }, { projectName: '森林' }], '森林').map(
        (p) => p.projectName
      )
    ).toEqual(['森林', '森林工程'])
  })
})
