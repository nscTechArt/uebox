/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from './cli.js'
import { decideGate, MAX_NUDGES, MAX_WAITS, type GateFacts } from './commands/team.js'
import { decideGuard, runGuardHook } from './commands/teamGuard.js'
import { startFakeBox, type FakeBox } from './testServer.js'

/**
 * 外部团队的交付闸（docs/外部大脑跑团队设计-2026-10-17.md 第 6 节）。
 *
 * Claude Code 的 Stop hook 跑 `uebox team gate --hook`：没过验收就把提醒交回去让它接着干，
 * 一轮最多两次；任何意外都放行 —— 一个坏掉的检查不该让用户的会话停不下来。
 */

const TOKEN = 'test-token-0123456789'
const boxes: FakeBox[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    teamId: 'ext-1',
    objective: '做一个塔防',
    verdict: null,
    verdictAt: null,
    lastWriteAt: null,
    deliveries: 0,
    passed: false,
    ended: false,
    ...overrides
  }
}

describe('拦不拦', () => {
  it('过了验收、验收员说要用户、团队已结束：放行', () => {
    expect(decideGate(facts({ verdict: 'pass', passed: true }), 0).block).toBe(false)
    expect(decideGate(facts({ verdict: 'blocked' }), 0).block).toBe(false)
    expect(decideGate(facts({ ended: true }), 0).block).toBe(false)
  })

  it('没验过、没过、PASS 之后又改过：拦，并说清是哪一种', () => {
    expect(decideGate(facts(), 0)).toMatchObject({
      block: true,
      reason: expect.stringContaining('has not been through acceptance')
    })
    expect(decideGate(facts({ verdict: 'fail' }), 0).reason).toContain('failed')
    expect(decideGate(facts({ verdict: 'pass', passed: false }), 0).reason).toContain(
      'changed after the last PASS'
    )
    expect(decideGate(facts(), 0).reason).toContain('This is not the user speaking')
  })

  it(`一轮拦满 ${MAX_NUDGES} 次就放行`, () => {
    expect(decideGate(facts(), MAX_NUDGES - 1).block).toBe(true)
    expect(decideGate(facts(), MAX_NUDGES).block).toBe(false)
  })
})

/** 盒子收到的 team_gate 调用（phase、latest_request） */
const gateCalls: Array<Record<string, unknown>> = []

async function box(gate: () => GateFacts, roundText = '新一轮已记下。'): Promise<FakeBox> {
  const started = await startFakeBox({
    token: TOKEN,
    tools: [
      {
        name: 'team_gate',
        meta: { namespace: 'core', risk: 'safe' },
        handle: (args) => {
          gateCalls.push(args)
          return {
            content: [{ type: 'text', text: args.phase === 'round' ? roundText : 'gate' }],
            structuredContent: { ...gate(), teamId: String(args.team_id) }
          }
        }
      },
      {
        name: 'team_list',
        meta: { namespace: 'core', risk: 'safe' },
        handle: () => ({
          content: [{ type: 'text', text: 'list' }],
          structuredContent: { teams: [gate()] }
        })
      }
    ]
  })
  boxes.push(started)
  return started
}

async function workdir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'uebox-team-'))
  dirs.push(dir)
  return dir
}

const env = (b: FakeBox): NodeJS.ProcessEnv => ({ UEBOX_URL: b.url, UEBOX_TOKEN: TOKEN })

function hook(
  sub: 'gate' | 'round',
  b: FakeBox,
  cwd: string,
  extra: Record<string, unknown> = {}
): ReturnType<typeof run> {
  return run(['team', sub, '--hook'], env(b), {
    readStdin: async () => JSON.stringify({ hook_event_name: 'Stop', cwd, ...extra })
  })
}

describe('uebox team', () => {
  it('team use 把目录绑到团队；hook 拦两次之后放行，新一轮清零', async () => {
    const b = await box(() => facts())
    const dir = await workdir()
    const used = await run(['team', 'use', 'ext-1', '--project', dir, '--json'], env(b))
    expect(used.exitCode).toBe(0)
    expect(JSON.parse(await fs.readFile(join(dir, '.uebox', 'team.json'), 'utf8'))).toEqual({
      teamId: 'ext-1',
      nudges: 0
    })

    // 子目录里跑也找得到
    const sub = join(dir, 'game')
    await fs.mkdir(sub)
    const first = await hook('gate', b, sub)
    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: 'block' })
    expect((await hook('gate', b, dir)).stdout).toContain('"block"')
    const third = await hook('gate', b, dir)
    expect(third).toMatchObject({ exitCode: 0, stdout: '' })

    expect((await hook('round', b, dir)).exitCode).toBe(0)
    expect((await hook('gate', b, dir)).stdout).toContain('"block"')
  }, 30_000)

  it('过了验收的团队：hook 不拦', async () => {
    const b = await box(() => facts({ verdict: 'pass', passed: true }))
    const dir = await workdir()
    await run(['team', 'use', 'ext-1', '--project', dir], env(b))
    expect(await hook('gate', b, dir)).toMatchObject({ exitCode: 0, stdout: '' })
  }, 30_000)

  it('没绑团队的目录：hook 什么都不做', async () => {
    const b = await box(() => facts())
    expect(await hook('gate', b, await workdir())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  }, 30_000)

  it('连不上盒子：hook 放行，只在 stderr 说一句', async () => {
    const b = await box(() => facts())
    const dir = await workdir()
    await run(['team', 'use', 'ext-1', '--project', dir], env(b))
    const result = await run(
      ['team', 'gate', '--hook'],
      { UEBOX_URL: b.url, UEBOX_TOKEN: 'wrong' },
      {
        readStdin: async () => JSON.stringify({ cwd: dir })
      }
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('放行')
  }, 30_000)

  it('status / list 出信封；没给团队也没绑定时报用法错误', async () => {
    const b = await box(() => facts({ verdict: 'fail' }))
    const status = await run(['team', 'status', 'ext-1', '--json'], env(b))
    expect(JSON.parse(status.stdout).data).toMatchObject({
      teamId: 'ext-1',
      verdict: 'fail',
      decision: { block: true }
    })
    const list = await run(['team', 'list', '--json'], env(b))
    expect(JSON.parse(list.stdout).data.count).toBe(1)

    const lost = await run(['team', 'gate', '--project', await workdir(), '--json'], env(b))
    expect(lost.exitCode).toBe(2)
    expect(JSON.parse(lost.stdout).error.hint).toContain('uebox team use')
  }, 30_000)

  it('--hook 只用于 team gate / round', async () => {
    const result = await run(['tools', 'list', '--hook', '--json'], {})
    expect(result.exitCode).toBe(2)
  })
})

describe('混合团队的交付闸', () => {
  it('还有活在跑、有话没看：拦下让它 team_wait，不用提醒额度；到上限放行', () => {
    const busy = facts({ pendingJobs: 2, unreadForProducer: 1, verdict: 'pass', passed: true })
    const decision = decideGate(busy, MAX_NUDGES, 0)
    expect(decision).toMatchObject({ block: true, kind: 'wait' })
    expect(decision.reason).toContain('team_wait')
    expect(decision.reason).toContain('2 teammate job(s)')
    expect(decideGate(busy, 0, MAX_WAITS).block).toBe(false)
    expect(decideGate(facts({ pendingJobs: 0, unreadForProducer: 0 }), 0).kind).toBe('nudge')
  })

  it('hook：为在跑的活拦不占提醒次数；放行时告诉盒子收工；新一轮把用户那句话和旧账带回来', async () => {
    gateCalls.length = 0
    let pending = 1
    const b = await box(
      () => facts({ pendingJobs: pending, verdict: 'pass', passed: true }),
      '<team_board_carryover>\n- t1 做主角\n</team_board_carryover>'
    )
    const dir = await workdir()
    await run(['team', 'use', 'ext-1', '--project', dir], env(b))
    expect((await hook('gate', b, dir)).stdout).toContain('team_wait')
    expect(JSON.parse(await fs.readFile(join(dir, '.uebox', 'team.json'), 'utf8'))).toMatchObject({
      nudges: 0,
      waits: 1
    })
    pending = 0
    expect((await hook('gate', b, dir)).stdout).toBe('')
    expect(gateCalls.at(-1)).toMatchObject({ team_id: 'ext-1', phase: 'stop' })

    const round = await hook('round', b, dir, { prompt: 'Boss 要会飞' })
    expect(round.stdout).toContain('<team_board_carryover>')
    expect(gateCalls.at(-1)).toMatchObject({ phase: 'round', latest_request: 'Boss 要会飞' })
    expect(JSON.parse(await fs.readFile(join(dir, '.uebox', 'team.json'), 'utf8'))).toEqual({
      teamId: 'ext-1',
      nudges: 0
    })
  }, 30_000)
})

describe('混合团队制作人的守卫', () => {
  it('不许改文件；Bash 只许单条 uebox；子 Agent 只许验收员；只许制作人和验收员那两条盒子连接', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(decideGuard(tool, { file_path: 'a.txt' }).deny).toBe(true)
    }
    expect(decideGuard('Bash', { command: 'uebox team use ext-1' }).deny).toBe(false)
    expect(decideGuard('Bash', { command: 'uebox team use ext-1 && rm -rf x' }).deny).toBe(true)
    expect(decideGuard('Bash', { command: 'echo hi > a.txt' }).deny).toBe(true)
    expect(decideGuard('Task', { subagent_type: 'uebox-acceptor' }).deny).toBe(false)
    expect(decideGuard('Agent', { subagent_type: 'uebox-hybrid:uebox-acceptor' }).deny).toBe(false)
    expect(decideGuard('Task', { subagent_type: 'general-purpose' }).deny).toBe(true)
    expect(decideGuard('mcp__plugin_uebox-hybrid_uebox-producer__team_wait', {}).deny).toBe(false)
    expect(decideGuard('mcp__uebox-acceptor__ue_playtest', {}).deny).toBe(false)
    expect(decideGuard('mcp__unreal-box__write_local_file', {}).deny).toBe(true)
    expect(decideGuard('mcp__plugin_uebox_unreal-box__ue_set_property', {}).deny).toBe(true)
    expect(decideGuard('mcp__github__create_issue', {}).deny).toBe(false)
    expect(decideGuard('Read', { file_path: 'a.txt' }).deny).toBe(false)
  })

  it('hook：拒绝时按 PreToolUse 的约定回 deny，放行和读不懂时什么都不说', async () => {
    const denied = JSON.parse(runGuardHook(JSON.stringify({ tool_name: 'Write', tool_input: {} })))
    expect(denied.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny'
    })
    expect(runGuardHook(JSON.stringify({ tool_name: 'Read', tool_input: {} }))).toBe('')
    expect(runGuardHook('not json')).toBe('')
    const viaCli = await run(
      ['team', 'guard', '--hook'],
      {},
      {
        readStdin: async () => JSON.stringify({ tool_name: 'Edit', tool_input: {} })
      }
    )
    expect(viaCli.exitCode).toBe(0)
    expect(viaCli.stdout).toContain('"deny"')
  })
})
