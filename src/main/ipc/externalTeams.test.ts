/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  createExternalTeamRegistry,
  type ExternalTeamRegistry
} from '../agent-v3/core/team/externalTeam'
import { createTeamStore } from '../agent-v3/core/team/teamStore'
import {
  endExternalTeam,
  externalTeamExists,
  isExternalTeamId,
  listExternalTeams,
  readExternalTeamState,
  type ExternalTeamPanelDeps
} from './externalTeams'

/**
 * 外部团队在盒子界面上的那一半（docs/外部大脑跑团队设计-2026-10-17.md 第 7 节）：
 * 列表、任务板、结束。盒子里的团队不经过这里 —— `agentV3.ts` 只把 `ext-` 开头的 id 转过来。
 */

let dir: string
let clock: number
let registry: ExternalTeamRegistry
let deps: ExternalTeamPanelDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'external-panel-'))
  clock = 1_000
  let n = 0
  registry = createExternalTeamRegistry({
    dirsFor: (id) => ({ stateDir: join(dir, 's', `${id}.team`), workspaceDir: join(dir, 'w', id) }),
    stateRoot: () => join(dir, 's'),
    now: () => clock,
    newId: () => `ext-t${++n}`
  })
  deps = {
    registry,
    storeFor: (id) => createTeamStore(registry.dirsFor(id), () => clock),
    now: () => clock
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('外部团队面板', () => {
  it('只认 ext- 开头的 id：盒子里的对话 id 走原来那条路', () => {
    expect(isExternalTeamId('ext-123')).toBe(true)
    expect(isExternalTeamId('session-abc')).toBe(false)
  })

  it('列表：最新的在前，带人数和验收状态', async () => {
    const a = await registry.create({ objective: '跑酷' })
    clock = 2_000
    const b = await registry.create({ objective: '塔防', projectPath: 'D:/Games/TD' })
    await deps.storeFor(b.id).putMember({
      name: '程序',
      persona: '写脚本',
      tier: 'strong',
      readOnly: false,
      hiredAt: 1
    })
    await registry.recordVerdict(b.id, { kind: 'pass', reason: '玩通了' })

    expect(await listExternalTeams(deps)).toEqual([
      {
        id: b.id,
        objective: '塔防',
        projectPath: 'D:/Games/TD',
        createdAt: 2_000,
        ended: false,
        verdict: 'pass',
        passed: true,
        members: 1
      },
      {
        id: a.id,
        objective: '跑酷',
        createdAt: 1_000,
        ended: false,
        verdict: null,
        passed: false,
        members: 0
      }
    ])
  })

  it('任务板：标成外部、不给用量；验收后又改过就标过期', async () => {
    const team = await registry.create({ objective: '塔防' })
    await deps.storeFor(team.id).patchBoard([{ id: 't1', title: '主角', status: 'doing' }])
    clock = 2_000
    await registry.recordVerdict(team.id, { kind: 'pass', reason: '玩通了' })
    clock = 3_000
    await registry.noteWrite(team.id)

    const view = await readExternalTeamState(team.id, deps)
    expect(view).toMatchObject({
      objective: '塔防',
      verdict: 'pass',
      verdictStale: true,
      deliveries: 1,
      external: true,
      ended: false,
      board: [{ id: 't1', title: '主角' }]
    })
    expect(view).not.toHaveProperty('usage')
    expect(await readExternalTeamState('ext-nope', deps)).toBeNull()
  })

  it('结束只是标记，结束过的再点不改时间；不存在的报 false', async () => {
    const team = await registry.create({ objective: '塔防' })
    clock = 5_000
    expect(await endExternalTeam(team.id, deps)).toBe(true)
    clock = 9_000
    await endExternalTeam(team.id, deps)
    expect((await registry.get(team.id))?.endedAt).toBe(5_000)
    expect((await readExternalTeamState(team.id, deps))?.ended).toBe(true)
    expect(await endExternalTeam('ext-nope', deps)).toBe(false)
    expect(await externalTeamExists(team.id, deps)).toBe(true)
    expect(await externalTeamExists('ext-nope', deps)).toBe(false)
  })
})

describe('混合团队在面板上', () => {
  it('队员在盒子里跑：给用量、谁在跑、标成托管；结束就停掉宿主', async () => {
    const { createHybridTeamHost, hybridTeamHost, runningHybridTeam } = await import(
      '../agent-v3/core/team/hybridTeam'
    )
    const team = await registry.create({ objective: '塔防', members: 'box' })
    const store = deps.storeFor(team.id)
    await store.putMember({
      name: '策划',
      persona: '写文档',
      tier: 'strong',
      readOnly: false,
      hiredAt: 1
    })
    const job = await store.startJob('策划', '写设计文档')
    await store.finishJob(job.id, {
      outcome: 'done',
      report: '写好了',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        cost: 0,
        unpriced: 0
      }
    })
    await hybridTeamHost(team.id, () =>
      createHybridTeamHost(team, {
        store,
        namespaces: [],
        jobScope: async () => {
          throw new Error('不派活')
        },
        runTool: (_record, fn) => fn(),
        runners: () => ({
          runMember: async () => ({ text: '', messageCount: 0 }),
          runAcceptance: async () => ''
        }),
        noteWrite: async () => undefined
      })
    )

    const view = await readExternalTeamState(team.id, deps)
    expect(view).toMatchObject({
      external: true,
      hostedMembers: true,
      usage: { total: { total: 15 } }
    })
    // 宿主以制作人的名义挂在「谁在跑」上，任务板据此画运行中
    expect(view?.live?.running).toContain('producer')

    expect(await endExternalTeam(team.id, deps)).toBe(true)
    expect(runningHybridTeam(team.id)).toBeUndefined()
    expect((await readExternalTeamState(team.id, deps))?.live).toBeUndefined()
  })
})
