import { describe, expect, it } from 'vitest'

import {
  parseExperienceFile,
  serializeExperienceFile,
  type ExperienceEntry
} from './experienceFile'

const entry: ExperienceEntry = {
  id: 'e-1a2b3c4d',
  title: '角色没有 is_hidden',
  tool: 'ue_run_python_script',
  errorPattern: "has no attribute 'is_hidden'",
  advice: '用 is_hidden_ed() 读隐藏状态',
  expect: { param: 'script' },
  source: '2026-09-28 · session a1b2c3d4 · failed 2x, then succeeded',
  verified: { date: '2026-09-28', engine: '5.5' },
  status: 'trial'
}

describe('experienceFile', () => {
  it('写出去再读回来一模一样', () => {
    const pinned = {
      ...entry,
      id: 'e-2',
      status: 'proven' as const,
      pinned: true,
      expect: { tool: 'ue_get_actor' },
      // 通用层才有的两个字段
      engines: ['5.5', '5.6'],
      notFor: ['5.7']
    }
    const text = serializeExperienceFile('ue_run_python_script', [entry, pinned])
    expect(parseExperienceFile(text)).toEqual([entry, pinned])
  })

  it('字段里的换行被压平，不会把一条劈成两条', () => {
    const text = serializeExperienceFile('t', [{ ...entry, advice: '第一行\n## 第二行' }])
    const parsed = parseExperienceFile(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].advice).toBe('第一行 ## 第二行')
  })

  it('用户手改坏的那一条不认，其余照常', () => {
    const good = serializeExperienceFile('t', [entry])
    const broken = '\n## 坏掉的一条\n<!-- id: e-bad -->\n- advice: 没有 key 也没有 status\n'
    expect(parseExperienceFile(good + broken).map((e) => e.id)).toEqual([entry.id])
  })
})
