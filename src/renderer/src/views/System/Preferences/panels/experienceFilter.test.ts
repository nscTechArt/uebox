import { describe, expect, it } from 'vitest'

import {
  activeCount,
  experienceProjects,
  filterExperiences,
  liftPercents,
  refOf
} from './experienceFilter'

const stats = {
  shown: 0,
  shownOk: 0,
  holdout: 0,
  holdoutOk: 0,
  adopted: 0,
  adoptedOk: 0,
  adoptedFail: 0,
  ignoredStreak: 0
}

function entry(over: Partial<AgentV3Experience>): AgentV3Experience {
  return {
    id: 'e',
    title: 't',
    tool: 'ue_save',
    errorPattern: 'p',
    advice: 'a',
    expect: {},
    source: '',
    status: 'trial',
    layer: 'global',
    stats,
    ...over
  }
}

const list = [
  entry({ id: 'g1', status: 'trial' }),
  entry({ id: 'g2', status: 'proven' }),
  entry({ id: 'p1', layer: 'project', projectName: 'A', projectPath: 'H:\\P\\A' }),
  entry({ id: 'p2', layer: 'project', projectName: 'B', projectPath: 'H:/P/B', status: 'retired' })
]

describe('filterExperiences', () => {
  it('默认不列已淘汰的，已验证的排前面', () => {
    expect(filterExperiences(list, { scope: 'all', showRetired: false }).map((e) => e.id)).toEqual([
      'g2',
      'g1',
      'p1'
    ])
  })

  it('按层、按工程筛；路径写法不同也认得是同一个工程', () => {
    expect(
      filterExperiences(list, { scope: 'global', showRetired: true }).map((e) => e.id)
    ).toEqual(['g2', 'g1'])
    expect(
      filterExperiences(list, { scope: 'project', projectPath: 'h:/p/a/', showRetired: false }).map(
        (e) => e.id
      )
    ).toEqual(['p1'])
  })

  it('工程下拉只列有经验的工程；计数不算已淘汰的', () => {
    expect(experienceProjects(list).map((p) => p.name)).toEqual(['A', 'B'])
    expect(activeCount(list)).toBe(3)
  })

  it('回传给主进程的定位信息带着工程路径', () => {
    expect(refOf(list[2])).toEqual({
      layer: 'project',
      tool: 'ue_save',
      id: 'p1',
      projectPath: 'H:\\P\\A'
    })
    expect(refOf(list[0])).toEqual({ layer: 'global', tool: 'ue_save', id: 'g1' })
  })

  it('对照组比较取整；没算出提升时不给', () => {
    expect(
      liftPercents({ ...stats, shown: 3, shownOk: 2, holdout: 3, holdoutOk: 1, lift: 0.33 })
    ).toEqual({ with: 67, without: 33 })
    expect(liftPercents({ ...stats, shown: 3, shownOk: 2 })).toBeUndefined()
  })
})
