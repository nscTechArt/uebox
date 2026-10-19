/** @vitest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ACCEPTOR, PRODUCER, type TeamMember } from '../../../../shared/agentTeam'
import type { SubAgentResult } from '../../tools/builtin/task'
import { dismissMember, formatUserDismissals, type DismissInput } from './dismissal'
import { createTeamStore, memberFileBase, type TeamStore } from './teamStore'
import { createTeamTools, type TeamToolDeps } from './teamTools'

/**
 * 辞退：合规（谁能辞、什么时候能辞、任务交给谁）、有理有据（理由、证据只认它自己的）、
 * 留痕（档案不截断、记忆归档不删、用户辞的告诉制作人一次）。
 */

const member = (name: string): TeamMember => ({
  name,
  persona: `${name} 的人设`,
  tier: 'strong',
  readOnly: false,
  hiredAt: 1
})

let dir: string
let store: TeamStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'team-dismiss-'))
  let clock = 1000
  store = createTeamStore(
    { stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') },
    () => clock++
  )
  await store.ensure()
  await store.putMember(member('美术'))
  await store.putMember(member('程序'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const base = (over: Partial<DismissInput> = {}): DismissInput => ({
  name: '美术',
  by: 'producer',
  grounds: 'redundant',
  reason: '美术活已经做完，不再需要这个岗位',
  isBusy: () => false,
  now: () => 5000,
  ...over
})

describe('辞退的规矩', () => {
  it('制作人、验收员不是队员，不能辞', async () => {
    for (const name of [PRODUCER, ACCEPTOR]) {
      await expect(dismissMember(store, base({ name }))).rejects.toMatchObject({
        code: 'reserved'
      })
    }
  })

  it('名册上没有：说清现有谁', async () => {
    await expect(dismissMember(store, base({ name: '策划' }))).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringMatching(/现有：美术、程序/)
    })
  })

  it('手上有活不能辞，名册不动', async () => {
    await expect(dismissMember(store, base({ isBusy: () => true }))).rejects.toMatchObject({
      code: 'busy'
    })
    expect((await store.roster()).map((m) => m.name)).toEqual(['美术', '程序'])
  })

  it('理由必填', async () => {
    await expect(dismissMember(store, base({ reason: '  ' }))).rejects.toMatchObject({
      code: 'no-reason'
    })
  })

  it('说它干得不行要有证据；证据只认它自己名下的', async () => {
    await expect(
      dismissMember(store, base({ grounds: 'quality', reason: '贴图不对' }))
    ).rejects.toMatchObject({ code: 'no-evidence' })

    const theirs = await store.startJob('程序', '写移动逻辑')
    await store.finishJob(theirs.id, { outcome: 'done', report: 'ok' })
    await expect(
      dismissMember(store, base({ grounds: 'quality', reason: '贴图不对', evidence: [theirs.id] }))
    ).rejects.toMatchObject({ code: 'bad-evidence' })
    await expect(
      dismissMember(store, base({ grounds: 'quality', reason: '贴图不对', evidence: ['j999'] }))
    ).rejects.toMatchObject({ code: 'bad-evidence' })
    expect(await store.dismissals()).toEqual([])
  })

  it('接手人得是另一个在册的队员', async () => {
    for (const handoverTo of ['美术', '策划']) {
      await expect(dismissMember(store, base({ handoverTo }))).rejects.toMatchObject({
        code: 'bad-handover'
      })
    }
  })
})

describe('辞退留痕', () => {
  it('移出名册、记忆归档、任务交接，档案里有理由、证据原文和账上的事实', async () => {
    const done = await store.startJob('美术', '画主角贴图')
    await store.finishJob(done.id, { outcome: 'done', report: '画好了' })
    const stopped = await store.startJob('美术', '画敌人贴图')
    await store.finishJob(stopped.id, { outcome: 'stopped', reason: '超时' })
    await store.patchBoard([
      { id: 't1', title: '主角贴图', owner: '美术', status: 'done' },
      { id: 't2', title: '敌人贴图', owner: '美术', status: 'doing' },
      { id: 't3', title: '移动', owner: '程序', status: 'todo' }
    ])
    await store.saveHistory('美术', [])
    await store.saveMemberCheckpoint('美术', { summary: '旧摘要' })

    const record = await dismissMember(
      store,
      base({
        grounds: 'unfinished',
        reason: '敌人贴图两次没交',
        evidence: [stopped.id, 't2'],
        handoverTo: '程序'
      })
    )

    expect((await store.roster()).map((m) => m.name)).toEqual(['程序'])
    expect(record).toMatchObject({
      name: '美术',
      by: 'producer',
      grounds: 'unfinished',
      reason: '敌人贴图两次没交',
      at: 5000,
      member: { persona: '美术 的人设' },
      facts: { jobsDone: 1, jobsStopped: 1, tasks: { done: 1, doing: 1, todo: 0, blocked: 0 } },
      handover: { tasks: ['t2'], to: '程序' },
      evidence: [
        { kind: 'job', id: stopped.id, text: expect.stringMatching(/画敌人贴图.*停下：超时/) },
        { kind: 'task', id: 't2', text: expect.stringMatching(/敌人贴图（doing/) }
      ]
    })
    expect(await store.dismissals()).toEqual([record])

    // 记忆不删，挪到归档目录；同名再招从空白开始
    const stateDir = join(dir, 'state')
    expect(existsSync(join(stateDir, 'members', `${memberFileBase('美术')}.json`))).toBe(false)
    expect(existsSync(join(stateDir, record.memoryArchive!))).toBe(true)
    // 压缩检查点是那份记忆的缓存，记忆归档了它就删掉，不留给同名新人
    expect(existsSync(join(stateDir, 'members', `${memberFileBase('美术')}.compaction.json`))).toBe(
      false
    )

    const board = await store.board()
    expect(board.find((t) => t.id === 't2')).toMatchObject({
      owner: '程序',
      note: expect.stringMatching(/原负责人 美术 已辞退，转给 程序/)
    })
    // 做完的那项不动：它是谁做的是事实
    expect(board.find((t) => t.id === 't1')?.owner).toBe('美术')
  })

  it('没给接手人：清掉负责人，等制作人重新分配；从没派过活的没有记忆归档', async () => {
    await store.patchBoard([{ id: 't2', title: '敌人贴图', owner: '美术', status: 'blocked' }])
    const record = await dismissMember(store, base())
    expect(record.memoryArchive).toBeUndefined()
    expect(record.handover).toEqual({ tasks: ['t2'] })
    const task = (await store.board()).find((t) => t.id === 't2')!
    expect(task.owner).toBeUndefined()
    expect(task.note).toMatch(/待重新分配/)
  })

  it('档案不截断：辞再多也都在', async () => {
    for (let i = 0; i < 120; i++) {
      await store.putMember(member(`临时${i}`))
      await dismissMember(store, base({ name: `临时${i}` }))
    }
    expect(await store.dismissals()).toHaveLength(120)
  })

  it('用户辞的只告诉制作人一次；制作人自己辞的不用告诉它', async () => {
    await dismissMember(store, base({ name: '程序', by: 'user', grounds: 'user', reason: '太慢' }))
    await dismissMember(store, base())
    const first = await store.takeUnnotifiedDismissals()
    expect(first.map((d) => d.name)).toEqual(['程序'])
    expect(formatUserDismissals(first)).toMatch(/程序: 太慢/)
    expect(await store.takeUnnotifiedDismissals()).toEqual([])
    expect(formatUserDismissals([])).toBe('')
  })
})

describe('team_dismiss 工具', () => {
  const ok = (text: string): SubAgentResult => ({ text, messageCount: 1 })

  function tools(
    over: Partial<TeamToolDeps> = {}
  ): ReturnType<typeof createTeamTools> & Record<string, never> {
    return createTeamTools({
      store,
      objective: '做一个塔防游戏',
      namespaces: ['ue.actor'],
      runMember: async () => ok('done'),
      runAcceptance: async () => 'VERDICT: PASS',
      ...over
    }) as never
  }
  const call = async (
    list: ReturnType<typeof createTeamTools>,
    name: string,
    args: unknown
  ): Promise<string> => {
    const tool = list.find((t) => t.name === name)!
    const result = await tool.execute('call-1', args as never)
    return result.content.map((c) => ('text' in c ? c.text : '')).join('')
  }

  it('制作人不能冒用「用户辞的」这条依据', () => {
    const tool = tools().find((t) => t.name === 'team_dismiss')!
    const schema = JSON.stringify(tool.parameters)
    expect(schema).toContain('redundant')
    expect(schema).not.toContain('"user"')
  })

  it('正在干活的不能辞；交回之后能辞，回执写明交接和留档', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const list = tools({
      runMember: async () => {
        await gate
        return ok('画好了')
      }
    })
    const working = call(list, 'team_send', { to: '美术', message: '画主角' })
    await vi.waitFor(async () => expect((await store.jobs()).length).toBe(1))
    await expect(
      call(list, 'team_dismiss', { name: '美术', grounds: 'redundant', reason: '不需要了' })
    ).rejects.toThrow(/手上有活/)
    release()
    await working

    const text = await call(list, 'team_dismiss', {
      name: '美术',
      grounds: 'redundant',
      reason: '不需要了'
    })
    expect(text).toMatch(/已辞退 美术/)
    expect(text).toMatch(/交回 1 件、停下 0 件/)
    expect(text).toMatch(/团队现在 1 人：程序/)
  })

  it('派给辞掉的人：说清它被谁、为什么辞了', async () => {
    const list = tools()
    await dismissMember(store, base({ by: 'user', grounds: 'user', reason: '风格不对' }))
    await expect(call(list, 'team_send', { to: '美术', message: 'x' })).rejects.toThrow(
      /已被用户辞退（风格不对）/
    )
  })

  it('同名再招：提醒是新人；用户辞的提醒别直接招回', async () => {
    await dismissMember(store, base({ by: 'user', grounds: 'user', reason: '风格不对' }))
    const text = await call(tools(), 'team_hire', { name: '美术', role: '画贴图' })
    expect(text).toMatch(/已招入 美术/)
    expect(text).toMatch(/用户辞退过同名队员，理由：风格不对/)
    expect(text).toMatch(/换个名字/)
    // 新人的记忆是空的
    expect(await store.history('美术')).toEqual([])
  })

  it('排着队时被辞了：那件活不开工', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started: string[] = []
    const list = tools({
      runMember: async ({ message }) => {
        started.push(message)
        if (message === '第一件') await gate
        return ok('ok')
      }
    })
    const first = call(list, 'team_send', { to: '美术', message: '第一件' })
    await vi.waitFor(() => expect(started).toEqual(['第一件']))
    // 先接住：它要等第一件交回才会失败，中间不接会被当成没人管的拒绝
    const second = call(list, 'team_send', { to: '美术', message: '第二件' }).catch(
      (error: unknown) => error
    )
    // 绕过忙碌检查，模拟用户在任务板上辞掉（界面那头只看正在跑的那件）
    await store.recordDismissal({
      name: '美术',
      at: 1,
      by: 'user',
      grounds: 'user',
      reason: '换人',
      evidence: [],
      facts: { jobsDone: 0, jobsStopped: 0, tasks: { todo: 0, doing: 0, done: 0, blocked: 0 } },
      member: member('美术'),
      handover: { tasks: [] }
    })
    release()
    await first
    expect(String(await second)).toMatch(/排队期间被辞退了/)
    expect(started).toEqual(['第一件'])
  })
})

describe('老数据', () => {
  it('没有档案文件的老团队读出来是空的', async () => {
    const stateDir = join(dir, 'old')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'roster.json'), JSON.stringify([member('美术')]))
    const old = createTeamStore({ stateDir, workspaceDir: join(dir, 'ws2') })
    expect(await old.dismissals()).toEqual([])
    expect(await old.takeUnnotifiedDismissals()).toEqual([])
    expect(JSON.parse(readFileSync(join(stateDir, 'roster.json'), 'utf8'))).toHaveLength(1)
  })
})
