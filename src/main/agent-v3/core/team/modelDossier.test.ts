import { describe, expect, it } from 'vitest'

import type { TeamModelCandidate, TrackRecordEntry } from '../../../../shared/agentTeam'
import { buildModelDossiers } from './modelDossier'

const ds = { providerId: 'ds', modelId: 'deepseek-chat' }
const qw = { providerId: 'ali', modelId: 'qwen3-coder' }
const gone = { providerId: 'old', modelId: 'gpt-4o' }

const candidates: TeamModelCandidate[] = [
  {
    ...ds,
    key: 'ds/deepseek-chat',
    name: 'DeepSeek V3.2',
    providerName: 'DeepSeek',
    vision: false
  },
  { ...qw, key: 'ali/qwen3-coder', name: 'Qwen3 Coder', providerName: '百炼', vision: false }
]

function task(
  model: typeof ds,
  roleType: string | undefined,
  outcome: 'done' | 'unfinished',
  at: number,
  ms?: number
): TrackRecordEntry {
  return {
    kind: 'task',
    model,
    at,
    outcome,
    ...(roleType ? { roleType } : {}),
    ...(ms ? { ms } : {})
  }
}

describe('模型档案', () => {
  it('按岗位汇总任务、打回、未完成和平均耗时', () => {
    const [row] = buildModelDossiers(
      candidates,
      [],
      [
        task(ds, '搭建', 'done', 1, 60_000),
        task(ds, '搭建', 'done', 3, 180_000),
        task(ds, '搭建', 'unfinished', 2, 999_000),
        { kind: 'reopened', model: ds, at: 4, roleType: '搭建' },
        task(ds, undefined, 'done', 5)
      ]
    )
    expect(row).toMatchObject({
      name: 'DeepSeek V3.2',
      removed: false,
      tasks: 4,
      reopened: 1,
      unfinished: 1,
      lastUsedAt: 5
    })
    // 没干完的不算进平均耗时；没标岗位的单独一类
    expect(row.roles).toEqual([
      { roleType: '搭建', tasks: 3, reopened: 1, unfinished: 1, avgMs: 120_000 },
      { tasks: 1, reopened: 0, unfinished: 0 }
    ])
  })

  it('只列检测过或干过活的；名单里没有的标成已移除并排到最后', () => {
    const rows = buildModelDossiers(
      candidates,
      [{ ...qw, at: 1, reachable: true, tools: 'fail' }],
      [task(gone, '搭建', 'done', 1), task(gone, '搭建', 'done', 2)]
    )
    expect(rows.map((r) => [r.modelId, r.removed, r.name])).toEqual([
      ['qwen3-coder', false, 'Qwen3 Coder'],
      ['gpt-4o', true, 'gpt-4o']
    ])
    expect(rows[0].checkup).toEqual({ at: 1, reachable: true, tools: 'fail' })
  })
})
